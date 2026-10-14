import { databaseSettings, DatabasePool } from '../../db/pool.js';
import { isPluginCryptoConfigured } from '../../lib/pluginCrypto.js';

export class BridgeError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}

/** Lazy and independent: a missing bridge DB never prevents the app booting. */
export function bridgeConfig(env: NodeJS.ProcessEnv = process.env) {
  if (env.WIDGET_BRIDGE_ENABLED !== '1') throw new BridgeError(503, 'bridge_unavailable');
  const appId = env.WIDGET_BRIDGE_APP_ID?.trim();
  const url = env.WIDGET_BRIDGE_DATABASE_URL?.trim();
  if (!appId || !/^[a-z0-9_-]{1,64}$/.test(appId) || !url) throw new BridgeError(503, 'bridge_unavailable');
  const dbIdentity = (value: string) => {
    const parsed = new URL(value);
    return `${parsed.hostname.toLowerCase()}:${parsed.port || '5432'}${parsed.pathname}`;
  };
  // Prevent the most common deployment mistake; also use a DB role with no
  // access to either application's database (see the deployment runbook).
  try {
    if (env.DATABASE_URL && dbIdentity(url) === dbIdentity(env.DATABASE_URL)) {
      throw new BridgeError(503, 'bridge_database_must_be_separate');
    }
  } catch (err) {
    if (err instanceof BridgeError) throw err;
    throw new BridgeError(503, 'bridge_unavailable');
  }
  if (!isPluginCryptoConfigured(env.WIDGET_BRIDGE_ENCRYPTION_KEY)) throw new BridgeError(503, 'bridge_unavailable');
  return { appId, url, encryptionKey: env.WIDGET_BRIDGE_ENCRYPTION_KEY! };
}

let pool: DatabasePool | undefined;
export function bridgePool() {
  const config = bridgeConfig();
  if (!pool) {
    const settings = databaseSettings({
      ...process.env, DATABASE_URL: config.url,
      DATABASE_ROLE: process.env.WIDGET_BRIDGE_DATABASE_ROLE || 'none',
      DATABASE_SSL: process.env.WIDGET_BRIDGE_DATABASE_SSL || '',
      DATABASE_SSL_CA: process.env.WIDGET_BRIDGE_DATABASE_SSL_CA || '',
      DATABASE_POOL_MAX: '2', DATABASE_SCHEMAS: 'public',
      DATABASE_APPLICATION_NAME: `widget-bridge-${config.appId}`,
      DATABASE_STATEMENT_TIMEOUT_MS: '10000',
    });
    pool = new DatabasePool(settings!);
  }
  return pool;
}
