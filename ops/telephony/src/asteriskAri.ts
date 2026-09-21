/**
 * Asterisk runtime control.
 *
 * Split of responsibilities (deliberate, see docs/TELEPHONY_ARCHITECTURE.md):
 *   - PJSIP Realtime (PostgreSQL) is the CONFIGURATION store — database.ts.
 *   - ARI is runtime channel/bridge control and events ONLY — this file.
 *   - The Asterisk CLI is used for the two things ARI cannot do: re-reading
 *     outbound registrations and reading registration state.
 *
 * Nothing here ever writes configuration through ARI.
 */

import { timeoutSignal } from './timeout.js';
import { execFile } from 'node:child_process';

export type RegistrationOutcome =
  | 'registered'
  | 'registering'
  | 'invalid_credentials'
  | 'provider_rejected'
  | 'registration_timeout'
  | 'dns_failure'
  | 'transport_unsupported'
  | 'not_found';

export interface ChannelInfo {
  id: string;
  name: string;
  callerNumber: string | null;
  dialedNumber: string | null;
}

export interface AsteriskControl {
  /** ARI liveness (`GET /asterisk/info`). */
  info(): Promise<{ ok: boolean; version?: string; error?: string }>;
  /** SIP stack liveness (`pjsip show transports` via CLI). */
  sipStackUp(): Promise<boolean>;
  /**
   * Whether ASTERISK ITSELF is connected to the realtime database. This is a
   * different question from whether the control service can reach Postgres:
   * res_config_pgsql has its own connection, and when it is misconfigured it
   * falls back to a localhost socket and fails silently while the Node pool
   * stays perfectly healthy. PJSIP then has no endpoints and no
   * registrations, which is indistinguishable from "not configured yet".
   */
  realtimeBackendUp(): Promise<boolean>;
  cli(command: string): Promise<string>;
  /** Narrowest possible reload: re-read outbound registrations, then kick one. */
  reloadRegistration(objectId: string): Promise<void>;
  registrationState(objectId: string): Promise<RegistrationOutcome>;
  removeRegistration(objectId: string): Promise<void>;
  getChannelVar(channelId: string, variable: string): Promise<string | null>;
  answer(channelId: string): Promise<void>;
  ring(channelId: string): Promise<void>;
  hangup(channelId: string, reason?: 'normal' | 'busy' | 'congestion'): Promise<void>;
  createBridge(bridgeId: string): Promise<void>;
  addToBridge(bridgeId: string, channelIds: string[]): Promise<void>;
  destroyBridge(bridgeId: string): Promise<void>;
  /** Dials the static LiveKit SIP endpoint with the room name as the callee. */
  originateToLiveKit(input: { endpoint: string; room: string; callerId: string; appArgs: string }): Promise<string>;
}

export interface AriHttpOptions {
  url: string;
  user: string;
  password: string;
  appName: string;
}

function authHeader(opts: AriHttpOptions): string {
  return `Basic ${Buffer.from(`${opts.user}:${opts.password}`).toString('base64')}`;
}

async function ariFetch(
  opts: AriHttpOptions,
  method: string,
  path: string,
  body?: unknown,
): Promise<any> {
  const res = await fetch(`${opts.url}${path}`, {
    method,
    headers: { authorization: authHeader(opts), 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: timeoutSignal(10_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`ari_${res.status}:${text.slice(0, 200)}`);
  try { return text ? JSON.parse(text) : null; } catch { return null; }
}

function runCli(command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('asterisk', ['-rx', command], { timeout: 10_000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`asterisk_cli_failed:${stderr || err.message}`));
      resolve(String(stdout));
    });
  });
}

/**
 * Pure parser — unit tested without Asterisk.
 *
 * Connected looks like "Connected to <db>@<host>, port <n> with username <u>
 * for <t> seconds"; a broken connection reports "Unable to connect ...".
 */
export function parseRealtimeBackendUp(output: string): boolean {
  return /connected to /i.test(output) && !/unable to connect/i.test(output);
}

/**
 * Pure parser — unit tested without Asterisk.
 *
 * Reads ONLY the status row. `pjsip show registration <id>` prints that row
 * and then dumps every configured parameter, and that dump always contains
 * `forbidden_retry_interval`, `auth_rejection_permanent` and
 * `fatal_retry_interval`. Matching keywords against the whole output therefore
 * reported a perfectly healthy trunk as `invalid_credentials` — surfaced to
 * the operator as "the provider did not accept these SIP credentials" — every
 * time the status was momentarily `Unregistered`. That is exactly what Test
 * Connection reads, a few hundred milliseconds after it asks Asterisk to
 * re-register, and `waitForRegistration` treats any non-`registering` answer
 * as terminal, so it gave up before the REGISTER had even been answered.
 */
