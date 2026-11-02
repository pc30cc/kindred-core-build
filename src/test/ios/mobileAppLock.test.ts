/**
 * The iPhone app's side of the mobile app as a plan feature
 * (docs/operations/MOBILE_APP_PLAN.md, "The apps"), where reversing a decision
 * still builds and runs:
 *
 * - the lock card never links to, names or hints at a website or a purchase
 *   (App Store Review Guidelines 3.1.1 and 3.1.3(f); owner's choice,
 *   2026-11-02) — a rejection, not a crash, and it arrives a week later;
 * - the lock fails OPEN, unlike every other plan gate in the app: only an
 *   explicit `false` locks, so a network blip never locks a team out;
 * - while locked, the app's own work for the workspace stops, a tapped
 *   notification does nothing, and a colleague's ring for that workspace is
 *   reported to CallKit and ended at once — while the push device stays
 *   registered.
 *
 * There is no Xcode here: what can be read from the sources is read; the
 * behaviour itself is pinned by ios/Webyar/Tests/App/MobileAppLockTests.swift.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const SOURCES = join(ROOT, 'ios', 'Webyar', 'Sources');

/** Swift with its comments removed: the reasons written beside the code name what it must not do. */
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

function swiftFiles(dir: string): Array<{ path: string; text: string }> {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return swiftFiles(full);
    return entry.name.endsWith('.swift')
      ? [{ path: full.slice(SOURCES.length + 1), text: code(readFileSync(full, 'utf8')) }]
      : [];
  });
}

const files = swiftFiles(SOURCES);
const source = (path: string): string => {
  const file = files.find((f) => f.path === path);
  if (!file) throw new Error(`${path} is missing`);
  return file.text;
};
const filesMatching = (pattern: RegExp) => files.filter((f) => pattern.test(f.text)).map((f) => f.path).sort();

/** The body of `func name(` in a Swift file: from its signature to the first line that closes it at its indentation. */
function body(text: string, signature: string): string {
  const start = text.indexOf(signature);
  expect(start, signature).toBeGreaterThan(-1);
  const indent = /\n( *)[^\n]*$/.exec(text.slice(0, start))?.[1] ?? '';
  const end = text.indexOf(`\n${indent}}\n`, start);
  return text.slice(start, end === -1 ? undefined : end);
}

/** A `static func name(_ l: Language) -> String` of Strings.swift, language → text. */
function strings(name: string): Record<string, string> {
  const swift = readFileSync(join(SOURCES, 'Localization', 'Strings.swift'), 'utf8');
  const fn = swift.match(new RegExp(`static func ${name}\\(_ l: Language\\) -> String \\{([\\s\\S]*?)\\n {4}\\}`));
  expect(fn, name).not.toBeNull();
  const cases: Record<string, string> = {};
  for (const m of fn![1].matchAll(/case \.(\w+): "(.*)"/g)) cases[m[1]] = m[2];
  return cases;
}

/** The contract's table row for a string, language → text. */
function contract(name: string): Record<string, string> {
  const doc = readFileSync(join(ROOT, 'docs', 'operations', 'MOBILE_APP_PLAN.md'), 'utf8');
  const row = doc.split('\n').find((line) => line.startsWith(`| \`${name}\``));
  expect(row, name).toBeDefined();
  const [, fa, en, tr, ar] = row!.split('|').map((cell) => cell.trim()).filter(Boolean);
  return { fa, en, tr, ar };
}

const LOCK_STRINGS = ['appLockedTitle', 'appLockedBody', 'appLockedAskOwner', 'appLockedSwitchWorkspace'];

/** A website, a store, a price or a purchase, in the app's four languages. */
const SALES_WORDS = [
  /\b(web ?site|site|url|link|buy|purchase|upgrade|price|pricing|pay|payment|subscribe|subscription|billing|store|checkout)\b/i,
  /سایت|وب‌سایت|خرید|ارتقا|قیمت|پرداخت|اشتراک|لینک/,
  /web sitesi|satın|yükselt|fiyat|ödeme|abone/i,
  /الموقع|شراء|ترقية|سعر|الدفع|اشتراك|رابط/,
];

