import { Router } from 'express';
import { serverConfigOf } from '../lib/workspaceAuth.js';
import { getPlatformState } from '../services/plugins/state.js';

// Public, read-only release policy: no workspace data or credentials. The
// artifact itself is served from the installation's configured HTTPS app URL.
export const whmcsUpdatesRouter = Router();
whmcsUpdatesRouter.get('/', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const state = await getPlatformState(serverConfigOf(req), 'whmcs');
    res.json({ enabled: state.enabled && !state.maintenance_mode && state.policy?.autoUpdateEnabled !== false });
  } catch {
    res.status(503).json({ enabled: false });
  }
});
