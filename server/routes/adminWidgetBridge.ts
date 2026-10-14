import { createHash } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { requirePlatformAdmin } from '../lib/workspaceAuth.js';
import { directPool } from '../db/index.js';
import { BridgeError, bridgeConfig, bridgePool } from '../services/widgetBridge/config.js';
import { bridgeSettingsSchema, bridgeContactSchema, bridgeMessageSchema, bridgeBatchSchema } from '../services/widgetBridge/validation.js';
import { checkOutboundUrl } from '../../shared/net/hostGuard.js';

export const adminWidgetBridgeRouter = Router();
type Scope = { appId: string; ownerId: string; workspaceId: string };
const uuid = z.string().uuid();
const columns = 'id,name,url,provider,selectors,enabled,deleting,status,last_error,last_seen_at';
const params = (res: Response) => {
  const scope = res.locals.bridgeScope as Scope;
  return [scope.appId, scope.ownerId, scope.workspaceId];
};
const scoped = 'app_id=$1 AND owner_id=$2 AND workspace_id=$3';
const handle = (fn: (req: Request, res: Response) => Promise<unknown>) => async (req: Request, res: Response) => {
  try { await fn(req, res); }
  catch (err) {
    // Bridge outages are confined to these endpoints; no raw connection URLs,
    // SQL, cookie state or site response text are returned or logged.
    res.status(err instanceof BridgeError ? err.status : 503).json({
      error: err instanceof BridgeError ? err.code : 'bridge_unavailable',
    });
  }
};

adminWidgetBridgeRouter.use(async (req, res, next) => {
  try {
    const ownerId = await requirePlatformAdmin(req, res);
    if (!ownerId) return;
    const { appId } = bridgeConfig();
    const id = uuid.safeParse(req.query.workspaceId);
    if (!id.success) { res.status(400).json({ error: 'invalid_workspace' }); return; }
    // Only the signed-in Super Admin's OWN workspace. Being platform admin
    // never turns a customer's workspace into a bridge-enabled workspace.
    const { rows } = await directPool().query('SELECT id FROM workspaces WHERE id=$1 AND owner_id=$2', [id.data, ownerId]);
    if (!rows.length) { res.status(403).json({ error: 'bridge_workspace_forbidden' }); return; }
    res.locals.bridgeScope = { appId, ownerId, workspaceId: id.data } satisfies Scope;
    next();
  } catch (err) {
    res.status(err instanceof BridgeError ? err.status : 503).json({ error: err instanceof BridgeError ? err.code : 'bridge_unavailable' });
  }
});

adminWidgetBridgeRouter.get('/settings', handle(async (_req, res) => {
  const { rows } = await bridgePool().query(`SELECT enabled,identity,allowed_providers AS "allowedProviders",round_size AS "roundSize",interval_seconds AS "intervalSeconds" FROM widget_bridge_settings WHERE ${scoped}`, params(res));
  res.json({ settings: rows[0] || { enabled: false, identity: { name: '', email: '', phone: '' }, allowedProviders: ['webyar','crisp','raychat','goftino','custom'], roundSize: 1, intervalSeconds: 30 } });
}));

adminWidgetBridgeRouter.put('/settings', handle(async (req, res) => {
  const parsed = bridgeSettingsSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'invalid_settings' }); return; }
  const { enabled, identity, allowedProviders, roundSize, intervalSeconds } = parsed.data;
  // Setting changes fence existing sessions and cancel unsent messages.
  // Dispatching messages are deliberately uncertain: never retry blindly.
  await bridgePool().query(`WITH saved AS (
    INSERT INTO widget_bridge_settings(app_id,owner_id,workspace_id,enabled,identity,allowed_providers,round_size,interval_seconds)
    VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8) ON CONFLICT(app_id,owner_id,workspace_id)
    DO UPDATE SET enabled=EXCLUDED.enabled,deleting=false,identity=EXCLUDED.identity,allowed_providers=EXCLUDED.allowed_providers,round_size=EXCLUDED.round_size,interval_seconds=EXCLUDED.interval_seconds,updated_at=now() RETURNING *
  ), batches_stopped AS (
    UPDATE widget_bridge_batches SET status='cancelled' WHERE ${scoped} AND status IN ('running','paused') RETURNING id
  ), fenced AS (
    UPDATE widget_bridge_contacts SET generation=generation+1,next_poll_at=now(),status='idle'
    WHERE ${scoped} AND EXISTS(SELECT 1 FROM saved) RETURNING id
  ) UPDATE widget_bridge_messages SET delivery=CASE WHEN delivery='dispatching' THEN 'uncertain' ELSE 'cancelled' END,
    error='settings_changed' WHERE contact_id IN (SELECT id FROM fenced)
    AND delivery IN ('queued','preparing','dispatching')`, [...params(res), enabled, JSON.stringify(identity), JSON.stringify(allowedProviders),roundSize,intervalSeconds]);
  res.json({ settings: { enabled, identity, allowedProviders, roundSize, intervalSeconds } });
}));

