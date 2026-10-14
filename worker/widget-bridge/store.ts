import type { Queryable } from '../../server/db/postgrest/types.js';
import type { BridgeContact, BridgeIdentity, BridgeMessage, BridgeAllowedProvider } from '../../shared/widgetBridge.js';
import type { SecretEnvelope } from '../../server/lib/pluginCrypto.js';
import type { RemoteMessage } from './adapters.js';

export interface LeasedContact extends BridgeContact {
  app_id: string;
  generation: number;
  session_envelope: SecretEnvelope | null;
  identity: BridgeIdentity;
  allowed_providers: BridgeAllowedProvider[];
}


// No later batch row becomes eligible until every earlier attempt is terminal.
const batchEligible = `(m.batch_id IS NULL OR (
  EXISTS(SELECT 1 FROM widget_bridge_batches b WHERE b.id=m.batch_id AND b.status='running')
  AND NOT EXISTS(SELECT 1 FROM widget_bridge_messages earlier WHERE earlier.batch_id=m.batch_id
    AND earlier.batch_position<m.batch_position AND earlier.delivery IN ('queued','preparing','dispatching'))
))`;
const readyBatch = `EXISTS(SELECT 1 FROM widget_bridge_messages m WHERE m.contact_id=c.id
  AND m.batch_id IS NOT NULL AND m.delivery IN ('queued','preparing','dispatching') AND ${batchEligible})`;
const noFutureBatch = `(NOT EXISTS(SELECT 1 FROM widget_bridge_messages m WHERE m.contact_id=c.id
  AND m.batch_id IS NOT NULL AND m.delivery IN ('queued','preparing','dispatching')) OR ${readyBatch})`;

