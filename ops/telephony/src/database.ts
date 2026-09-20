/**
 * PJSIP Realtime provisioning store.
 *
 * Asterisk reads its endpoint/auth/AOR/registration configuration straight
 * from these tables (res_config_pgsql + sorcery realtime). This service is the
 * ONLY writer. Everything written here is validated first (see
 * registrations.ts) so no untrusted string can become Asterisk configuration.
 *
 * The connection uses the least-privilege `webyar_asterisk`-style login that is
 * scoped to the restricted `asterisk` schema — never the application role.
 */

import pg from 'pg';

export interface RealtimeObjects {
  objectId: string;
  installationId: string;
  workspaceId: string;
  provider: string;
  sipUsername: string;
  sipPassword: string;
  sipExtension: string;
  domain: string;
  transport: 'udp' | 'tcp' | 'tls';
  contactUser: string;
}

export interface EndpointOwner {
  installationId: string;
  workspaceId: string;
  provider: string;
}

export interface RealtimeStore {
  ping(): Promise<void>;
  upsertRegistration(obj: RealtimeObjects): Promise<void>;
  deleteRegistration(objectId: string): Promise<boolean>;
  findEndpointOwner(endpointId: string): Promise<EndpointOwner | null>;
  close(): Promise<void>;
}

const TRANSPORT_OBJECT: Record<string, string> = {
  udp: 'transport-udp',
  tcp: 'transport-tcp',
  tls: 'transport-tls',
};

export function transportObject(transport: string): string {
  return TRANSPORT_OBJECT[transport] ?? TRANSPORT_OBJECT.udp;
}

export function createRealtimeStore(databaseUrl: string, schema = 'asterisk'): RealtimeStore {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 8_000,
  });
  // The login role is schema-scoped; setting search_path keeps every statement
  // (and Asterisk's own realtime queries) inside the restricted schema.
  pool.on('connect', (client) => {
    void client.query(`SET search_path TO ${schema}`);
  });

  return {
    async ping() {
      await pool.query('SELECT 1');
    },

    /**
     * Idempotent, tenant-scoped upsert. Re-sending identical input produces
     * identical rows; only this installation's objects are touched.
     */
    async upsertRegistration(obj: RealtimeObjects) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const authId = `${obj.objectId}-auth`;
        const aorId = obj.objectId;
        const transport = transportObject(obj.transport);

        await client.query(
          `INSERT INTO ps_auths (id, auth_type, username, password, realm)
             VALUES ($1, 'userpass', $2, $3, $4)
           ON CONFLICT (id) DO UPDATE
             SET username = EXCLUDED.username,
                 password = EXCLUDED.password,
                 realm = EXCLUDED.realm`,
          [authId, obj.sipUsername, obj.sipPassword, hostOnly(obj.domain)],
        );

        await client.query(
          `INSERT INTO ps_aors (id, contact, max_contacts, qualify_frequency, remove_existing)
             VALUES ($1, $2, 1, 60, 'yes')
           ON CONFLICT (id) DO UPDATE
             SET contact = EXCLUDED.contact`,
          [aorId, `sip:${obj.sipUsername}@${obj.domain}`],
        );

        await client.query(
          `INSERT INTO ps_endpoints
             (id, transport, aors, auth, outbound_auth, context, disallow, allow,
              direct_media, from_domain, from_user, rtp_symmetric, force_rport,
              rewrite_contact, ice_support, webyar_workspace_id, webyar_installation_id)
           VALUES ($1, $2, $3, $4, $4, 'webyar-inbound', 'all', 'alaw,ulaw,opus',
                   'no', $5, $6, 'yes', 'yes', 'yes', 'no', $7, $8)
           ON CONFLICT (id) DO UPDATE
             SET transport = EXCLUDED.transport,
                 aors = EXCLUDED.aors,
                 auth = EXCLUDED.auth,
                 outbound_auth = EXCLUDED.outbound_auth,
                 from_domain = EXCLUDED.from_domain,
                 from_user = EXCLUDED.from_user,
                 webyar_workspace_id = EXCLUDED.webyar_workspace_id,
                 webyar_installation_id = EXCLUDED.webyar_installation_id`,
          [obj.objectId, transport, aorId, authId, hostOnly(obj.domain), obj.sipUsername,
            obj.workspaceId, obj.installationId],
        );

        await client.query(
          `INSERT INTO ps_registrations
             (id, transport, outbound_auth, server_uri, client_uri, contact_user,
              retry_interval, forbidden_retry_interval, expiration, line, endpoint,
              webyar_workspace_id, webyar_installation_id)
           VALUES ($1, $2, $3, $4, $5, $6, 60, 600, 300, 'yes', $7, $8, $9)
           ON CONFLICT (id) DO UPDATE
             SET transport = EXCLUDED.transport,
                 outbound_auth = EXCLUDED.outbound_auth,
                 server_uri = EXCLUDED.server_uri,
                 client_uri = EXCLUDED.client_uri,
                 contact_user = EXCLUDED.contact_user,
                 endpoint = EXCLUDED.endpoint,
                 webyar_workspace_id = EXCLUDED.webyar_workspace_id,
                 webyar_installation_id = EXCLUDED.webyar_installation_id`,
          [obj.objectId, transport, `${obj.objectId}-auth`,
            `sip:${obj.domain}`, `sip:${obj.sipUsername}@${obj.domain}`, obj.contactUser,
            obj.objectId, obj.workspaceId, obj.installationId],
        );

        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    },

    async deleteRegistration(objectId: string) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const reg = await client.query('DELETE FROM ps_registrations WHERE id = $1', [objectId]);
        await client.query('DELETE FROM ps_endpoints WHERE id = $1', [objectId]);
        await client.query('DELETE FROM ps_aors WHERE id = $1', [objectId]);
        await client.query('DELETE FROM ps_auths WHERE id = $1', [`${objectId}-auth`]);
        await client.query('COMMIT');
        return (reg.rowCount ?? 0) > 0;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    },

    /**
     * Trusted tenant resolution: the installation/workspace of an inbound call
     * comes from the realtime row of the endpoint that received the INVITE,
     * never from a SIP header.
     */
    async findEndpointOwner(endpointId: string) {
      const { rows } = await pool.query(
        `SELECT webyar_installation_id, webyar_workspace_id FROM ps_endpoints WHERE id = $1`,
        [endpointId],
      );
      const row = rows[0];
      if (!row?.webyar_installation_id) return null;
      return {
        installationId: String(row.webyar_installation_id),
        workspaceId: String(row.webyar_workspace_id ?? ''),
        provider: 'daftareshoma',
      };
    },

    async close() {
      await pool.end();
    },
  };
}

export function hostOnly(domain: string): string {
  return domain.split(':')[0];
}