adminWidgetBridgeRouter.delete('/settings', handle(async (_req, res) => {
  await bridgePool().query(`WITH stopped AS (
    UPDATE widget_bridge_settings SET enabled=false,deleting=true,identity='{}',updated_at=now()
    WHERE ${scoped} RETURNING *
  ) UPDATE widget_bridge_contacts SET enabled=false,deleting=true,generation=generation+1,
    session_envelope=NULL,status='deleting' WHERE ${scoped} AND EXISTS(SELECT 1 FROM stopped)`, params(res));
  await bridgePool().query(`DELETE FROM widget_bridge_contacts WHERE ${scoped} AND deleting
    AND (lease_until IS NULL OR lease_until<now())`, params(res));
  await bridgePool().query(`DELETE FROM widget_bridge_settings s WHERE ${scoped} AND deleting
    AND NOT EXISTS(SELECT 1 FROM widget_bridge_contacts c WHERE c.app_id=s.app_id AND c.owner_id=s.owner_id AND c.workspace_id=s.workspace_id)`, params(res));
  res.status(202).json({ deleting: true });
}));

adminWidgetBridgeRouter.get('/contacts', handle(async (req, res) => {
  const before = req.query.before === undefined ? null : uuid.safeParse(req.query.before);
  if (before && !before.success) { res.status(400).json({ error: 'invalid_cursor' }); return; }
  // Finish expired deletions even when the dedicated worker is stopped.
  await bridgePool().query(`DELETE FROM widget_bridge_contacts WHERE ${scoped} AND deleting
    AND (lease_until IS NULL OR lease_until<now())`, params(res));
  await bridgePool().query(`DELETE FROM widget_bridge_settings s WHERE ${scoped} AND deleting
    AND NOT EXISTS(SELECT 1 FROM widget_bridge_contacts c WHERE c.app_id=s.app_id AND c.owner_id=s.owner_id AND c.workspace_id=s.workspace_id)`, params(res));
  const { rows } = await bridgePool().query(`SELECT ${columns} FROM widget_bridge_contacts
    WHERE ${scoped} AND ($4::uuid IS NULL OR (created_at,id)<
      (SELECT created_at,id FROM widget_bridge_contacts WHERE ${scoped} AND id=$4))
    ORDER BY created_at DESC,id DESC LIMIT 100`, [...params(res),before && before.success ? before.data : null]);
  res.json({ contacts: rows, hasMore: rows.length===100 });
}));

adminWidgetBridgeRouter.post('/contacts', handle(async (req, res) => {
  const parsed = bridgeContactSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'invalid_contact' }); return; }
  const value = parsed.data;
  if (!(await checkOutboundUrl(value.url)).ok) { res.status(400).json({ error: 'public_https_required' }); return; }
  const url = new URL(value.url); url.hash = '';
  const name = value.name || url.hostname;
  const { rows } = await bridgePool().query(`INSERT INTO widget_bridge_contacts
    (app_id,owner_id,workspace_id,name,url,provider,selectors,enabled)
    SELECT $1,$2,$3,$4,$5,$6,$7::jsonb,$8 FROM widget_bridge_settings
    WHERE ${scoped} AND NOT deleting
    ON CONFLICT(app_id,owner_id,workspace_id,url) DO NOTHING RETURNING ${columns}`,
    [...params(res), name, url.toString(), value.provider, JSON.stringify(value.selectors), value.enabled]);
  if (!rows.length) { res.status(409).json({ error: 'save_settings_or_duplicate_site' }); return; }
  res.status(201).json({ contact: rows[0] });
}));