describe('the lock card on the iPhone', () => {
  const lock = source('App/AppLock.swift');
  const card = body(lock, 'struct AppLockView: View {');

  it('says the contract\'s four lines, in every language, word for word', () => {
    for (const name of LOCK_STRINGS) {
      expect(strings(name), name).toEqual(contract(name));
    }
  });

  it('names no website, price or purchase in any of them', () => {
    for (const name of LOCK_STRINGS) {
      for (const [language, text] of Object.entries(strings(name))) {
        for (const words of SALES_WORDS) expect(text, `${name}.${language}`).not.toMatch(words);
      }
    }
  });

  it('draws only those lines, the mark, the workspace and sign out — no link, no button to a site', () => {
    for (const name of LOCK_STRINGS) expect(card).toContain(`Str.${name}(language)`);
    expect(card).toContain('Str.signOut(language)');
    expect(card).toContain('BrandMark(');
    // The way off the card a non-owner is given is the owner, nothing else.
    expect(card).toMatch(/if !appState\.isWorkspaceOwner \{\s*Text\(Str\.appLockedAskOwner\(language\)\)/);
    // A second workspace only when there is one.
    expect(card).toMatch(/if appState\.workspaces\.count > 1 \{\s*PrimaryButton\(title: Str\.appLockedSwitchWorkspace\(language\)\)/);
    // Nothing opens a page, a store or a site, from anything in the file.
    expect(lock).not.toMatch(
      /openURL|\bLink\(|UIApplication\.shared\.open|SFSafari|StoreKit|SKStore|AppStore\.|websiteURL|siteWebsiteURL|websiteLabel|signInWebsiteLink|SettingsStr\.website|supportURL|billing|upgrade|purchase/i,
    );
    // And no words of its own beside the shared ones.
    expect(lock).not.toMatch(/Text\("/);
  });

  it('never carries the Android-only lines that point at the website', () => {
    expect(filesMatching(/appLockedVisitWebsite|appLockedOpenWebsite/)).toEqual([]);
  });

  it('draws the brand mark and the workspace mark, never a letter', () => {
    expect(card).toContain('subject: .organisation');
    expect(card).not.toMatch(/\.prefix\(1\)|\.first\b.*uppercased|initials/i);
  });
});

describe('the lock fails open', () => {
  const rule = source('Core/Models/MobileAppLock.swift');
  const state = source('App/AppState.swift');

  it('locks only on an explicit false of the plan\'s mobile_app', () => {
    expect(rule).toContain('static let mobileAppKey = "mobile_app"');
    expect(rule).toContain('features?[Self.mobileAppKey]?.value == false');
    // Loading and a failed read have no snapshot, and so no lock.
    expect(rule).toMatch(/extension EntitlementsState \{[\s\S]*?value\?\.mobileAppLocked == true/);
    // The fail-closed reading of every other gate is never used for it.
    expect(filesMatching(/featureEnabled\(\s*(?:"mobile_app"|Entitlements\.mobileAppKey|Self\.mobileAppKey)\s*\)/)).toEqual([]);
    expect(filesMatching(/mobile_app"?\]?\??\.value != true|mobileAppKey\]\?\.value != true/)).toEqual([]);
  });

  it('is the app\'s one lock, read from the snapshot of the workspace on screen', () => {
    const locked = body(state, 'var isAppLocked: Bool {');
    expect(locked).toContain('entitlements.mobileAppLocked');
    expect(locked).toContain('let workspaceID = selectedWorkspace?.id');
    // That workspace's own snapshot, never the last workspace's still in hand.
    expect(locked).toContain('let planLocked = entitlements.mobileAppLocked');
    expect(locked).toContain('let planIsThisWorkspace = planWorkspaceID == workspaceID');
    expect(locked).toContain('return planIsThisWorkspace && planLocked');
    // Whose snapshot it is, observed like the snapshot itself: a view that
    // read the lock while it still named another workspace must be told when
    // it moves on, or the card never shows (seen on the simulator).
    expect(state).toMatch(/\n    private var planWorkspaceID: String\? = nil/);
    expect(state).not.toMatch(/@ObservationIgnored private var planWorkspaceID/);
    // Applied whenever the snapshot, the session or the workspace changes.
    expect(state).toMatch(/private\(set\) var entitlements: EntitlementsState = \.loading \{\s*didSet \{ lockChanged\(\) \}/);
    expect(body(state, 'private func scopeChanged()')).toContain('lockChanged()');
  });

  it('remembers a workspace\'s lock only from a plan that was read, and forgets it with the session', () => {
    const load = body(state, 'func loadPlan(');
    const recordAt = load.indexOf('MobileAppLock.record(');
    expect(recordAt).toBeGreaterThan(-1);
    expect(recordAt, 'only in the read that succeeded').toBeLessThan(load.indexOf('} catch {'));
    expect(state.match(/MobileAppLock\.record\(/g)).toHaveLength(1);
    expect(body(state, 'private func reset(')).toContain('MobileAppLock.clear()');
  });

  it('reads the plan again when the app comes forward, failed or not', () => {
    const refresh = body(state, 'func refreshIfStale()');
    expect(refresh).toContain('loadPlan(');
    expect(refresh).not.toMatch(/if case \.failed = entitlements/);
    // And every other workspace remembered as locked, so a plan switched
    // back on there does not go on ending its rings here.
    expect(refresh).toMatch(/for workspaceID in MobileAppLock\.lockedWorkspaceIDs\(\) where workspaceID != selectedWorkspace\?\.id/);
    expect(refresh).toContain('MobileAppLock.recheck(workspaceID: workspaceID, api: api)');
  });

  it('asks a remembered lock again before it stops anything, and a recheck only ever forgets', () => {
    const recheck = body(rule, 'static func recheck(');
    expect(recheck).toContain('guard let snapshot = try? await api.entitlements(workspaceID: workspaceID) else { return nil }');
    expect(recheck).toContain('record(workspaceID: workspaceID, locked: false, defaults: defaults)');
    expect(recheck).not.toMatch(/locked: true|locked: snapshot/);
  });
});

describe('while the app is locked', () => {
  const state = source('App/AppState.swift');

  it('takes the live app off screen, so no screen of it polls or takes a tap', () => {
    const lock = source('App/AppLock.swift');
    const root = body(lock, 'struct SignedInRoot: View {');
    expect(root).toMatch(/if locked \{\s*AppLockView\(picture: picture\)[\s\S]*?\} else \{\s*MainTabView\(initial: appState\.selectedTab\)/);
    expect(root).toContain('.onChange(of: wantsLock, initial: true)');
    expect(root).toContain('Self.showsLock(appLocked: appState.isAppLocked, visitorCallOnScreen: visitorCalls.isOn)');
    // The shell is made in one place only, under the lock.
    expect(filesMatching(/MainTabView\(initial:/)).toEqual(['App/AppLock.swift']);
    expect(source('App/WebyarApp.swift')).toMatch(/case \.signedIn:\s*SignedInRoot\(\)/);
  });

  it('stops realtime and upkeep for the workspace, and keeps the push device registered', () => {
    const changed = body(state, 'private func lockChanged()');
    expect(changed).toContain('SyncCoordinator.shared.setSuspended(locked)');
    expect(changed).toContain('PushController.shared.appLocked = locked');
    expect(changed).not.toMatch(/unregister|signOut|sessionEnded|releaseVoIP|listen\(false\)/);
    const sync = source('Core/Sync/SyncCoordinator.swift');
    expect(body(sync, 'private func startRealtime()')).toMatch(/guard [^\n]*!isSuspended/);
    expect(body(sync, 'private func scheduleUpkeep()')).toMatch(/guard [^\n]*!isSuspended/);
    expect(body(sync, 'func setSuspended(')).toContain('stopRealtime()');
  });

  it('does nothing with a tapped notification or its buttons, and keeps nothing for later', () => {
    const push = source('Core/Push/PushController.swift');
    const handle = body(push, 'func handle(_ response: PushResponse) async');
    const guardAt = handle.indexOf('guard await tapMayAct(on: target) else { return }');
    expect(guardAt).toBeGreaterThan(-1);
    for (const effect of ['noteArrival(', 'pendingOpen = target', 'api.markSeen(', 'api.send(', 'api.sendTeamMessage(']) {
      expect(guardAt, effect).toBeLessThan(handle.indexOf(effect));
    }
    const mayAct = body(push, 'func tapMayAct(on target: PushTarget) async -> Bool');
    expect(mayAct).toContain('guard !appLocked else { return false }');
    // A remembered lock is asked again; only an explicit false stops the tap.
    expect(mayAct).toContain('MobileAppLock.recheck(workspaceID: target.workspaceID, api: api)');
    expect(mayAct).toContain('stillLocked != true && !appLocked');
    expect(push).toMatch(/var appLocked = false \{\s*didSet \{\s*guard appLocked else \{ return \}\s*pendingOpen = nil\s*if !oldValue \{ applyBadge\(0\) \}/);
  });

  it('never lets a stale memory swallow a notification shown in the app', () => {
    const push = source('Core/Push/PushController.swift');
    const presentation = body(push, 'func presentation(for arrival: PushArrival) -> UNNotificationPresentationOptions');
    expect(presentation).not.toContain('MobileAppLock');
    // Locked, only the open workspace's own news is held back, and nothing is read.
    expect(presentation).toMatch(
      /if appLocked \{\s*if let target = arrival\.target, !target\.isSupport, target\.workspaceID == workspaceID \{ return \[\] \}\s*\} else \{\s*noteArrival\(arrival\)\s*\}/,
    );
  });

  it('reports a colleague\'s ring for a locked workspace to CallKit and ends it at once', () => {
    const manager = source('Features/Calls/TeamCalls/CallManager.swift');
    const report = body(manager, 'func reportIncoming(');
    const lockAt = report.indexOf('MobileAppLock.isLocked(workspaceID: ring.workspaceID)');
    expect(lockAt).toBeGreaterThan(-1);
    expect(report).toContain('ring.mayRing(');
    // Reported first, then ended — never dropped unreported.
    const reportedAt = report.indexOf('report(uuid, update)\n        guard let ring = accepted');
    expect(reportedAt).toBeGreaterThan(lockAt);
    // Decided synchronously, in the same pass as the report: no task, no wait.
    expect(report.slice(0, reportedAt)).not.toMatch(/Task\s*\{|await /);
    const ended = report.slice(reportedAt);
    expect(ended).toMatch(/guard let ring = accepted else \{\s*callKit\.provider\.reportCall\(with: uuid, endedAt: nil, reason: \.failed\)/);
    // A ring ended for a remembered lock asks that plan again, so the next one rings once it is back on.
    expect(ended.slice(0, ended.indexOf('clearEnded()'))).toContain('MobileAppLock.recheck(workspaceID: workspaceID, api: api)');
    const rule = source('Core/Models/MobileAppLock.swift');
    expect(rule).toMatch(/func mayRing\([^)]*\) -> Bool \{\s*!isExpired\(now: now\) && !holdsAudio && signedIn && !workspaceLocked/);
  });

  it('never cuts a call already on', () => {
    // The lock touches no call: nothing it runs ends, hangs up or tears one down.
    const changed = body(state, 'private func lockChanged()');
    expect(changed).not.toMatch(/CallManager|hangUp|endCall|sessionEnded/);
    expect(source('App/AppLock.swift')).not.toMatch(/CallManager/);
    // A visitor call's screen is inside the shell the lock takes away: the
    // lock waits while one is up.
    const root = body(source('App/AppLock.swift'), 'struct SignedInRoot: View {');
    expect(root).toMatch(/static func showsLock\(appLocked: Bool, visitorCallOnScreen: Bool\) -> Bool \{\s*appLocked && !visitorCallOnScreen/);
    const host = body(source('Features/Calls/CallScreen.swift'), 'struct CallHost: View {');
    expect(host).toContain('.onAppear { VisitorCallScreens.shared.opened(presence) }');
    expect(host).toContain('.onDisappear { VisitorCallScreens.shared.closed(presence) }');
    // The only place a visitor call's screen is made.
    expect(filesMatching(/CallHost\(/)).toEqual(['Features/Chat/ChatView.swift']);
  });
});
