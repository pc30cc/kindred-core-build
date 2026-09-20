/**
 * Workspace telephony configuration API (`/api/telephony/*`).
 *
 * Write-only credential handling, exactly like the bot-token surface: the SIP
 * password can be submitted and replaced but NEVER read back. Every response
 * carries `hasSipPassword` instead of a value, and an omitted/blank password
 * field on save leaves the stored secret untouched.
 */

import { Router } from 'express';
import { z } from 'zod';
import { authorizeWorkspaceAccess, serverConfigOf } from '../lib/workspaceAuth.js';
import { getInstallation, updateInstallationSettings } from '../services/plugins/state.js';
import { parseTelephonySettings, maskDomain, registrationDomain } from '../services/telephony/settings.js';
import {
  deleteSipPassword,
  hasSipPassword,
  storeSipPassword,
  telephonyCryptoReady,
} from '../services/telephony/secrets.js';
import {
  deprovisionRegistration,
  getRegistration,
  runConnectionTest,
  syncRegistration,
  upsertRegistration,
} from '../services/telephony/registrations.js';
import { gatewayHealth, isTelephonyGatewayConfigured } from '../services/telephony/gatewayClient.js';
import {
  DAFTARESHOMA_HELP_URL,
  DAFTARESHOMA_PROVIDER_ID,
} from '../services/telephony/providers/daftareshoma/index.js';

const MANAGE_ROLES = ['owner', 'admin'];

async function requireManager(req: any, res: any, workspaceId: string) {
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId);
  if (!auth) return null;
  if (!auth.isAdmin && !MANAGE_ROLES.includes(auth.role ?? '')) {
    res.status(403).json({ error: 'Insufficient workspace role' });
    return null;
  }
  return auth;
}

export const telephonyRouter = Router();

const workspaceQuery = z.object({ workspace_id: z.string().uuid() });

const saveSchema = z.object({
  workspace_id: z.string().uuid(),
  settings: z.record(z.unknown()),
  /** Optional: omit or leave blank to keep the stored password. */
  sip_password: z.string().max(256).optional(),
});

/** Secret-free status payload shared by every endpoint below. */
async function buildStatus(config: any, workspaceId: string) {
  const installation = await getInstallation(config, workspaceId, DAFTARESHOMA_PROVIDER_ID);
  if (!installation) {
    return {
      installed: false,
      provider: DAFTARESHOMA_PROVIDER_ID,
      helpUrl: DAFTARESHOMA_HELP_URL,
      settings: null,
      hasSipPassword: false,
      readiness: { configured: false, gateway_healthy: false, sip_registered: false, livekit_sip_ready: false },
      registration: null,
    };
  }

  const parsed = parseTelephonySettings(installation.settings ?? {});
  const settings = parsed.ok ? parsed.settings : parseTelephonySettings({}).ok ? parseTelephonySettings({}) : null;
  const effective = parsed.ok ? parsed.settings : null;
  const registration = await getRegistration(config, installation.id);
  const passwordSaved = await hasSipPassword(config, installation.id);

  let gatewayHealthy = false;
  let livekitReady = false;
  if (isTelephonyGatewayConfigured(config)) {
    const health = await gatewayHealth(config);
    gatewayHealthy = health.ok && Boolean(health.data.gateway_healthy ?? true);
    livekitReady = health.ok && Boolean(health.data.livekit_sip_ready);
  }

  return {
    installed: true,
    installationId: installation.id,
    provider: DAFTARESHOMA_PROVIDER_ID,
    helpUrl: DAFTARESHOMA_HELP_URL,
    settings: effective,
    hasSipPassword: passwordSaved,
    cryptoReady: telephonyCryptoReady(config),
    gatewayConfigured: isTelephonyGatewayConfigured(config),
    readiness: {
      // Four independent flags: a saved password alone never reads as connected.
      configured: Boolean(effective && parsed.ok && parsed.complete && passwordSaved),
      gateway_healthy: gatewayHealthy,
      sip_registered: registration?.state === 'registered',
      livekit_sip_ready: livekitReady,
    },
    registration: registration
      ? {
          state: registration.state,
          lastRegisteredAt: registration.last_registered_at,
          lastErrorCode: registration.last_error_code,
          lastErrorAt: registration.last_error_at,
          lastInboundCallAt: registration.last_inbound_call_at,
          domain: maskDomain(effective ? registrationDomain(effective) : null),
          extension: registration.sip_extension,
        }
      : null,
    // Never present: the SIP password, in any form.
    settingsUnused: settings ? undefined : undefined,
  };
}