export class BridgeStore {
  constructor(private readonly db: Queryable, readonly appId: string, readonly workerId: string) {}
  async claim(): Promise<LeasedContact | null> {
    const { rows } = await this.db.query<LeasedContact>(`WITH candidate AS (
      SELECT c.id FROM widget_bridge_contacts c JOIN widget_bridge_settings s USING(app_id,owner_id,workspace_id)
      WHERE c.app_id=$1 AND c.enabled AND s.enabled AND NOT c.deleting AND c.next_poll_at<=now()
        AND (c.lease_until IS NULL OR c.lease_until<now()) AND ${noFutureBatch}
      ORDER BY ${readyBatch} DESC,c.next_poll_at,c.created_at FOR UPDATE OF c SKIP LOCKED LIMIT 1
    ) UPDATE widget_bridge_contacts c SET lease_owner=$2,lease_until=now()+interval '45 seconds',
      status='connecting',last_error=NULL FROM candidate,widget_bridge_settings s
      WHERE c.id=candidate.id AND s.app_id=c.app_id AND s.owner_id=c.owner_id AND s.workspace_id=c.workspace_id
      RETURNING c.*,s.identity,s.allowed_providers`, [this.appId, this.workerId]);
    return rows[0] || null;
  }
  async hasWaiting() {
    const { rows } = await this.db.query<{ waiting: boolean }>(`SELECT EXISTS(
      SELECT 1 FROM widget_bridge_contacts c JOIN widget_bridge_settings s USING(app_id,owner_id,workspace_id)
      WHERE c.app_id=$1 AND c.enabled AND s.enabled AND NOT c.deleting AND c.next_poll_at<=now()
        AND (c.lease_until IS NULL OR c.lease_until<now()) AND ${noFutureBatch}
    ) AS waiting`, [this.appId]);
    return rows[0]?.waiting === true;
  }
  async alive(contact: LeasedContact) {
    const { rows } = await this.db.query(`UPDATE widget_bridge_contacts c
      SET lease_until=now()+interval '45 seconds',last_seen_at=now()
      FROM widget_bridge_settings s WHERE c.id=$1 AND c.app_id=$2 AND c.lease_owner=$3 AND c.generation=$4
        AND c.lease_until>now() AND c.enabled AND NOT c.deleting
        AND s.app_id=c.app_id AND s.owner_id=c.owner_id AND s.workspace_id=c.workspace_id AND s.enabled
      RETURNING c.id`, [contact.id, this.appId, this.workerId, contact.generation]);
    return rows.length > 0;
  }
  async recover(contact: LeasedContact) {
    await this.db.query(`UPDATE widget_bridge_messages SET
      delivery=CASE WHEN delivery='dispatching' THEN 'uncertain' ELSE 'queued' END,
      error=CASE WHEN delivery='dispatching' THEN 'worker_interrupted' ELSE NULL END
      WHERE contact_id=$1 AND delivery IN ('preparing','dispatching')
        AND EXISTS(SELECT 1 FROM widget_bridge_contacts WHERE id=$1 AND app_id=$2 AND lease_owner=$3 AND generation=$4 AND lease_until>now())`,
      [contact.id, this.appId, this.workerId, contact.generation]);
  }
  async next(contact: LeasedContact): Promise<BridgeMessage | null> {
    const { rows } = await this.db.query<BridgeMessage>(`WITH pending AS (
      SELECT m.id FROM widget_bridge_messages m JOIN widget_bridge_contacts c ON c.id=m.contact_id
      JOIN widget_bridge_settings s USING(app_id,owner_id,workspace_id)
      WHERE m.contact_id=$1 AND m.delivery='queued' AND c.app_id=$2 AND c.lease_owner=$3
        AND c.generation=$4 AND c.lease_until>now() AND c.enabled AND s.enabled AND NOT c.deleting
        AND ${batchEligible}
      ORDER BY m.created_at,m.id FOR UPDATE OF m SKIP LOCKED LIMIT 1
    ) UPDATE widget_bridge_messages m SET delivery='preparing' FROM pending WHERE m.id=pending.id RETURNING m.*`,
    [contact.id, this.appId, this.workerId, contact.generation]);
    return rows[0] || null;
  }
  async dispatch(contact: LeasedContact, message: BridgeMessage): Promise<boolean> {
    const { rows } = await this.db.query(`UPDATE widget_bridge_messages m SET delivery='dispatching'
      FROM widget_bridge_contacts c,widget_bridge_settings s WHERE m.id=$1 AND m.delivery='preparing'
      AND c.id=m.contact_id AND c.id=$2 AND c.app_id=$3 AND c.lease_owner=$4 AND c.generation=$5
      AND c.enabled AND NOT c.deleting AND c.lease_until>now()
      AND s.app_id=c.app_id AND s.owner_id=c.owner_id AND s.workspace_id=c.workspace_id AND s.enabled AND ${batchEligible} RETURNING m.id`,
      [message.id, contact.id, this.appId, this.workerId, contact.generation]);
    return rows.length > 0;
  }
  async finish(contact: LeasedContact, message: BridgeMessage, delivery: 'sent' | 'failed' | 'uncertain', error: string | null = null) {
    await this.db.query(`UPDATE widget_bridge_messages m SET delivery=$1,error=$2 FROM widget_bridge_contacts c
      WHERE m.id=$3 AND c.id=m.contact_id AND c.id=$4 AND c.app_id=$5 AND c.lease_owner=$6 AND c.generation=$7
      AND m.delivery IN ('preparing','dispatching')`, [delivery, error, message.id, contact.id, this.appId, this.workerId, contact.generation]);
  }
  async receive(contact: LeasedContact, messages: RemoteMessage[]) {
    if (!messages.length) return;
    const unique = [...new Map(messages.map(message => [message.key, message])).values()].slice(0, 200);
    await this.db.query(`INSERT INTO widget_bridge_messages(contact_id,direction,body,delivery,dedupe_key,created_at)
      SELECT c.id,'inbound',incoming.item->>'body','received',incoming.item->>'key',
        statement_timestamp()+incoming.ordinality*interval '1 microsecond'
      FROM jsonb_array_elements($1::jsonb) WITH ORDINALITY AS incoming(item,ordinality),
        widget_bridge_contacts c,widget_bridge_settings s
      WHERE c.id=$2 AND c.app_id=$3 AND c.lease_owner=$4 AND c.generation=$5 AND c.lease_until>now()
        AND c.enabled AND NOT c.deleting AND s.app_id=c.app_id AND s.owner_id=c.owner_id AND s.workspace_id=c.workspace_id AND s.enabled
        AND length(incoming.item->>'body') BETWEEN 1 AND 4000
      ORDER BY incoming.ordinality
      ON CONFLICT(contact_id,direction,dedupe_key) DO UPDATE SET body=EXCLUDED.body
      WHERE widget_bridge_messages.body<>EXCLUDED.body`,
    [JSON.stringify(unique), contact.id, this.appId, this.workerId, contact.generation]);
  }
  async saveSession(contact: LeasedContact, envelope: SecretEnvelope) {
    const { rows } = await this.db.query(`UPDATE widget_bridge_contacts SET session_envelope=$1::jsonb,status='connected'
      WHERE id=$2 AND app_id=$3 AND lease_owner=$4 AND generation=$5 AND enabled AND NOT deleting AND lease_until>now() RETURNING id`,
      [JSON.stringify(envelope), contact.id, this.appId, this.workerId, contact.generation]);
    if (!rows.length) throw new Error('connection_stopped');
  }
  async release(contact: LeasedContact, error: string | null) {
    const needsAttention = error !== null && ['unsupported_widget','widget_not_found','ambiguous_widget',
      'identity_required','composer_unavailable','provider_not_allowed'].includes(error);
    // Even if configuration changed, release OUR lease. Never erase a newer
    // worker's lease or revive a deleted/disabled session.
    await this.db.query(`WITH released AS (UPDATE widget_bridge_contacts SET lease_owner=NULL,lease_until=NULL,
      enabled=CASE WHEN generation=$4 AND $7 THEN false ELSE enabled END,
      next_poll_at=now()+CASE WHEN $6 IN ('unsupported_widget','identity_required','ambiguous_widget') THEN interval '5 minutes' ELSE interval '30 seconds' END,
      status=CASE WHEN generation=$4 THEN $5 ELSE status END,
      last_error=CASE WHEN generation=$4 THEN $6 ELSE last_error END
      WHERE id=$1 AND app_id=$2 AND lease_owner=$3 RETURNING id,generation
    ) UPDATE widget_bridge_messages SET delivery=CASE WHEN delivery='dispatching' THEN 'uncertain' ELSE 'failed' END,error=$6
      WHERE contact_id IN (SELECT id FROM released WHERE generation=$4) AND batch_id IS NOT NULL AND $6::text IS NOT NULL
      AND delivery IN ('queued','preparing','dispatching')`,
      [contact.id, this.appId, this.workerId, contact.generation, error ? 'error' : 'idle', error, needsAttention]);
  }
  async yieldForBatch(contact: LeasedContact) {
    const { rows } = await this.db.query<{ waiting: boolean }>(`SELECT EXISTS(
      SELECT 1 FROM widget_bridge_contacts c JOIN widget_bridge_settings s USING(app_id,owner_id,workspace_id)
      WHERE c.app_id=$1 AND c.id<>$2 AND c.enabled AND s.enabled AND NOT c.deleting
        AND (c.lease_until IS NULL OR c.lease_until<now()) AND ${readyBatch}
    ) AND NOT EXISTS(SELECT 1 FROM widget_bridge_messages m WHERE m.contact_id=$2
      AND m.delivery IN ('queued','preparing','dispatching') AND ${batchEligible}) AS waiting`, [this.appId,contact.id]);
    return rows[0]?.waiting === true;
  }
  async reap() {
    await this.db.query(`UPDATE widget_bridge_contacts SET status='idle' WHERE app_id=$1
      AND lease_until<now() AND status IN ('connecting','connected')`, [this.appId]);
    // Can finish deletions with no worker/browser still holding a lease.
    await this.db.query(`DELETE FROM widget_bridge_contacts WHERE app_id=$1 AND deleting
      AND (lease_until IS NULL OR lease_until<now())`, [this.appId]);
    await this.db.query(`DELETE FROM widget_bridge_settings s WHERE app_id=$1 AND deleting
      AND NOT EXISTS(SELECT 1 FROM widget_bridge_contacts c WHERE c.app_id=s.app_id AND c.owner_id=s.owner_id AND c.workspace_id=s.workspace_id)`, [this.appId]);
    await this.db.query(`UPDATE widget_bridge_messages m SET delivery=CASE WHEN m.delivery='dispatching' THEN 'uncertain' ELSE 'cancelled' END,
      error='connection_stopped' FROM widget_bridge_contacts c,widget_bridge_settings s
      WHERE c.id=m.contact_id AND c.app_id=$1 AND s.app_id=c.app_id AND s.owner_id=c.owner_id AND s.workspace_id=c.workspace_id
      AND (NOT c.enabled OR NOT s.enabled OR c.deleting) AND m.delivery IN ('queued','preparing','dispatching')`, [this.appId]);
    await this.db.query(`UPDATE widget_bridge_batches b SET status='completed' WHERE b.app_id=$1 AND b.status='running'
      AND NOT EXISTS(SELECT 1 FROM widget_bridge_messages m WHERE m.batch_id=b.id
        AND m.delivery IN ('queued','preparing','dispatching'))`, [this.appId]);
  }
}
