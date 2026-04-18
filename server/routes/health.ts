import { Router } from 'express';
import { getManifestDiagnostics } from '../services/widget/manifest.js';

export const healthRouter = Router();

healthRouter.get('/', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

/**
 * Widget asset diagnostics.
 *
 * Exposes which widget-manifest source the backend resolved (local FS,
 * remote HTTP, or fallback). Use this to verify deploys when the live
 * widget shows `runtime.js?v=dev` / `?v=unresolved`.
 *
 * Safe to expose publicly: it only returns asset filenames + the cache
 * source string, no secrets.
 */
healthRouter.get('/widget', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    manifest: getManifestDiagnostics(),
  });
});
