/**
 * Source-shape guard for the widget config cache (server/services/widget/
 * configSnapshot.ts) and the cross-node bus (server/lib/cacheBus.ts).
 *
 * The snapshot caches what the widget's bootstrap and config read. A writer
 * of any of those inputs that forgets to publish an invalidation leaves every
 * backend process serving the old value until the TTL (60 s by default). So
 * each known writer must call publishCacheInvalidation (directly, or through
 * the named helper that does) AFTER its write, and every per-process cache
 * the bus is meant to keep consistent must register its handler.
 *
 * Adding a new writer of widget_settings, workspace_branding, workspaces.name,
 * workspace_members, profiles (name / avatar), user_availability_prefs,
 * ai_agent_settings, widget_smart_rules, widget_ai_nudge_settings,
 * workspace_provider_settings, plans / overrides / subscriptions, the
 * platform settings or the storage provider? Publish, and list it here.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const read = (p: string) => readFileSync(p, 'utf8');

/** The handler / function body starting at `marker`, up to the next top-level route or function. */
function segment(src: string, marker: string): string {
  const start = src.indexOf(marker);
  expect(start, `marker not found: ${marker}`).toBeGreaterThan(-1);
  const rest = src.slice(start + marker.length);
  const next = rest.search(/\n(?:[A-Za-z]+Router\.(?:get|post|put|patch|delete|use)\(|export (?:async )?function |async function |function )/);
  return rest.slice(0, next === -1 ? undefined : next);
}

const PUBLISH = /publishCacheInvalidation\(|publishMemberSetChange\(|handleWorkspaceEntitlementChanged\(/;
const WRITE = /\.(?:update|insert|upsert|delete)\(|\.rpc\(|runIdempotent\(|updatePlatformAiAgentSettings\(|deleteSmsProviderConfig\(|saveSmsProviderConfig\(|upsertSmsProviderConfig\(/;

const WRITERS: Record<string, string[]> = {
  'server/routes/widgetSettings.ts': [
    "widgetSettingsRouter.patch('/:workspaceId', async",
    "widgetSettingsRouter.post('/:workspaceId/fab-image'",
    "widgetSettingsRouter.delete('/:workspaceId/fab-image'",
    "widgetSettingsRouter.patch('/:workspaceId/debug'",
    "widgetSettingsRouter.get('/platform/config'",
    "widgetSettingsRouter.patch('/platform/config'",
  ],
  'server/routes/workspaces.ts': [
    'workspacesRouter.patch(`/${WORKSPACE_ID_PARAM}`, async',
    'workspacesRouter.patch(`/${WORKSPACE_ID_PARAM}/branding`',
    'workspacesRouter.post(`/${WORKSPACE_ID_PARAM}/domains`',
    'workspacesRouter.delete(`/${WORKSPACE_ID_PARAM}/domains/:domainId`',
    'workspacesRouter.patch(`/${WORKSPACE_ID_PARAM}/domains/:domainId/primary`',
  ],
  'server/routes/account.ts': [
    "accountRouter.patch('/me'",
    "accountRouter.post('/avatar'",
    "accountRouter.delete('/avatar'",
    "accountRouter.post('/workspace-icon'",
    "accountRouter.delete('/workspace-icon'",
  ],
  'server/routes/admin.ts': [
    "adminRouter.delete('/users/:userId/avatar'",
    "adminRouter.patch('/users/:userId/profile'",
  ],
  'server/services/ai-agent/settings.ts': [
    'export async function getOrCreateSettings(',
    'export async function updateSettings(',
  ],
  'server/routes/ai-agent/platform.ts': ["platformRouter.patch('/platform/settings'"],
  'server/routes/workspaceSmartRules.ts': [
    "workspaceSmartRulesRouter.post('/:workspaceId/smart-rules/:ruleId/publish'",
    "workspaceSmartRulesRouter.post('/:workspaceId/smart-rules/:ruleId/unpublish'",
    "workspaceSmartRulesRouter.post('/:workspaceId/smart-rules', async",
    "workspaceSmartRulesRouter.patch('/:workspaceId/smart-rules/:ruleId'",
    "workspaceSmartRulesRouter.delete('/:workspaceId/smart-rules/:ruleId'",
    "workspaceSmartRulesRouter.patch('/:workspaceId/ai-nudge-settings'",
  ],
  'server/routes/workspaceMembers.ts': [
    "workspaceMembersRouter.patch('/:memberId', async",
    "workspaceMembersRouter.patch('/:memberId/suspension'",
    "workspaceMembersRouter.delete('/:memberId'",
  ],
  'server/routes/workspaceInvitations.ts': [
    "workspaceInvitationsRouter.post('/accept-new'",
    "workspaceInvitationsRouter.post('/accept-existing'",
  ],
  'server/routes/availability.ts': ["availabilityRouter.patch('/'"],
  'server/routes/workspaceIntegrations.ts': [
    "workspaceIntegrationsRouter.put('/:workspaceId/providers'",
    "workspaceIntegrationsRouter.delete('/:workspaceId/providers/:providerType'",
    "workspaceIntegrationsRouter.put('/:workspaceId/privacy-storage'",
    "workspaceIntegrationsRouter.delete('/:workspaceId/privacy-storage'",
  ],
  'server/routes/adminManagement.ts': [
    "adminManagementRouter.put('/platform-settings'",
    "adminManagementRouter.put('/platform-branding'",
    "adminManagementRouter.put('/platform-branding-localized'",
    "adminManagementRouter.put('/panel-theme'",
    "adminManagementRouter.patch('/domains/:id'",
    "adminManagementRouter.put('/runtime-config/:key'",
    "adminManagementRouter.delete('/runtime-config/:key'",
  ],
  'server/services/billing/entitlementChange.ts': [
    'export async function handleWorkspaceEntitlementChanged(',
    'export async function handlePlanDefinitionChanged(',
    'export async function handlePlatformAiEnabled(',
  ],
  'server/routes/plans.ts': ["plansRouter.post('/admin/overrides/module'"],
  'server/routes/adminBillingLocks.ts': ["adminBillingLocksRouter.put('/'"],
  'server/routes/adminAlerts.ts': ["adminAlertsRouter.put('/webhook'"],
  'server/routes/adminSmsProviders.ts': [
    "adminSmsProvidersRouter.put('/'",
    "adminSmsProvidersRouter.delete('/'",
  ],
  'server/services/calls/controlPlane.ts': [
    'export async function saveCallControlPlane(',
    'export async function saveWorkspaceCallOverrides(',
  ],
  'server/services/storage/pool.ts': ['export async function writeStoragePool('],
};

describe('every writer of a widget-config input publishes an invalidation', () => {
  for (const [file, markers] of Object.entries(WRITERS)) {
    const src = read(file);
    for (const marker of markers) {
      it(`${file} — ${marker}`, () => {
        const body = segment(src, marker);
        const publishAt = body.search(PUBLISH);
        expect(publishAt, 'no publishCacheInvalidation in this writer').toBeGreaterThan(-1);
        const writeAt = body.search(WRITE);
        if (writeAt > -1) expect(publishAt, 'publish must follow the write').toBeGreaterThan(writeAt);
      });
    }
  }

  it('the invitation helper and the entitlement handler really publish', () => {
    expect(segment(read('server/routes/workspaceInvitations.ts'), 'function publishMemberSetChange(')).toContain('publishCacheInvalidation([`widget:${workspaceId}`])');
    expect(segment(read('server/services/billing/entitlementChange.ts'), 'export async function handleWorkspaceEntitlementChanged('))
      .toContain('publishCacheInvalidation([`widget:${workspaceId}`, `entitlements:${workspaceId}`, `origin:${workspaceId}`])');
  });

  it('the widget settings PATCH also invalidates the origin rules everywhere', () => {
    expect(segment(read('server/routes/widgetSettings.ts'), "widgetSettingsRouter.patch('/:workspaceId', async"))
      .toContain('publishCacheInvalidation([`widget:${workspaceId}`, `origin:${workspaceId}`])');
  });
});

describe('every per-process cache the bus keeps consistent registers its handler', () => {
  const HANDLERS: Array<[string, string]> = [
    ['server/services/widget/configSnapshot.ts', "onInvalidate('widget',"],
    ['server/services/widget/configSnapshot.ts', "onInvalidate('user',"],
    ['server/services/widget/configSnapshot.ts', "onInvalidate('platform',"],
    ['server/services/widget/public.ts', "onInvalidate('origin',"],
    ['server/services/widget/public.ts', "onInvalidate('host',"],
    ['server/middleware/featureGating.ts', "onInvalidate('entitlements',"],
    ['server/services/billing/locks/state.ts', "onInvalidate('entitlements',"],
    ['server/services/platformPublicConfig.ts', "onInvalidate('platform',"],
    ['server/services/platformRegion.ts', "onInvalidate('platform',"],
    ['server/services/calls/controlPlane.ts', "onInvalidate('platform',"],
  ];
  it.each(HANDLERS)('%s registers %s', (file, call) => {
    expect(read(file)).toContain(call);
  });

  it('clearEntitlementCache / clearLockStateCache drop the local widget snapshot (local only, never publish)', () => {
    for (const [file, fn] of [
      ['server/middleware/featureGating.ts', 'export function clearEntitlementCache('],
      ['server/services/billing/locks/state.ts', 'export function clearLockStateCache('],
    ]) {
      const body = segment(read(file), fn);
      expect(body).toContain("invalidateLocal([workspaceId ? `widget:${workspaceId}` : 'widget'])");
      expect(body).not.toContain('publishCacheInvalidation');
    }
  });

  it('only the API process listens', () => {
    expect(read('server/index.ts')).toContain('startCacheBusListener();');
    for (const f of ['worker/intelligence/index.ts', 'channels/worker.ts']) {
      try {
        expect(read(f)).not.toContain('startCacheBusListener');
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }
    }
  });
});