adminWidgetBridgeRouter.patch('/contacts/:id', handle(async (req, res) => {
  const id = uuid.safeParse(req.params.id);
  const body = z.object({ enabled: z.boolean() }).strict().safeParse(req.body);
  if (!id.success || !body.success) { res.status(400).json({ error: 'invalid_contact' }); return; }
  const { rows } = await bridgePool().query(`WITH changed AS (
    UPDATE widget_bridge_contacts SET enabled=$5,generation=generation+1,next_poll_at=now(),status='idle',last_error=NULL
    WHERE ${scoped} AND id=$4 AND NOT deleting RETURNING ${columns}
  ), cancelled AS (
    UPDATE widget_bridge_messages SET delivery=CASE WHEN delivery='dispatching' THEN 'uncertain' ELSE 'cancelled' END,
    error='connection_changed' WHERE contact_id IN (SELECT id FROM changed)
    AND delivery IN ('queued','preparing','dispatching') RETURNING id
  ) SELECT * FROM changed`, [...params(res), id.data, body.data.enabled]);
  if (!rows.length) { res.status(404).json({ error: 'contact_not_found' }); return; }
  res.json({ contact: rows[0] });
}));

adminWidgetBridgeRouter.delete('/contacts/:id', handle(async (req, res) => {
  const id = uuid.safeParse(req.params.id);
  if (!id.success) { res.status(400).json({ error: 'invalid_contact' }); return; }
  // Defer hard deletion until the browser lease ends. A separate reaper can
  // finish this after a worker crash; no application data is touched.
  const { rows } = await bridgePool().query(`UPDATE widget_bridge_contacts SET enabled=false,deleting=true,
    generation=generation+1,status='deleting',session_envelope=NULL
    WHERE ${scoped} AND id=$4 RETURNING id`, [...params(res), id.data]);
  if (!rows.length) { res.status(404).json({ error: 'contact_not_found' }); return; }
  await bridgePool().query(`DELETE FROM widget_bridge_contacts WHERE ${scoped} AND id=$4
    AND deleting AND (lease_until IS NULL OR lease_until<now())`, [...params(res), id.data]);
  res.status(202).json({ deleting: true });
}));

adminWidgetBridgeRouter.get('/contacts/:id/messages', handle(async (req, res) => {
  const id = uuid.safeParse(req.params.id);
  const before = req.query.before === undefined ? null : uuid.safeParse(req.query.before);
  if (!id.success || (before && !before.success)) { res.status(400).json({ error: 'invalid_cursor' }); return; }
  const { rows } = await bridgePool().query(`SELECT m.id,m.contact_id,m.direction,m.body,m.delivery,m.dedupe_key,m.error,m.created_at
    FROM widget_bridge_messages m JOIN widget_bridge_contacts c ON c.id=m.contact_id
    WHERE c.app_id=$1 AND c.owner_id=$2 AND c.workspace_id=$3 AND c.id=$4
      AND ($5::uuid IS NULL OR (m.created_at,m.id)<
        (SELECT created_at,id FROM widget_bridge_messages WHERE id=$5 AND contact_id=$4))
    ORDER BY m.created_at DESC,m.id DESC LIMIT 100`, [...params(res), id.data, before && before.success ? before.data : null]);
  res.json({ messages: rows.reverse(), hasMore: rows.length === 100 });
}));

adminWidgetBridgeRouter.post('/contacts/:id/messages', handle(async (req, res) => {
  const id = uuid.safeParse(req.params.id);
  const parsed = bridgeMessageSchema.safeParse(req.body);
  if (!id.success || !parsed.success) { res.status(400).json({ error: 'invalid_message' }); return; }
  const { body, clientMessageId } = parsed.data;
  const { rows } = await bridgePool().query(`INSERT INTO widget_bridge_messages(contact_id,direction,body,delivery,dedupe_key)
    SELECT c.id,'outbound',$5,'queued',$6 FROM widget_bridge_contacts c
    JOIN widget_bridge_settings s USING(app_id,owner_id,workspace_id)
    WHERE c.app_id=$1 AND c.owner_id=$2 AND c.workspace_id=$3 AND c.id=$4
      AND c.enabled AND s.enabled AND NOT c.deleting
      AND (SELECT count(*) FROM widget_bridge_messages WHERE contact_id=c.id AND delivery='queued')<50
    ON CONFLICT(contact_id,direction,dedupe_key) DO UPDATE SET dedupe_key=EXCLUDED.dedupe_key
      WHERE widget_bridge_messages.body=EXCLUDED.body RETURNING id,delivery`,
    [...params(res), id.data, body, clientMessageId]);
  if (!rows.length) { res.status(409).json({ error: 'bridge_disabled_or_queue_full' }); return; }
  await bridgePool().query('UPDATE widget_bridge_contacts SET next_poll_at=now() WHERE id=$1', [id.data]);
  res.status(202).json({ message: rows[0] });
}));

