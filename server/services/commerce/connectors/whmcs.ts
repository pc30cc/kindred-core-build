/**
 * WHMCS connector adapter.
 *
 * Talks to ONE endpoint of the webyar WHMCS addon
 * (`<System URL>/modules/addons/webyar/api.php`, plugins/webyar-whmcs/) with a
 * closed set of operations (shared/commerce/whmcs.ts WHMCS_OPS). There is no
 * generic API/SQL proxy: the addon rejects any op it does not know, and this
 * class can only name ops from that list.
 *
 * Every request is HMAC-signed exactly like the WooCommerce connector's
 * (server/services/commerce/signing.ts) — same headers, same string-to-sign —
 * over a fixed logical path, so the signature does not depend on where WHMCS
 * happens to be mounted. The body carries the op, its bounded params and, for
 * account reads, the grant reference. The grant is NOT an authorization by
 * itself: the addon re-checks it, the WHMCS user's permission on the client
 * account, and the row's ownership on every read.
 *
 * Bounds: one call never outlives the caller's deadline; one retry, only for
 * a transient transport failure, only if at least RETRY_MIN_REMAINING_MS of
 * the deadline is left, and with a fresh nonce/signature; never a retry for
 * authentication, permission, validation or not-found answers.
 */
import {
  CommerceError,
  type CommerceErrorCode,
} from '../../../../shared/commerce/types.js';
import {
  WHMCS_API_CANONICAL_PATH,
  WHMCS_API_ENDPOINT_PATH,
  type WhmcsGrantRef,
  type WhmcsOp,
} from '../../../../shared/commerce/whmcs.js';
import { commerceHttpRequest, type CommerceHttpRequest, type CommerceHttpResponse } from '../httpClient.js';
import { buildSignedHeaders } from '../signing.js';

export interface WhmcsTransport {
  /** Approved origin (scheme://host[:port]) — re-checked against baseUrl on every call. */
  origin: string;
  /** WHMCS System URL, no trailing slash (store_id of the connection). */
  baseUrl: string;
  installationId: string;
  secret: string;
}

export interface WhmcsCallOptions {
  deadlineAt: number;
  correlationId: string;
  grant?: WhmcsGrantRef | null;
}

export interface WhmcsCallResult {
  data: unknown;
  /** Bytes received (response body) across attempts — for metrics. */
  bytes: number;
  attempts: number;
}

/** A single call never takes more than this, even with deadline to spare. */
const MAX_CALL_MS = 4_000;
const RETRY_MIN_REMAINING_MS = 1_500;
const RETRY_BACKOFF_MS = 150;
/** Account answers are small by construction (≤10 rows of a few fields). */
const MAX_RESPONSE_BYTES = 64 * 1024;

type Requester = (req: CommerceHttpRequest) => Promise<CommerceHttpResponse>;

/** Error string from the addon → the safe taxonomy the AI layer sees. */
export function mapWhmcsError(status: number, error: unknown): CommerceErrorCode {
  const code = typeof error === 'string' ? error : '';
  if (status === 401) return 'commerce_permission_denied';
  if (status === 403) {
    if (code === 'grant_invalid') return 'identity_expired';
    if (code === 'permission_denied') return 'account_permission_denied';
    return 'commerce_permission_denied';
  }
  if (status === 404) return 'resource_not_found';
  if (status === 429) return 'rate_limited';
  if (status === 409 && code === 'schema_unsupported') return 'connector_outdated';
  if (status >= 500) return 'commerce_live_unavailable';
  return 'commerce_invalid_response';
}

/**
 * A non-2xx answer from the addon. The status is kept because two answers
 * share an error code for the assistant but mean different things for the
 * connection: 401 is "your signature was refused" (a credential problem),
 * while 403 `feature_disabled` is "the WHMCS admin switched this section off".
 */
export class WhmcsHttpError extends CommerceError {
  constructor(code: CommerceErrorCode, readonly status: number, message: string) {
    super(code, message);
  }
}

function isTransient(err: unknown): boolean {
  return err instanceof CommerceError && err.code === 'commerce_live_unavailable';
}

export class WhmcsConnector {
  readonly providerType = 'whmcs';

  constructor(
    private readonly transport: WhmcsTransport,
    private readonly request: Requester = commerceHttpRequest,
  ) {}

  /** Absolute endpoint URL, refusing a base URL that left the approved origin. */
  endpoint(): string {
    let base: URL;
    try {
      base = new URL(this.transport.baseUrl);
    } catch {
      throw new CommerceError('commerce_not_connected', 'invalid WHMCS base url');
    }
    if (base.origin !== this.transport.origin) {
      throw new CommerceError('commerce_not_connected', 'WHMCS base url is outside the approved origin');
    }
    return `${this.transport.baseUrl.replace(/\/+$/, '')}${WHMCS_API_ENDPOINT_PATH}`;
  }

  async call(op: WhmcsOp, params: Record<string, unknown>, opts: WhmcsCallOptions): Promise<WhmcsCallResult> {
    const url = this.endpoint();
    let bytes = 0;
    let attempts = 0;
    let lastError: unknown = null;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const remaining = opts.deadlineAt - Date.now();
      if (remaining <= 0) throw new CommerceError('commerce_timeout', 'WHMCS deadline exceeded');
      if (attempt > 0 && remaining < RETRY_MIN_REMAINING_MS) break;

      attempts += 1;
      // A fresh body, nonce and signature per attempt: the addon's replay
      // guard would (correctly) refuse a resent nonce.
      const body = JSON.stringify({
        op,
        params,
        grant: opts.grant ? { id: opts.grant.grantId, uid: opts.grant.userId, cid: opts.grant.clientId } : null,
      });
      const headers = buildSignedHeaders(this.transport.secret, this.transport.installationId, 'POST', WHMCS_API_CANONICAL_PATH, body);
      headers['X-WebYar-Correlation'] = opts.correlationId;

      try {
        const res = await this.request({
          url,
          method: 'POST',
          headers,
          body,
          retryable: false,
          timeoutMs: Math.min(remaining, MAX_CALL_MS),
          maxResponseBytes: MAX_RESPONSE_BYTES,
        });
        const json = (res.json && typeof res.json === 'object' ? res.json : {}) as { ok?: unknown; data?: unknown; error?: unknown };
        bytes += Buffer.byteLength(JSON.stringify(res.json ?? null), 'utf8');
        if (res.status >= 200 && res.status < 300 && json && json.ok === true) {
          return { data: json.data ?? null, bytes, attempts };
        }
        const code = mapWhmcsError(res.status, json?.error);
        const err = new WhmcsHttpError(code, res.status, `whmcs ${op} → ${res.status}`);
        // Only a 5xx is worth a second try; every 4xx is final.
        if (res.status >= 500 && res.status !== 501) {
          lastError = err;
          await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS));
          continue;
        }
        throw err;
      } catch (err) {
        if (isTransient(err) && attempt === 0) {
          lastError = err;
          await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS));
          continue;
        }
        throw err;
      }
    }
    if (lastError instanceof CommerceError) throw lastError;
    throw new CommerceError('commerce_live_unavailable', 'WHMCS call failed');
  }
}