telephonyRouter.get('/daftareshoma/status', async (req: any, res) => {
  const parsed = workspaceQuery.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid request' });
  const auth = await requireManager(req, res, parsed.data.workspace_id);
  if (!auth) return;
  try {
    res.json(await buildStatus(serverConfigOf(req), parsed.data.workspace_id));
  } catch (err) {
    console.error('[telephony] status failed:', (err as Error).message);
    res.status(500).json({ error: 'status_failed' });
  }
});

telephonyRouter.put('/daftareshoma/settings', async (req: any, res) => {
  const parsed = saveSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid request' });
  const { workspace_id: workspaceId } = parsed.data;
  const auth = await requireManager(req, res, workspaceId);
  if (!auth) return;

  const config = serverConfigOf(req);
  const validated = parseTelephonySettings(parsed.data.settings);
  if (!validated.ok) return res.status(400).json({ error: 'invalid_settings', fields: validated.errors });

  try {
    const installation = await getInstallation(config, workspaceId, DAFTARESHOMA_PROVIDER_ID);
    if (!installation) return res.status(404).json({ error: 'not_installed' });

    const password = (parsed.data.sip_password ?? '').trim();
    if (password) {
      if (!telephonyCryptoReady(config)) return res.status(503).json({ error: 'encryption_not_configured' });
      await storeSipPassword(config, installation.id, password);
    }

    // Settings row holds NON-SECRET values only.
    await updateInstallationSettings(config, installation.id, { ...validated.settings });
    await upsertRegistration(config, {
      installationId: installation.id,
      workspaceId,
      provider: DAFTARESHOMA_PROVIDER_ID,
      settings: validated.settings,
    });

    // Re-provision so an edited credential takes effect without a restart.
    if (validated.complete && (await hasSipPassword(config, installation.id))) {
      await syncRegistration(config, {
        installationId: installation.id,
        workspaceId,
        provider: DAFTARESHOMA_PROVIDER_ID,
        settings: validated.settings,
      });
    }

    res.json(await buildStatus(config, workspaceId));
  } catch (err) {
    console.error('[telephony] save failed:', (err as Error).message);
    res.status(500).json({ error: 'save_failed' });
  }
});

telephonyRouter.post('/daftareshoma/test', async (req: any, res) => {
  const parsed = workspaceQuery.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid request' });
  const auth = await requireManager(req, res, parsed.data.workspace_id);
  if (!auth) return;

  const config = serverConfigOf(req);
  try {
    const installation = await getInstallation(config, parsed.data.workspace_id, DAFTARESHOMA_PROVIDER_ID);
    if (!installation) return res.status(404).json({ error: 'not_installed' });
    const settings = parseTelephonySettings(installation.settings ?? {});
    if (!settings.ok) return res.status(400).json({ error: 'invalid_settings', fields: settings.errors });

    const result = await runConnectionTest(config, {
      installationId: installation.id,
      workspaceId: parsed.data.workspace_id,
      provider: DAFTARESHOMA_PROVIDER_ID,
      settings: settings.settings,
    });
    res.json({ result, status: await buildStatus(config, parsed.data.workspace_id) });
  } catch (err) {
    console.error('[telephony] test failed:', (err as Error).message);
    res.status(502).json({ error: 'test_failed' });
  }
});

/** Stops the SIP registration and forgets the credential. Idempotent. */
telephonyRouter.post('/daftareshoma/disconnect', async (req: any, res) => {
  const parsed = workspaceQuery.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid request' });
  const auth = await requireManager(req, res, parsed.data.workspace_id);
  if (!auth) return;

  const config = serverConfigOf(req);
  try {
    const installation = await getInstallation(config, parsed.data.workspace_id, DAFTARESHOMA_PROVIDER_ID);
    if (!installation) return res.json({ ok: true });
    await deprovisionRegistration(config, installation.id);
    await deleteSipPassword(config, installation.id);
    res.json({ ok: true, status: await buildStatus(config, parsed.data.workspace_id) });
  } catch (err) {
    console.error('[telephony] disconnect failed:', (err as Error).message);
    res.status(500).json({ error: 'disconnect_failed' });
  }
});
