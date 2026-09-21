/**
 * The Android app's copy of the interface's words, and the iOS app's.
 *
 * `Strings.swift` is a `switch` over `Language` rather than a set of
 * `.strings` files because the compiler then refuses to build if a language is
 * missing — a key can never ship translated in one and blank in another. The
 * Android side keeps that property by being a Kotlin `when` over the same
 * enum, which means the same copy now exists twice, in two languages, in two
 * repositories' worth of files.
 *
 * Two copies of 210 strings will drift. So the Kotlin one is GENERATED from
 * the Swift one by `scripts/android/strings-from-ios.mjs`, and this is the
 * guard that it was regenerated: it re-runs the generator and fails if what
 * comes out differs from what is committed.
 *
 * This is the same shape as `src/test/ios/accessibilityIdentifiers.test.ts`,
 * and for the same reason — it is the cheap version of a failure that would
 * otherwise surface as a Persian operator reading an English sentence, weeks
 * later, with nothing to say why.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';

const GENERATOR = 'scripts/android/strings-from-ios.mjs';
const SWIFT = 'ios/WebyarNative/Sources/Localization/Strings.swift';
const KOTLIN = 'android/app/src/main/kotlin/com/webyar/operator/i18n/Strings.kt';
const MANUAL = 'android/app/src/main/kotlin/com/webyar/operator/i18n/StringsManual.kt';

describe('Android strings are generated from the iOS ones', () => {
  it('the committed Strings.kt is what the generator produces today', () => {
    expect(existsSync(GENERATOR), `${GENERATOR} is missing`).toBe(true);
    let failure: string | null = null;
    try {
      execFileSync('node', [GENERATOR, '--check'], { encoding: 'utf8', stdio: 'pipe' });
    } catch (error) {
      const e = error as { stderr?: string; stdout?: string };
      failure = (e.stderr || e.stdout || String(error)).trim();
    }
    expect(
      failure,
      `Strings.kt is out of date with Strings.swift. Run: node ${GENERATOR}\n${failure ?? ''}`,
    ).toBeNull();
  });

  it('every string the generator refused is hand-written instead', () => {
    const kotlin = readFileSync(KOTLIN, 'utf8');
    const manual = readFileSync(MANUAL, 'utf8');

    // The generator lists what it skipped, in its own header.
    const refused = [...kotlin.matchAll(/^\/\/\s{3}([A-Za-z0-9_]+) — /gm)].map((m) => m[1]);
    expect(refused.length, 'the generated header should name what it skipped').toBeGreaterThan(0);

    const missing = refused.filter((name) => !new RegExp(`fun ${name}\\(`).test(manual));
    expect(missing, `these are in neither file: ${missing.join(', ')}`).toEqual([]);
  });

  it('every Swift string function ends up in one file or the other', () => {
    const swift = readFileSync(SWIFT, 'utf8');
    const declared = [...swift.matchAll(/^\s*static func ([A-Za-z0-9_]+)\(/gm)].map((m) => m[1]);
    expect(declared.length).toBeGreaterThan(200);

    const kotlin = readFileSync(KOTLIN, 'utf8') + readFileSync(MANUAL, 'utf8');
    const missing = declared.filter((name) => !new RegExp(`fun ${name}\\(`).test(kotlin));
    expect(
      missing,
      `Swift declares these and Android has neither a generated nor a hand-written copy: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('no generated key is silently blank in any language', () => {
    const kotlin = readFileSync(KOTLIN, 'utf8');
    const blanks = [...kotlin.matchAll(/^\s*Language\.(EN|FA|TR) -> ""$/gm)];
    expect(blanks.map((m) => m[0].trim()), 'an empty translation is the bug this file exists to prevent').toEqual([]);
  });
});
