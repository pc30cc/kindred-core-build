/**
 * Phase 8D — Widget-side callback request creation.
 * Mounted under the widget router. Unlike its sibling sub-routers
 * (identity/departments/call-invitations) this one is mounted BEFORE the
 * parent widgetRouter's enforceWidgetToken/enforceOrigin/visitor-cookie
 * middleware, so it must apply its own token + origin gate and resolve the
 * visitor cookie itself — it cannot rely on the parent to have set
 * req._widgetWorkspaceId / req.visitorId.
 */
import { Router } from 'express';
import { z } from 'zod';
import type { ServerConfig } from '../config.js';
import { createCallbackRequest } from '../services/calls/callbacks.js';
import { markEntryAsCallback } from '../services/calls/queue.js';
import { getServiceClient } from '../supabase.js';
import { loadEffectiveCallEntitlements } from '../services/calls/entitlementComposer.js';
import { enforceWidgetToken, enforceOrigin } from '../services/widget/security.js';
import { readVisitorCookie } from '../services/widget/visitorIdentity.js';

export const widgetCallbacksRouter = Router();

widgetCallbacksRouter.use(enforceWidgetToken);
widgetCallbacksRouter.use(enforceOrigin);

// Phase 8D++ — Visible cooldown window for the widget UI. Mirrors the
// dedupe window used in createCallbackRequest (10 minutes). UI-only;
// backend behavior is unchanged.
const CALLBACK_COOLDOWN_MS = 10 * 60 * 1000;

/**
 * GET /status — widget-safe lookup of the visitor's open callback (if any).
 * Workspace + visitor scoped via existing widget auth middleware.
 * Returns minimal, non-sensitive fields the widget needs to render the
 * "Callback pending" badge and approximate cooldown countdown.
 */
widgetCallbacksRouter.get('/status', async (req, res) => {
  const config = (req as any).serverConfig as ServerConfig;
  const workspaceId = (req as any)._widgetWorkspaceId as string | undefined;
  if (!workspaceId) return res.status(400).json({ error: 'missing_workspace' });
  const visitorId = readVisitorCookie(req, workspaceId)?.v;
  if (!visitorId) {
    return res.json({ has_open_callback: false });
  }
  try {
    const sb = getServiceClient(config);
    const sinceIso = new Date(Date.now() - CALLBACK_COOLDOWN_MS).toISOString();
    const { data } = await sb
      .from('callback_requests')
      .select('id, status, channel, requested_at, created_at')
      .eq('workspace_id', workspaceId)
      .eq('visitor_session_id', visitorId)
      .in('status', ['requested', 'scheduled', 'in_progress'])
      .gte('created_at', sinceIso)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!data) return res.json({ has_open_callback: false });
    const createdMs = new Date((data as any).created_at).getTime();
    const cooldownUntil = new Date(createdMs + CALLBACK_COOLDOWN_MS).toISOString();
    res.json({
      has_open_callback: true,
      status: (data as any).status,
      channel: (data as any).channel,
      requested_at: (data as any).requested_at,
      cooldown_until: cooldownUntil,
    });
  } catch {
    res.json({ has_open_callback: false });
  }
});

widgetCallbacksRouter.post('/request', async (req, res) => {
  const config = (req as any).serverConfig as ServerConfig;
  const workspaceId = (req as any)._widgetWorkspaceId as string | undefined;
  if (!workspaceId) return res.status(400).json({ error: 'missing_workspace' });
  const visitorId = readVisitorCookie(req, workspaceId)?.v;
  // Plan composer gate — visitor-initiated callback request.
  // Deny-on-create only; the GET /status path above stays reachable so
  // visitors with already-created callbacks can still see their state.
  try {
    const eff = await loadEffectiveCallEntitlements(config, workspaceId);
    if (!eff.callbacks_enabled) {
      return res.status(403).json({
        error: 'plan_forbidden',
        capability: 'call_callbacks',
        upgrade_required: true,
      });
    }
  } catch {
    return res.status(403).json({ error: 'plan_forbidden', capability: 'call_callbacks', upgrade_required: true });
  }
  const parsed = z.object({
    channel: z.enum(['audio', 'video']),
    conversation_id: z.string().uuid().optional(),
    contact_phone: z.string().max(64).optional(),
    contact_email: z.string().email().optional(),
    notes: z.string().max(2000).optional(),
    queue_entry_id: z.string().uuid().optional(),
    /** Phase 8E — optional ISO datetime. Must be in the future and within 30d. */
    scheduled_for: z.string().datetime().optional(),
    /** Phase 8H — optional department selected by widget. */
    department_id: z.string().uuid().optional(),
  }).safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body' });
  // Validate scheduled_for window (UI-only safety; backend remains tolerant).
  let scheduledForIso: string | null = null;
  if (parsed.data.scheduled_for) {
    const t = new Date(parsed.data.scheduled_for).getTime();
    const now = Date.now();
    const maxAhead = now + 30 * 24 * 60 * 60 * 1000; // 30 days
    if (isNaN(t) || t < now - 60_000 || t > maxAhead) {
      return res.status(400).json({ error: 'invalid_schedule_window' });
    }
    scheduledForIso = new Date(t).toISOString();
  }
  try {
    const cb = await createCallbackRequest(config, {
      workspaceId,
      channel: parsed.data.channel,
      conversationId: parsed.data.conversation_id ?? null,
      visitorSessionId: visitorId ?? null,
      contactPhone: parsed.data.contact_phone ?? null,
      contactEmail: parsed.data.contact_email ?? null,
      notes: parsed.data.notes ?? null,
      scheduledFor: scheduledForIso,
      metadata: parsed.data.department_id
        ? { department_id: parsed.data.department_id }
        : undefined,
    });
    if (parsed.data.queue_entry_id) {
      await markEntryAsCallback(config, parsed.data.queue_entry_id, cb.id);
    }
    const createdMs = new Date(cb.created_at).getTime();
    const cooldownUntil = new Date(createdMs + CALLBACK_COOLDOWN_MS).toISOString();
    res.json({ callback: cb, cooldown_until: cooldownUntil });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || 'callback_failed' });
  }
});
