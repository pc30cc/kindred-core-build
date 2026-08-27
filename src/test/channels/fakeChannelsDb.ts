/**
 * Minimal in-memory stand-in for the service-role Supabase client used by the
 * channels services.
 *
 * It is deliberately behavioural rather than a mock: it re-implements the
 * exact database invariants the production schema enforces —
 *
 *   * `channel_integrations_account_unique`
 *     UNIQUE (provider, external_account_id) WHERE external_account_id IS NOT NULL
 *   * `claim_channel_provider_account()` / `release_channel_provider_account()`
 *   * `plugin_secrets` upsert on (installation_id, secret_key)
 *
 * so the lifecycle tests exercise real ownership/rollback behaviour instead of
 * grepping source files.
 */

export type FakeIntegration = {
  id: string;
  public_integration_id: string;
  workspace_id: string;
  installation_id: string;
  provider: string;
  status: string;
  external_account_id: string | null;
  display_name: string | null;
  username: string | null;
  webhook_registered_at: string | null;
  webhook_verified_at: string | null;
  last_inbound_at: string | null;
  last_outbound_at: string | null;
  last_error_code: string | null;
  last_error_at: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export type FakeSecret = {
  id: string;
  installation_id: string;
  secret_key: string;
  algorithm: string;
  nonce: string;
  ciphertext: string;
  auth_tag: string;
  fingerprint: string;
};

const UNIQUE_VIOLATION = '23505';

export class FakeChannelsDb {
  integrations: FakeIntegration[] = [];
  secrets: FakeSecret[] = [];
  /** Forces the next update of a table to fail (DB transition failure tests). */
  failNextUpdate: string | null = null;

  newIntegration(input: Partial<FakeIntegration> & { workspace_id: string; installation_id: string }): FakeIntegration {
    const now = new Date().toISOString();
    const row: FakeIntegration = {
      id: input.id ?? `int_${this.integrations.length + 1}`,
      public_integration_id: input.public_integration_id ?? `pub_${this.integrations.length + 1}`,
      workspace_id: input.workspace_id,
      installation_id: input.installation_id,
      provider: input.provider ?? 'telegram',
      status: input.status ?? 'pending',
      external_account_id: input.external_account_id ?? null,
      display_name: null,
      username: null,
      webhook_registered_at: null,
      webhook_verified_at: null,
      last_inbound_at: null,
      last_outbound_at: null,
      last_error_code: null,
      last_error_at: null,
      metadata: {},
      created_at: now,
      updated_at: now,
      ...input,
    } as FakeIntegration;
    this.integrations.push(row);
    return row;
  }

  integration(id: string): FakeIntegration | undefined {
    return this.integrations.find((r) => r.id === id);
  }

  secret(installationId: string, key: string): FakeSecret | undefined {
    return this.secrets.find((s) => s.installation_id === installationId && s.secret_key === key);
  }

  /** Mirrors the partial unique index. */
  private ownershipConflict(row: FakeIntegration, provider: string, accountId: string): boolean {
    return this.integrations.some(
      (other) => other.id !== row.id && other.provider === provider && other.external_account_id === accountId,
    );
  }

  private rowsFor(table: string): any[] {
    if (table === 'channel_integrations') return this.integrations;
    if (table === 'plugin_secrets') return this.secrets;
    throw new Error(`FakeChannelsDb: unsupported table ${table}`);
  }

  client(): any {
    const db = this;

    const selectBuilder = (table: string) => {
      const filters: Array<(row: any) => boolean> = [];
      const api: any = {
        eq(col: string, value: unknown) {
          filters.push((row) => row[col] === value);
          return api;
        },
        in(col: string, values: unknown[]) {
          filters.push((row) => values.includes(row[col]));
          return api;
        },
        contains(col: string, value: Record<string, unknown>) {
          filters.push((row) =>
            Object.entries(value).every(([k, v]) => (row[col] ?? {})[k] === v),
          );
          return api;
        },
        order() {
          return api;
        },
        limit() {
          return api;
        },
        rows() {
          return db.rowsFor(table).filter((row) => filters.every((f) => f(row)));
        },
        async maybeSingle() {
          return { data: api.rows()[0] ?? null, error: null };
        },
        async single() {
          const row = api.rows()[0];
          return row ? { data: row, error: null } : { data: null, error: { message: 'not found' } };
        },
      };
      return api;
    };

    return {
      from(table: string) {
        return {
          select: () => selectBuilder(table),
          insert(row: any) {
            return {
              select: () => ({
                async single() {
                  const rows = db.rowsFor(table);
                  const created = { id: `row_${rows.length + 1}`, ...row };
                  rows.push(created);
                  return { data: created, error: null };
                },
              }),
            };
          },
          upsert(row: any) {
            const rows = db.rowsFor(table);
            const existing = rows.find(
              (r) => r.installation_id === row.installation_id && r.secret_key === row.secret_key,
            );
            if (existing) Object.assign(existing, row);
            else rows.push({ id: `row_${rows.length + 1}`, ...row });
            return Promise.resolve({ data: null, error: null });
          },
          update(patch: any) {
            const filters: Array<(row: any) => boolean> = [];
            const runner: any = {
              eq(col: string, value: unknown) {
                filters.push((row) => row[col] === value);
                return runner;
              },
              then(resolve: (v: any) => void) {
                if (db.failNextUpdate === table) {
                  db.failNextUpdate = null;
                  resolve({ data: null, error: { message: 'simulated transition failure' } });
                  return;
                }
                const targets = db.rowsFor(table).filter((row) => filters.every((f) => f(row)));
                for (const row of targets) {
                  if (
                    table === 'channel_integrations' &&
                    patch.external_account_id != null &&
                    db.ownershipConflict(row, row.provider, patch.external_account_id)
                  ) {
                    resolve({ data: null, error: { code: UNIQUE_VIOLATION, message: 'duplicate key' } });
                    return;
                  }
                  Object.assign(row, patch);
                }
                resolve({ data: null, error: null });
              },
            };
            return runner;
          },
          delete() {
            const filters: Array<(row: any) => boolean> = [];
            const runner: any = {
              eq(col: string, value: unknown) {
                filters.push((row) => row[col] === value);
                return runner;
              },
              then(resolve: (v: any) => void) {
                const rows = db.rowsFor(table);
                for (let i = rows.length - 1; i >= 0; i -= 1) {
                  if (filters.every((f) => f(rows[i]))) rows.splice(i, 1);
                }
                resolve({ data: null, error: null });
              },
            };
            return runner;
          },
        };
      },

      async rpc(fn: string, args: any) {
        if (fn === 'claim_channel_provider_account') {
          const row = db.integration(args._integration_id);
          if (!row) return { data: 'missing', error: null };
          if (row.external_account_id === args._external_account_id) return { data: 'owned', error: null };
          if (db.ownershipConflict(row, args._provider, args._external_account_id)) {
            return { data: 'conflict', error: null };
          }
          row.external_account_id = args._external_account_id;
          row.updated_at = new Date().toISOString();
          return { data: 'claimed', error: null };
        }
        if (fn === 'release_channel_provider_account') {
          const row = db.integration(args._integration_id);
          if (row) row.external_account_id = null;
          return { data: null, error: null };
        }
        throw new Error(`FakeChannelsDb: unsupported rpc ${fn}`);
      },
    };
  }
}
