import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * `GET /api/workspaces` carries each workspace's website, and both native
 * apps show it under the workspace's name in Settings (owner, 2026-11-01).
 *
 * The domain is not on `workspaces`: `workspace_domains` holds one row per
 * domain. The route picks one (the verified primary first) and sends it as
 * `website_domain`; the apps decode that exact name. The field is optional on
 * both sides, so a wrong spelling would decode as "no website" without a
 * sound. This test is the sound.
 */

const ROUTE = 'server/routes/workspaces.ts';

/** The body of `workspacesRouter.get('/', …)`, up to the next route. */
function listHandler(source: string): string {
  const start = source.indexOf("workspacesRouter.get('/',");
  expect(start).toBeGreaterThan(-1);
  const rest = source.slice(start + 1);
  const end = rest.indexOf('workspacesRouter.');
  return rest.slice(0, end === -1 ? undefined : end);
}

describe('GET /api/workspaces carries the workspace website', () => {
  const handler = listHandler(readFileSync(ROUTE, 'utf8'));

  it('reads the domains table, which is where the website lives', () => {
    expect(handler).toMatch(/from\(\s*'workspace_domains'\s*\)/);
    expect(handler).toMatch(/verified/);
    expect(handler).toMatch(/is_primary/);
  });

  it('puts `website_domain` on every workspace it returns', () => {
    expect(handler).toMatch(/website_domain:/);
  });

  it('the iOS app decodes the field and shows it in Settings', () => {
    const model = readFileSync('ios/Webyar/Sources/Core/Models/Models.swift', 'utf8');
    expect(model).toMatch(/case websiteDomain = "website_domain"/);
    const settings = readFileSync('ios/Webyar/Sources/Features/Settings/SettingsView.swift', 'utf8');
    expect(settings).toMatch(/workspace\.websiteDomain/);
  });

  it('the Android app decodes the field and shows it in Settings', () => {
    const model = readFileSync('android/app/src/main/kotlin/com/platform/app/core/model/Models.kt', 'utf8');
    expect(model).toMatch(/@SerialName\("website_domain"\) val websiteDomain/);
    const settings = readFileSync(
      'android/app/src/main/kotlin/com/platform/app/feature/settings/SettingsScreen.kt',
      'utf8',
    );
    expect(settings).toMatch(/workspace\.websiteDomain/);
  });
});
