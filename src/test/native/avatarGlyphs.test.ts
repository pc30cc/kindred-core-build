/**
 * The owner's rule in the native and desktop apps (2026-10-24): a teammate
 * without a photo (an operator, a colleague, an assignee, the operator
 * themself) is the platform's person silhouette and a workspace without a
 * logo is the platform's shop front. Never initials, never a workspace's
 * first letter. Visitors and contacts keep their own faces (OS mark, tinted
 * person) and are not checked here.
 *
 * The apps cannot import the web's modules, so each carries its own copy of
 * the two glyphs: the iPhone and Mac apps (one Swift file, kept identical),
 * Android (Compose path data), the Windows app (XAML path markup) and the
 * older Electron app in `windows/`. This holds every copy to the canonical
 * paths point for point, whatever form it is written in, and then checks
 * that the places a teammate or a workspace is drawn use them and that no
 * initials code has come back. What each app draws at run time is tested in
 * the app's own suite (AvatarGlyphsTest.kt, AvatarGlyphsTests.cs,
 * AvatarGlyphTests.swift).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  PERSON_GLYPH as ELECTRON_PERSON,
  WORKSPACE_GLYPH as ELECTRON_WORKSPACE,
  avatarFace,
  glyphBox,
} from '../../../windows/src/renderer/src/components/avatarGlyphs';

/** The platform's two glyphs, 24 × 24, as designed (fill currentColor, one path each). */
const CANONICAL = {
  person:
    'M12 3a4.5 4.5 0 1 1 0 9 4.5 4.5 0 0 1 0-9zm0 10.75c-4.6 0-8 2.3-8 5.25 0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2 0-2.95-3.4-5.25-8-5.25z',
  workspace:
    'M6.6 3h10.8q.9 0 1.38.83L21.5 8.5A2.375 2.375 0 0 1 20.25 10.59v8.16A2.25 2.25 0 0 1 18 21H6a2.25 2.25 0 0 1-2.25-2.25v-8.16A2.375 2.375 0 0 1 2.5 8.5l2.72-4.67Q5.7 3 6.6 3zm-.85 7.71v8.04q0 .25.25.25h4v-2.75a2 2 0 0 1 4 0V19h4q.25 0 .25-.25v-8.04A2.375 2.375 0 0 1 16.75 8.5a2.375 2.375 0 0 1-4.75 0 2.375 2.375 0 0 1-4.75 0 2.375 2.375 0 0 1-1.5 2.21z',
} as const;

type Segment = { cmd: 'M' | 'L' | 'Q' | 'C' | 'A' | 'Z'; args: number[] };

/** Any SVG path (compact or expanded, relative or absolute) as absolute segments. */
function absolute(d: string): Segment[] {
  const tokens = d.match(/[MmLlHhVvCcQqAaZz]|-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/g) ?? [];
  const out: Segment[] = [];
  let i = 0;
  let cmd = '';
  let x = 0;
  let y = 0;
  let sx = 0;
  let sy = 0;
  const num = () => Number(tokens[i++]);
  while (i < tokens.length) {
    if (/[a-z]/i.test(tokens[i])) cmd = tokens[i++];
    const rel = cmd === cmd.toLowerCase();
    const px = (v: number) => (rel ? x + v : v);
    const py = (v: number) => (rel ? y + v : v);
    switch (cmd.toUpperCase()) {
      case 'M': {
        x = px(num()); y = py(num()); sx = x; sy = y;
        out.push({ cmd: 'M', args: [x, y] });
        cmd = rel ? 'l' : 'L';
        break;
      }
      case 'L': { x = px(num()); y = py(num()); out.push({ cmd: 'L', args: [x, y] }); break; }
      case 'H': { x = px(num()); out.push({ cmd: 'L', args: [x, y] }); break; }
      case 'V': { y = py(num()); out.push({ cmd: 'L', args: [x, y] }); break; }
      case 'Q': {
        const c = [px(num()), py(num())];
        const e = [px(num()), py(num())];
        [x, y] = e;
        out.push({ cmd: 'Q', args: [...c, ...e] });
        break;
      }
      case 'C': {
        const c1 = [px(num()), py(num())];
        const c2 = [px(num()), py(num())];
        const e = [px(num()), py(num())];
        [x, y] = e;
        out.push({ cmd: 'C', args: [...c1, ...c2, ...e] });
        break;
      }
      case 'A': {
        const shape = [num(), num(), num(), num(), num()];
        x = px(num()); y = py(num());
        out.push({ cmd: 'A', args: [...shape, x, y] });
        break;
      }
      case 'Z': { x = sx; y = sy; out.push({ cmd: 'Z', args: [] }); cmd = ''; break; }
      default: throw new Error(`unexpected token ${tokens[i]} in ${d}`);
    }
  }
  return out;
}