adminWidgetBridgeRouter.get('/batches', handle(async (_req, res) => {
  const { rows } = await bridgePool().query(`SELECT b.id,b.body,b.status,b.created_at,b.round_size,b.interval_seconds,b.approved_through,b.review_version,b.next_send_at,jsonb_array_length(b.sites) AS total,
    count(m.id) FILTER (WHERE m.delivery IN ('queued','preparing','dispatching'))::int AS pending,
    count(m.id) FILTER (WHERE m.delivery='sent')::int AS sent,
    count(m.id) FILTER (WHERE m.delivery='failed')::int AS failed,
    count(m.id) FILTER (WHERE m.delivery='uncertain')::int AS uncertain,
    (jsonb_array_length(b.sites)-count(m.id) FILTER (WHERE m.delivery<>'cancelled'))::int AS skipped
    FROM widget_bridge_batches b LEFT JOIN widget_bridge_messages m ON m.batch_id=b.id
    WHERE b.app_id=$1 AND b.owner_id=$2 AND b.workspace_id=$3
    GROUP BY b.id ORDER BY b.created_at DESC LIMIT 20`, params(res));
  res.json({ batches: rows });
}));

adminWidgetBridgeRouter.get('/batches/:id', handle(async (req, res) => {
  const id = uuid.safeParse(req.params.id);
  if (!id.success) { res.status(400).json({ error: 'invalid_batch' }); return; }
  const { rows } = await bridgePool().query(`SELECT site.url,site.position::int,m.contact_id,
    COALESCE(m.delivery,'skipped') AS delivery,m.error
    FROM widget_bridge_batches b CROSS JOIN LATERAL jsonb_array_elements_text(b.sites) WITH ORDINALITY site(url,position)
    LEFT JOIN widget_bridge_messages m ON m.batch_id=b.id AND m.batch_position=site.position
    WHERE b.app_id=$1 AND b.owner_id=$2 AND b.workspace_id=$3 AND b.id=$4 ORDER BY site.position`, [...params(res),id.data]);
  res.json({ items: rows });
}));

