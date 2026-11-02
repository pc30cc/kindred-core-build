/**
 * The decisions in the iPhone app's push work that App Review would reject if they
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
import { parse as parseYaml } from 'yaml';

const ROOT = process.cwd();
const SOURCES = join(ROOT, 'ios', 'Webyar', 'Sources');
const PROJECT = join(ROOT, 'ios', 'Webyar', 'project.yml');

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
    // `unregisterForRemoteNotifications()` is giving the address up, which
    // needs no permission — only the register calls are held to this.
    const calls = controller.split(/(?<!un)registerForRemoteNotifications\(\)/).slice(0, -1);
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
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

  it('declares them in both apps, WebYar and RESPOK', () => {
    // The Respok target (project.yml) is a second app with its own
    // entitlements and Info.plist: the same rules hold for it.
    type Target = {
      type: string;
      info: { properties: Record<string, unknown> };
      entitlements?: { properties: Record<string, unknown> };
      settings: { configs?: Record<string, Record<string, unknown>> };
    };
    const targets = (parseYaml(project) as { targets: Record<string, Target> }).targets;
    const apps = Object.entries(targets).filter(([, target]) => target.type === 'application');
    expect(apps.map(([name]) => name).sort()).toEqual(['Respok', 'Webyar']);
    for (const [name, target] of apps) {
      expect(target.entitlements?.properties, name).toEqual({ 'aps-environment': '$(APS_ENVIRONMENT)' });
      expect(target.settings.configs?.Debug?.APS_ENVIRONMENT, name).toBe('development');
      expect(target.settings.configs?.Release?.APS_ENVIRONMENT, name).toBe('production');
      // `audio` keeps a call alive with the screen locked; `voip` is the
      // colleague call's ring (PushKit), which both apps have.
      expect(target.info.properties.UIBackgroundModes, name).toEqual(['audio', 'voip']);
      expect(target.info.properties, name).not.toHaveProperty('NSUserTrackingUsageDescription');
    }
  });

  it('does not declare a background mode it never uses', () => {
    // `remote-notification` is for silent pushes. This app sends none, and a
    // declared-but-unused background mode is something review looks for.
    const modes = /UIBackgroundModes:\s*\n((?:\s+- .*\n)+)/.exec(project);
    expect(modes, 'UIBackgroundModes must still be declared').not.toBeNull();
    expect(modes![1]).toContain('- audio');
    expect(modes![1]).not.toContain('remote-notification');
    // `voip` is used: a PushKit registry asks for VoIP pushes and every one
    // becomes a CallKit call (below). Without both, iOS ends the app.
    expect(modes![1]).toContain('- voip');
    expect(filesMatching(/PKPushRegistry\(/)).toEqual(['Core/Push/VoIPPushes.swift']);
    expect(filesMatching(/reportNewIncomingCall\(/)).toEqual(['Features/Calls/TeamCalls/CallManager.swift']);
  });

  it('asks for no new usage description', () => {
    // Notifications need none. A usage string for something the app does not
    // do is its own rejection.
    expect(project).not.toContain('NSUserTrackingUsageDescription');
  });
});

describe('a colleague call rings through PushKit and CallKit', () => {
  const voip = () => files.find((f) => f.path === 'Core/Push/VoIPPushes.swift')!.text;
  const manager = () => files.find((f) => f.path === 'Features/Calls/TeamCalls/CallManager.swift')!.text;

  it('has its registry made before any scene, in didFinishLaunching', () => {
    // A VoIP push that launches the app is delivered once a registry with a
    // delegate asks for it; a scene's `.task` may never run on such a launch.
    const delegate = files.find((f) => f.path === 'App/AppDelegate.swift')!.text;
    const launch = delegate.slice(delegate.indexOf('didFinishLaunchingWithOptions'));
    expect(launch.slice(0, launch.indexOf('return true'))).toContain('VoIPPushes.shared.start()');
    expect(voip()).toMatch(/PKPushRegistry\(queue: \.main\)/);
  });

  it('reports every VoIP push to CallKit before the push is done with', () => {
    // iOS 13+: a VoIP push not reported to CallKit ends the app, and after a
    // few, PushKit stops delivering to it.
    const handler = voip().slice(voip().indexOf('didReceiveIncomingPushWith'));
    const reportAt = handler.indexOf('CallManager.shared.reportIncoming(');
    const completionAt = handler.indexOf('completion()');
    expect(reportAt).toBeGreaterThan(-1);
    expect(reportAt).toBeLessThan(completionAt);
    // Synchronously: no task between the push and the report.
    expect(handler.slice(0, reportAt)).not.toMatch(/Task\s*\{|await /);
    // And the report itself is the first CallKit call in `reportIncoming`,
    // before anything decides whether the ring is worth keeping.
    const report = manager().slice(manager().indexOf('func reportIncoming('));
    expect(report.indexOf('report(uuid, update)')).toBeGreaterThan(-1);
    expect(report.indexOf('report(uuid, update)')).toBeLessThan(report.indexOf('reportCall(with: uuid, endedAt: nil'));
  });

  it('never sends a call\'s handle or name as an identity', () => {
    // The handle is the call id; recents are off (docs/operations/TEAM_CALLS.md).
    expect(manager()).toContain('CXHandle(type: .generic, value: callID)');
    expect(manager()).toContain('includesCallsInRecents = false');
    expect(manager()).not.toMatch(/CXHandle\(type: \.(emailAddress|phoneNumber)/);
  });

  it('gives the VoIP address up with the session', () => {
    const controller = files.find((f) => f.path === 'Core/Push/PushController.swift')!.text;
    for (const name of ['func signOut()', 'func sessionEnded()']) {
      const body = controller.slice(controller.indexOf(name), controller.indexOf('\n    }\n', controller.indexOf(name)));
      expect(body, name).toContain('releaseVoIP()');
    }
    expect(controller).toMatch(/func releaseVoIP\(\)[\s\S]*?VoIPPushes\.shared\.listen\(false\)/);
    // Asked for only once somebody is signed in, and never on the first
    // frame's "nobody yet", which would drop the push that launched the app.
    const changed = controller.slice(controller.indexOf('func sessionChanged('));
    expect(changed.indexOf('guard signedIn else { return }')).toBeLessThan(changed.indexOf('VoIPPushes.shared.listen(true)'));
  });

  it('keeps the VoIP address through a Keychain it cannot read, and looks again on unlock', () => {
    // Before the first unlock after a restart the Keychain refuses to say;
    // that is not "signed out", and giving the address up then would stop
    // every ring until the operator opened the app.
    const follow = voip().slice(voip().indexOf('func followSession()'), voip().indexOf('func unlocked()'));
    expect(follow).toContain('TokenStore.presence()');
    const unreadable = follow.slice(follow.indexOf('case .unreadable:'));
    expect(unreadable).not.toContain('listen(');
    expect(unreadable).toContain('protectedDataDidBecomeAvailableNotification');
    expect(voip()).not.toMatch(/listen\(TokenStore\.read\(\)/);
  });

  it('draws the call screen in a window above everything the app presents', () => {
    // An overlay on the root sits under every sheet and full-screen cover,
    // and CallKit shows no in-call screen for an app in the foreground.
    const window = files.find((f) => f.path === 'Features/Calls/TeamCalls/TeamCallWindow.swift')!.text;
    expect(window).toContain('UIWindow(windowScene: scene)');
    expect(window).toContain('window.windowLevel = .alert + 1');
    expect(filesMatching(/TeamCallScreen\(manager:/)).toEqual(['Features/Calls/TeamCalls/TeamCallWindow.swift']);
    const root = files.find((f) => f.path === 'App/WebyarApp.swift')!.text;
    expect(root).toContain('TeamCallWindowAnchor(active: calls.call != nil)');
  });

  it('ends a call on the server with time to finish, and never by a cancel the caller cannot be sure of', () => {
    // CallKit's call is gone once its end action is fulfilled; a VoIP launch
    // has nothing else keeping the app running while the request goes out.
    const tell = manager().slice(manager().indexOf('private func tell('), manager().indexOf('private func stopTimers('));
    expect(tell).toContain('BackgroundGrace.run(');
    const teardown = manager().slice(manager().indexOf('private func teardown('));
    expect(teardown.slice(0, teardown.indexOf('\n    }\n'))).toMatch(/BackgroundGrace\.run\([\s\S]*leaving\?\.disconnect\(\)/);
    expect(manager()).toContain('beginBackgroundTask(withName:');
    // Every request that ends a call goes through `tell`.
    expect(filesMatching(/\.(hangUpTeamCall|declineTeamCall)\(id:/)).toEqual(['Features/Calls/TeamCalls/CallManager.swift']);
    expect(manager().match(/\.(hangUpTeamCall|declineTeamCall)\(id:/g)!.length).toBe(
      tell.match(/\.(hangUpTeamCall|declineTeamCall)\(id:/g)!.length,
    );
    // `POST /cancel` is a no-op on a call answered a moment ago; the caller's
    // hang-up is a cancel or an end, as the server finds the call.
    const client = files.find((f) => f.path === 'Core/Networking/APIClient.swift')!.text;
    expect(client).not.toMatch(/team-calls\/[^"]*\/cancel"/);
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
