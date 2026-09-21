/**
 * The decisions in the native push work that App Review would reject if they
 * were reversed.
 *
 * None of these can be caught by building the app: it compiles and runs
 * perfectly with the permission prompt at launch, with a background mode it
 * never uses, and reading a device name it is not entitled to. They are
 * rejections, not crashes, and they arrive a week later in App Store Connect.
 * So they are pinned here, where they fail in a second.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const SOURCES = join(ROOT, 'ios', 'WebyarNative', 'Sources');
const PROJECT = join(ROOT, 'ios', 'WebyarNative', 'project.yml');

/**
 * Swift with its comments removed.
 *
 * Every rule below is about what the app DOES, and the files explaining why
 * it does not read `identifierForVendor` say `identifierForVendor`. Matching
 * prose would make the explanation the violation.
 */
function code(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => {
      const i = line.indexOf('//');
      return i === -1 ? line : line.slice(0, i);
    })
    .join('\n');
}

/** Every Swift file in the app target, as {path, text}. */
function swiftFiles(): Array<{ path: string; text: string }> {
  const out: Array<{ path: string; text: string }> = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.swift')) {
        out.push({ path: full.slice(SOURCES.length + 1), text: code(readFileSync(full, 'utf8')) });
      }
    }
  };
  walk(SOURCES);
  return out;
}

const files = swiftFiles();
const project = readFileSync(PROJECT, 'utf8');

function filesMatching(pattern: RegExp): string[] {
  return files.filter((f) => pattern.test(f.text)).map((f) => f.path);
}

describe('the one permission prompt iOS ever gives us', () => {
  it('is asked for by exactly two screens, and neither of them is launch', () => {
    // 5.1.1 and, more practically, the fact that a prompt spent before the
    // operator has seen a conversation is spent on somebody with no reason to
    // say yes — after which the only way back is the Settings app.
    const askers = filesMatching(/requestAuthorization\(/);
    expect(askers.sort()).toEqual([
      // Where the call lives.
      'Core/Push/PushController.swift',
      // The primer, shown after the inbox has loaded.
      'Features/Inbox/InboxView.swift',
      // Settings → Notifications, the permanent home.
      'Features/Settings/NotificationSettingsView.swift',
    ]);
  });

  it('is never asked for by the app delegate or the app itself', () => {
    for (const path of ['App/AppDelegate.swift', 'App/WebyarApp.swift', 'App/AppState.swift']) {
      const file = files.find((f) => f.path === path);
      expect(file, path).toBeDefined();
      expect(file!.text, path).not.toContain('requestAuthorization');
    }
  });

  it('is preceded by our own explanation, which can be declined for free', () => {
    const inbox = files.find((f) => f.path === 'Features/Inbox/InboxView.swift')!.text;
    // The system prompt is only reached from the primer's "allow" branch.
    expect(inbox).toContain('NotificationPrimerView');
    expect(inbox).toMatch(/authorization == \.notDetermined/);
  });

  it('registers for remote notifications only once permission exists', () => {
    const controller = files.find((f) => f.path === 'Core/Push/PushController.swift')!.text;
    for (const call of controller.split('registerForRemoteNotifications()').slice(0, -1)) {
      // Each call site is guarded by `granted` or by `isAllowed`.
      const tail = call.slice(-260);
      expect(tail, 'registerForRemoteNotifications must be guarded').toMatch(/granted|isAllowed/);
    }
  });
});

describe('what the binary declares about itself', () => {
  it('declares the push entitlement, per configuration', () => {
    // A Debug build's token is a sandbox token and is invalid against Apple's
    // production gateway; a Release build's is the reverse. Pinning either
    // value in the entitlements file silently breaks one of the two.
    expect(project).toContain('aps-environment: $(APS_ENVIRONMENT)');
    expect(project).toMatch(/Debug:\s*\n\s*APS_ENVIRONMENT: development/);
    expect(project).toMatch(/Release:\s*\n\s*APS_ENVIRONMENT: production/);
  });

  it('does not declare a background mode it never uses', () => {
    // `remote-notification` is for silent pushes. This app sends none, and a
    // declared-but-unused background mode is something review looks for.
    const modes = /UIBackgroundModes:\s*\n((?:\s+- .*\n)+)/.exec(project);
    expect(modes, 'UIBackgroundModes must still be declared').not.toBeNull();
    expect(modes![1]).toContain('- audio');
    expect(modes![1]).not.toContain('remote-notification');
    expect(modes![1]).not.toContain('voip');
  });

  it('asks for no new usage description', () => {
    // Notifications need none. A usage string for something the app does not
    // do is its own rejection.
    expect(project).not.toContain('NSUserTrackingUsageDescription');
  });
});

describe('what the app reads about the device', () => {
  it('never reads the device name', () => {
    // Since iOS 16 `UIDevice.current.name` returns the model unless the app
    // holds an entitlement for it, so asking buys nothing and reads as an app
    // trying to identify the hardware.
    expect(filesMatching(/UIDevice\.current\.name/)).toEqual([]);
  });

  it('never reads a system device identifier', () => {
    expect(filesMatching(/identifierForVendor/)).toEqual([]);
    expect(filesMatching(/advertisingIdentifier|ASIdentifierManager|AppTrackingTransparency/)).toEqual([]);
  });

  it('identifies an install with a UUID it generated itself', () => {
    const controller = files.find((f) => f.path === 'Core/Push/PushController.swift')!.text;
    // Both of these are code, not prose, so the stripped text still has them.
    expect(controller).toContain('UUID().uuidString');
    expect(controller).toContain('push.deviceId');
  });
});

describe('the operator stays in control', () => {
  it('can turn every notification off from inside the app', () => {
    const settings = files
      .find((f) => f.path === 'Features/Settings/NotificationSettingsView.swift')!.text;
    expect(settings).toContain('pushMuteAll');
    expect(settings).toContain('pushScopeNone');
  });

  it('is sent to iOS Settings when the prompt is spent', () => {
    const settings = files
      .find((f) => f.path === 'Features/Settings/NotificationSettingsView.swift')!.text;
    expect(settings).toContain('openSystemSettings');
    const controller = files.find((f) => f.path === 'Core/Push/PushController.swift')!.text;
    expect(controller).toContain('UIApplication.openSettingsURLString');
  });

  it('has this phone forgotten when they sign out', () => {
    const state = files.find((f) => f.path === 'App/AppState.swift')!.text;
    // Before the session is revoked: the unregister call is authenticated.
    const signOut = state.slice(state.indexOf('func signOut()'));
    const unregisterAt = signOut.indexOf('PushController.shared.signOut()');
    const logOutAt = signOut.indexOf('api.logOut()');
    expect(unregisterAt).toBeGreaterThan(-1);
    expect(unregisterAt).toBeLessThan(logOutAt);
  });
});
