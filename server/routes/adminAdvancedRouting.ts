/**
 * Super-admin global Advanced Routing endpoints.
 *
 *   GET   /api/admin/advanced-routing  → effective global policy
 *   PATCH /api/admin/advanced-routing  → patch + return effective policy
 *
 * Mounted under the `adminRouter` which already enforces the global admin
 * role — no workspace membership required.
 */
import { Router } from 'express';
import { z } from 'zod';
import { serverConfigOf } from '../lib/workspaceAuth.js';
import {
  loadGlobalAdvancedRouting,
  saveGlobalAdvancedRouting,
} from '../services/calls/globalAdvancedRouting.js';

export const adminAdvancedRoutingRouter = Router();

const patchSchema = z.object({
  owner_fallback_enabled: z.boolean().optional(),
  owner_fallback_for_chat: z.boolean().optional(),
  owner_fallback_for_audio: z.boolean().optional(),
  owner_fallback_for_video: z.boolean().optional(),
  general_pool_enabled: z.boolean().optional(),
  // Chat: "Return returning visitors to the same operator" for every
  // workspace (each workspace also has its own switch; migration 278).
  last_agent_routing_enabled: z.boolean().optional(),
}).strict();

adminAdvancedRoutingRouter.get('/', async (req, res) => {
  try {
    const policy = await loadGlobalAdvancedRouting(serverConfigOf(req));
    res.json({ policy });
  } catch (e) {
    res.status(500).json({ error: (e instanceof Error && e.message) || 'failed_to_load' });
  }
});

adminAdvancedRoutingRouter.patch('/', async (req, res) => {
  try {
    const patch = patchSchema.parse(req.body ?? {});
    const policy = await saveGlobalAdvancedRouting(serverConfigOf(req), patch);
    res.json({ policy });
  } catch (e) {
    res.status(400).json({ error: (e instanceof Error && e.message) || 'invalid_request' });
  }
});