export function parseRegistrationState(output: string): RegistrationOutcome {
  const text = String(output ?? '');
  if (!text.trim()) return 'not_found';

  // Everything from the `ParameterName` header onwards is configuration, not
  // state. A bare status string (no dump at all) passes through unchanged.
  const status = text.split(/^[ \t]*ParameterName\b/im)[0].toLowerCase();

  if (/no objects found|unable to find/.test(status)) return 'not_found';
  if (/failed to resolve|name resolution/.test(status)) return 'dns_failure';
  if (/unsupported transport|transport not found/.test(status)) return 'transport_unsupported';
  if (/rejected \(permanent\)|\b403\b|forbidden|unauthorized|auth failed|no auth/.test(status)) {
    return 'invalid_credentials';
  }
  if (/rejected/.test(status)) return 'provider_rejected';
  // `unregistered` is a transient step on the way to `registered`, never a
  // terminal answer — reporting it as such is what ends the wait early.
  if (/\bunregistered\b|\bnever\b/.test(status)) return 'registering';
  if (/\bregistered\b/.test(status)) return 'registered';
  return 'registering';
}

export function createAsteriskControl(opts: AriHttpOptions, cliRunner = runCli): AsteriskControl {
  return {
    async info() {
      try {
        const data = await ariFetch(opts, 'GET', '/asterisk/info');
        return { ok: true, version: data?.system?.version ?? data?.build?.date ?? null };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    },

    async sipStackUp() {
      try {
        const out = await cliRunner('pjsip show transports');
        return /transport:/i.test(out);
      } catch {
        return false;
      }
    },

    async realtimeBackendUp() {
      try {
        return parseRealtimeBackendUp(await cliRunner('realtime show pgsql status'));
      } catch {
        return false;
      }
    },

    cli: (command: string) => cliRunner(command),

    async reloadRegistration(objectId: string) {
      // Endpoints/auths/AORs are realtime and fetched on demand — no reload.
      // Outbound registrations are not, so re-read just that module and then
      // kick this single object. Asterisk is never restarted, and other
      // workspaces' registrations keep their existing state.
      await cliRunner('module reload res_pjsip_outbound_registration.so').catch(() => '');
      await cliRunner(`pjsip send register ${objectId}`).catch(() => '');
    },

    async registrationState(objectId: string) {
      const out = await cliRunner(`pjsip show registration ${objectId}`);
      return parseRegistrationState(out);
    },

    async removeRegistration(objectId: string) {
      await cliRunner(`pjsip send unregister ${objectId}`).catch(() => '');
      await cliRunner('module reload res_pjsip_outbound_registration.so').catch(() => '');
    },

    async getChannelVar(channelId, variable) {
      try {
        const data = await ariFetch(
          opts, 'GET',
          `/channels/${encodeURIComponent(channelId)}/variable?variable=${encodeURIComponent(variable)}`,
        );
        const value = data?.value;
        return value ? String(value) : null;
      } catch {
        return null;
      }
    },

    async answer(channelId) {
      await ariFetch(opts, 'POST', `/channels/${encodeURIComponent(channelId)}/answer`);
    },

    async ring(channelId) {
      await ariFetch(opts, 'POST', `/channels/${encodeURIComponent(channelId)}/ring`);
    },

    async hangup(channelId, reason = 'normal') {
      await ariFetch(opts, 'DELETE', `/channels/${encodeURIComponent(channelId)}?reason=${reason}`);
    },

    async createBridge(bridgeId) {
      await ariFetch(opts, 'POST', `/bridges/${encodeURIComponent(bridgeId)}?type=mixing`);
    },

    async addToBridge(bridgeId, channelIds) {
      await ariFetch(
        opts, 'POST',
        `/bridges/${encodeURIComponent(bridgeId)}/addChannel?channel=${channelIds.map(encodeURIComponent).join(',')}`,
      );
    },

    async destroyBridge(bridgeId) {
      await ariFetch(opts, 'DELETE', `/bridges/${encodeURIComponent(bridgeId)}`).catch(() => undefined);
    },

    /**
     * The room name Core chose becomes the SIP callee. The long-lived LiveKit
     * SIP dispatch rule maps that callee to exactly that room — no trunk or
     * dispatch rule is created per call.
     */
    async originateToLiveKit({ endpoint, room, callerId, appArgs }) {
      const data = await ariFetch(opts, 'POST', '/channels/create', {
        endpoint: `PJSIP/${room}@${endpoint}`,
        app: opts.appName,
        appArgs,
        callerId,
      });
      const id = data?.id ? String(data.id) : '';
      if (!id) throw new Error('originate_failed');
      await ariFetch(opts, 'POST', `/channels/${encodeURIComponent(id)}/dial?timeout=30`);
      return id;
    },
  };
}