function expectSameGeometry(copy: string, canonical: string) {
  const a = absolute(copy);
  const b = absolute(canonical);
  expect(a.map((s) => s.cmd).join('')).toBe(b.map((s) => s.cmd).join(''));
  a.forEach((segment, n) => {
    segment.args.forEach((v, k) => expect(v).toBeCloseTo(b[n].args[k], 9));
  });
}

const read = (path: string) => readFileSync(path, 'utf8');

/** The string literals of a concatenation that starts right after `marker`. */
function literalsAfter(source: string, marker: RegExp, quote: '"' | "'" = '"'): string {
  const at = source.search(marker);
  expect(at, `${marker} not found`).toBeGreaterThanOrEqual(0);
  const rest = source.slice(at).replace(marker, '');
  const q = quote === '"' ? /^\s*(?:return\s+)?"([^"]*)"(\s*\+)?/ : /^\s*'([^']*)'(\s*\+)?/;
  let text = '';
  let tail = rest;
  for (;;) {
    const m = tail.match(q);
    if (!m) break;
    text += m[1];
    tail = tail.slice(m[0].length);
    if (!m[2]) break;
  }
  expect(text.length, `no string after ${marker}`).toBeGreaterThan(0);
  return text;
}

/** Code with its comments taken out, so a doc comment saying "never initials" is not code drawing them. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
}

function files(dir: string, ext: RegExp): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path, ext);
    return ext.test(name) ? [path] : [];
  });
}

/** Every `Avatar(` call's argument text (not AIAvatar, MailAvatar, OperatorAvatar…), parentheses balanced. */
function avatarCalls(source: string): string[] {
  const calls: string[] = [];
  const re = /(?<![A-Za-z.])Avatar\(/g;
  for (const m of source.matchAll(re)) {
    let depth = 0;
    let end = m.index! + m[0].length - 1;
    for (; end < source.length; end++) {
      if (source[end] === '(') depth++;
      else if (source[end] === ')' && --depth === 0) break;
    }
    calls.push(source.slice(m.index!, end + 1));
  }
  return calls;
}

const IOS_GLYPHS = 'ios/Webyar/Sources/DesignSystem/Components/AvatarGlyphs.swift';
const MAC_GLYPHS = 'macos/Webyar/DesignSystem/AvatarGlyphs.swift';
const ANDROID_GLYPHS = 'android/app/src/main/kotlin/com/platform/app/ui/components/Glyphs.kt';
const WINDOWS_GLYPHS = 'windows-native/src/Webyar.Core/Inbox/AvatarGlyphs.cs';

describe('every native copy of the avatar glyphs is the canonical design', () => {
  it('iPhone and Mac (one Swift file, kept identical)', () => {
    const swift = read(IOS_GLYPHS);
    expect(read(MAC_GLYPHS)).toBe(swift);
    expectSameGeometry(literalsAfter(swift, /case \.person:/), CANONICAL.person);
    expectSameGeometry(literalsAfter(swift, /case \.workspace:/), CANONICAL.workspace);
  });

  it('Android', () => {
    const kotlin = read(ANDROID_GLYPHS);
    expect(literalsAfter(kotlin, /const val PERSON =/)).toBe(CANONICAL.person);
    expect(literalsAfter(kotlin, /const val WORKSPACE =/)).toBe(CANONICAL.workspace);
  });

  it('Windows (XAML path markup, nonzero rule)', () => {
    const cs = read(WINDOWS_GLYPHS);
    const person = literalsAfter(cs, /PersonPath =/);
    const workspace = literalsAfter(cs, /WorkspacePath =/);
    expect(person.startsWith('F1 ')).toBe(true);
    expect(workspace.startsWith('F1 ')).toBe(true);
    expectSameGeometry(person.slice(3), CANONICAL.person);
    expectSameGeometry(workspace.slice(3), CANONICAL.workspace);
  });

  it('the Electron app in windows/', () => {
    expect(ELECTRON_PERSON).toBe(CANONICAL.person);
    expect(ELECTRON_WORKSPACE).toBe(CANONICAL.workspace);
  });

  it('the parser reads both forms alike (a guard on the guard)', () => {
    // M A A Z, then M C C L C C Z.
    expect(absolute(CANONICAL.person)).toHaveLength(11);
    expect(absolute(CANONICAL.workspace).filter((s) => s.cmd === 'A')).toHaveLength(9);
    expect(() => expectSameGeometry(CANONICAL.person, CANONICAL.workspace)).toThrow();
  });
});

describe('a teammate or a workspace without a picture never gets letters', () => {
  it('no app keeps code that makes initials', () => {
    const sources = [
      ...files('ios/Webyar/Sources', /\.swift$/),
      ...files('macos/Webyar', /\.swift$/),
      ...files('windows-native/src', /\.cs$/),
      ...files('android/app/src/main', /\.kt$/),
    ];
    const offenders = sources.filter((path) => /\binitials(Of)?\b/i.test(code(read(path))));
    expect(offenders).toEqual([]);
  });

  it('iPhone: the skeleton draws the glyphs, and every teammate and workspace avatar asks for them', () => {
    const skeleton = code(read('ios/Webyar/Sources/DesignSystem/Components/AvatarSkeleton.swift'));
    expect(skeleton).toMatch(/case \.member:\s*AvatarGlyphView\(glyph: \.person/);
    expect(skeleton).toMatch(/case \.organisation:\s*AvatarGlyphView\(glyph: \.workspace/);
    expect(skeleton).not.toMatch(/Text\(|building\.2/);

    const F = 'ios/Webyar/Sources/Features';
    // Screens that show only teammates: every avatar on them is one.
    let teammateCalls = 0;
    for (const path of [
      ...files(`${F}/Colleagues`, /\.swift$/),
      `${F}/Settings/ProfileView.swift`,
      `${F}/Chat/ConversationSheets.swift`,
    ]) {
      const calls = avatarCalls(code(read(path)));
      teammateCalls += calls.length;
      for (const call of calls) expect(call, path).toContain('subject: .member');
    }
    expect(teammateCalls).toBeGreaterThanOrEqual(5);
    // Mixed screens: the avatar with this picture is a teammate's or a workspace's.
    const expectations: [string, string, string][] = [
      [`${F}/Settings/SettingsView.swift`, 'profile?.avatarURL', '.member'],
      [`${F}/Settings/SettingsView.swift`, 'workspace.logoURL', '.organisation'],
      [`${F}/Chat/ChatView.swift`, 'message.senderAvatar', '.member'],
      [`${F}/Support/SupportComponents.swift`, 'appState.myAvatarURL', '.member'],
      [`${F}/Support/SupportComponents.swift`, 'bubble.item?.senderAvatar', '.member'],
      [`${F}/Support/SupportComponents.swift`, 'imageURL: avatarURL', '.organisation'],
    ];
    for (const [path, picture, subject] of expectations) {
      const calls = avatarCalls(code(read(path))).filter((call) => call.includes(picture));
      expect(calls.length, `${path}: ${picture}`).toBeGreaterThan(0);
      for (const call of calls) expect(call, `${path}: ${picture}`).toContain(`subject: ${subject}`);
    }
    const card = code(read(`${F}/Support/RequesterCardView.swift`));
    expect(card).toContain('AvatarGlyphView(glyph: .workspace');
    expect(card).not.toContain('building.2');
  });

  it('Mac: an operator is the person glyph and the workspace header and list are the workspace mark', () => {
    const components = code(read('macos/Webyar/DesignSystem/Components.swift'));
    expect(components).toMatch(/case \.operator:\s*Self\.member\(size: size\)/);
    expect(components).toMatch(/static func member\(size: CGFloat\)[\s\S]*?AvatarGlyphView\(glyph: \.person/);
    expect(components).toMatch(/struct WorkspaceMark[\s\S]*?AvatarGlyphView\(glyph: \.workspace/);
    const shell = code(read('macos/Webyar/Features/Shell/ShellView.swift'));
    const header = shell.slice(shell.indexOf('struct WorkspaceHeader'), shell.indexOf('struct AccountCorner'));
    expect(header).toContain('WorkspaceMark(logoURL: app.workspace?.logoUrl');
    expect(header).not.toContain('BrandMark');
    expect(shell).toContain('isWorkspace: true, logoURL: w.logoUrl');
    expect(shell).not.toContain('"building.2"');
  });

  it('Android: teammates and workspaces fall back to the glyphs, never to letters or an empty circle', () => {
    const avatar = code(read('android/app/src/main/kotlin/com/platform/app/ui/components/Avatar.kt'));
    const operator = avatar.slice(avatar.indexOf('fun OperatorAvatar('), avatar.indexOf('fun WorkspaceAvatar('));
    expect(operator).toContain('QuietFace(size, Glyph.Person');
    const workspace = avatar.slice(avatar.indexOf('fun WorkspaceAvatar('), avatar.indexOf('internal fun personBox('));
    expect(workspace).toContain('QuietFace(size, Glyph.Workspace');
    // The old flag that drew an empty circle for a workspace is gone.
    expect(avatar).not.toMatch(/person:\s*Boolean|figure:\s*Boolean/);
    const main = files('android/app/src/main', /\.kt$/).map((path) => code(read(path))).join('\n');
    expect(main).not.toMatch(/person\s*=\s*false/);
    expect(code(read('android/app/src/main/kotlin/com/platform/app/feature/settings/SettingsScreen.kt'))).toContain(
      'WorkspaceAvatar(logoUrl = workspace.logoUrl',
    );
  });

  it('Windows: an operator is the person path, the header and the requester card are the workspace mark', () => {
    const avatar = code(read('windows-native/src/Webyar.App/Controls/Avatar.xaml.cs'));
    expect(avatar).toMatch(/Kind is "operator"\)\s*\{[^}]*AvatarGlyphs\.PersonPath/);
    expect(code(read('windows-native/src/Webyar.App/Controls/WorkspaceMark.xaml.cs'))).toContain('AvatarGlyphs.WorkspacePath');
    expect(read('windows-native/src/Webyar.App/Views/ShellPage.xaml')).toContain('<controls:WorkspaceMark x:Name="WorkspaceLogo"');
    const shell = code(read('windows-native/src/Webyar.App/Views/ShellPage.xaml.cs'));
    expect(shell).toContain('WorkspaceLogo.LogoUrl = current?.LogoUrl');
    expect(shell).not.toMatch(/WorkspaceLogo[^;]*AppPaths\.Icon/);
    expect(code(read('windows-native/src/Webyar.App/Controls/RequesterCardView.cs'))).toContain('new WorkspaceMark');
  });

  it('Electron: letters only ever for a visitor, and every teammate and workspace site says which it is', () => {
    for (const hasPicture of [false, true]) {
      expect(avatarFace('person', hasPicture)).toBe(hasPicture ? 'picture' : 'person');
      expect(avatarFace('workspace', hasPicture)).toBe(hasPicture ? 'picture' : 'workspace');
    }
    expect(avatarFace('visitor', false)).toBe('letters');
    expect(glyphBox('person', 40)).toBe(0.62);
    expect(glyphBox('workspace', 20)).toBe(0.62);

    const R = 'windows/src/renderer/src';
    const avatar = code(read(`${R}/components/Avatar.tsx`));
    // The one call that makes letters sits behind the visitor-only face.
    expect(avatar.match(/initials\(name\)/g)).toHaveLength(1);
    expect(avatar).toMatch(/face === 'letters' \? \(\s*initials\(name\)/);

    const sites: [string, string, string][] = [
      [`${R}/features/colleagues/ColleaguesSection.tsx`, 'colleagueName(c)', 'person'],
      [`${R}/features/colleagues/ColleaguesSection.tsx`, 'colleagueName(colleague)', 'person'],
      [`${R}/features/shell/Shell.tsx`, 'profile?.avatar_url', 'person'],
      [`${R}/features/chat/ChatPane.tsx`, 'm.sender_avatar', 'person'],
      [`${R}/features/settings/SettingsSection.tsx`, 'account.profile?.avatar_url', 'person'],
      [`${R}/features/settings/SettingsSection.tsx`, 'w.logo_url', 'workspace'],
    ];
    for (const [path, picture, kind] of sites) {
      const calls = (read(path).match(/<Avatar\s[\s\S]*?\/>/g) ?? []).filter((tag) => tag.includes(picture));
      expect(calls.length, `${path}: ${picture}`).toBeGreaterThan(0);
      for (const call of calls) expect(call, `${path}: ${picture}`).toContain(`kind="${kind}"`);
    }
    const palette = read(`${R}/features/palette/CommandPalette.tsx`);
    expect(palette).toMatch(/avatar: \{ name: colleagueName\(c\), url: c\.avatar_url, kind: 'person' \}/);
    expect(palette).toContain('kind={item.avatar.kind}');
  });
});