adminWidgetBridgeRouter.post('/batches', handle(async (req, res) => {
  const parsed = bridgeBatchSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'invalid_batch' }); return; }
  const { body, clientBatchId } = parsed.data;
  const urls = [...new Set(parsed.data.urls.map(value => { const u = new URL(value); u.hash=''; return u.toString(); }))];
  const hash = createHash('sha256').update(JSON.stringify({ body, urls })).digest('hex');
  const existing = await bridgePool().query(`SELECT id,request_hash FROM widget_bridge_batches WHERE ${scoped} AND id=$4`, [...params(res),clientBatchId]);
  if (existing.rows.length) {
    if (existing.rows[0].request_hash !== hash) { res.status(409).json({ error: 'batch_conflict' }); return; }
    res.status(202).json({ batch: { id: clientBatchId } }); return;
  }
  // One atomic statement: an active-scope unique index prevents two campaigns
  // from being accepted concurrently. Retries cannot duplicate destinations.
  const { rows } = await bridgePool().query(`WITH batch AS (
    INSERT INTO widget_bridge_batches(id,app_id,owner_id,workspace_id,body,sites,request_hash,round_size,interval_seconds,approved_through)
    SELECT $4,$1,$2,$3,$5,$6::jsonb,$7,round_size,interval_seconds,round_size FROM widget_bridge_settings
    WHERE ${scoped} AND enabled AND NOT deleting AND jsonb_array_length(allowed_providers)>0
    ON CONFLICT DO NOTHING RETURNING *
  ), sites AS (
    SELECT site.url,site.position FROM batch CROSS JOIN LATERAL jsonb_array_elements_text(batch.sites) WITH ORDINALITY site(url,position)
  ), contacts AS (
    INSERT INTO widget_bridge_contacts(app_id,owner_id,workspace_id,name,url,provider,enabled)
    SELECT $1,$2,$3,substring(url from '^https://([^/:]+)'),url,'auto',true FROM sites
    ON CONFLICT(app_id,owner_id,workspace_id,url) DO UPDATE SET url=EXCLUDED.url,next_poll_at=now()
      WHERE widget_bridge_contacts.enabled AND NOT widget_bridge_contacts.deleting
    RETURNING id,url
  ), messages AS (
    INSERT INTO widget_bridge_messages(contact_id,direction,body,delivery,dedupe_key,batch_id,batch_position,created_at)
    SELECT c.id,'outbound',$5,'queued',$4::text||':'||s.position,b.id,s.position,
      statement_timestamp()+s.position*interval '1 microsecond'
    FROM contacts c JOIN sites s USING(url) CROSS JOIN batch b RETURNING id
  ) SELECT id FROM batch`, [...params(res),clientBatchId,body,JSON.stringify(urls),hash]);
  if (!rows.length) { res.status(409).json({ error: 'batch_conflict' }); return; }
  res.status(202).json({ batch: rows[0] });
}));

adminWidgetBridgeRouter.delete('/batches/:id', handle(async (req, res) => {
  const id = uuid.safeParse(req.params.id);
  if (!id.success) { res.status(400).json({ error: 'invalid_batch' }); return; }
  const { rows } = await bridgePool().query(`WITH stopped AS (
    UPDATE widget_bridge_batches SET status='cancelled' WHERE ${scoped} AND id=$4 AND status IN ('running','paused') RETURNING id
  ), fenced AS (
    UPDATE widget_bridge_contacts SET generation=generation+1,next_poll_at=now()
    WHERE id IN (SELECT contact_id FROM widget_bridge_messages WHERE batch_id IN (SELECT id FROM stopped)
      AND delivery IN ('queued','preparing','dispatching')) RETURNING id
  ), cancelled AS (
    UPDATE widget_bridge_messages SET delivery=CASE WHEN delivery='dispatching' THEN 'uncertain' ELSE 'cancelled' END,
      error='batch_cancelled' WHERE batch_id IN (SELECT id FROM stopped)
      AND delivery IN ('queued','preparing','dispatching') RETURNING id
  ) SELECT id FROM stopped`, [...params(res),id.data]);
  res.json({ stopped: rows.length>0 });
}));


adminWidgetBridgeRouter.post('/batches/:id/continue', handle(async (req, res) => {
  const id = uuid.safeParse(req.params.id);
  const body = z.object({ reviewVersion: z.number().int().nonnegative() }).strict().safeParse(req.body);
  if (!id.success || !body.success) { res.status(400).json({ error: 'invalid_batch' }); return; }
  // Versioned approvals cannot accidentally approve another round on retry.
  const { rows } = await bridgePool().query(`UPDATE widget_bridge_batches b SET status='running',
    approved_through=CASE WHEN EXISTS(SELECT 1 FROM widget_bridge_messages m WHERE m.batch_id=b.id
      AND m.batch_position<=b.approved_through AND m.delivery='queued') THEN b.approved_through
      ELSE LEAST(jsonb_array_length(b.sites),b.approved_through+b.round_size) END
    WHERE b.app_id=$1 AND b.owner_id=$2 AND b.workspace_id=$3 AND b.id=$4
      AND b.status='paused' AND b.review_version=$5
      AND EXISTS(SELECT 1 FROM widget_bridge_settings s WHERE s.app_id=b.app_id AND s.owner_id=b.owner_id
        AND s.workspace_id=b.workspace_id AND s.enabled AND NOT s.deleting)
    RETURNING id`, [...params(res),id.data,body.data.reviewVersion]);
  if (!rows.length) { res.status(409).json({ error: 'batch_conflict' }); return; }
  res.json({ batch: rows[0] });
}));
