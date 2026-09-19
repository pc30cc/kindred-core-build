/**
 * The app's accessibility identifiers and the UI tests' copy of them.
 *
 * A UI test target links against nothing of the app — it drives it from
 * outside, as a separate process — so the identifiers exist twice: once in
 * `Sources/DesignSystem/Accessibility.swift`, which the app compiles, and once
 * in `UITests/UITestCase.swift`, which the tests compile. Renaming one and not
 * the other still builds. It fails much later, as a UI test timing out looking
 * for an element that is right there under a different name, and the message
 * says nothing about why.
 *
 * This is the cheap version of that failure: both files are read and the two
 * lists have to match exactly.
 *
 * The second half is the other drift — an identifier that no view carries.
 * `app.buttons["inbox.search"]` on an element that never got the modifier is
 * the same ten-minute timeout, so every declared identifier has to be applied
 * somewhere in the app's sources.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const APP = 'ios/WebyarNative';
const DECLARATION = join(APP, 'Sources/DesignSystem/Accessibility.swift');
const MIRROR = join(APP, 'UITests/UITestCase.swift');

/** `static let name = "value"` and `static func name(...) -> String { "prefix\(…)" }`. */
function identifiers(source: string): Record<string, string> {
  const found: Record<string, string> = {};
  for (const [, name, value] of source.matchAll(/static\s+let\s+(\w+)\s*=\s*"([^"]+)"/g)) {
    found[name] = value;
  }
  // A computed one contributes its literal prefix, which is the part that has
  // to agree: "settings.workspace.\(id)" -> "settings.workspace."
  for (const [, name, prefix] of source.matchAll(
    /static\s+func\s+(\w+)\s*\([^)]*\)\s*->\s*String\s*\{\s*"([^"\\]*)\\\(/g,
  )) {
    found[name] = prefix;
  }
  return found;
}

/** Every Swift file under a directory, recursively. */
function swiftFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return swiftFiles(path);
    return entry.name.endsWith('.swift') ? [path] : [];
  });
}

describe('accessibility identifiers', () => {
  const declared = identifiers(readFileSync(DECLARATION, 'utf8'));
  const mirrored = identifiers(readFileSync(MIRROR, 'utf8'));

  it('declares the identifiers it is meant to declare', () => {
    // A guard on the guard: an empty parse would make everything below pass.
    expect(Object.keys(declared).length).toBeGreaterThanOrEqual(5);
  });

  it('the UI tests use the same names for the same things', () => {
    expect(mirrored).toEqual(declared);
  });

  it('every declared identifier is applied to a view', () => {
    const sources = swiftFiles(join(APP, 'Sources'))
      .filter((path) => path !== DECLARATION)
      .map((path) => readFileSync(path, 'utf8'))
      .join('\n');

    const unused = Object.keys(declared).filter(
      (name) => !new RegExp(`accessibilityIdentifier\\(\\s*A11y\\.${name}\\b`).test(sources),
    );
    expect(unused).toEqual([]);
  });

  it('no view hard-codes an identifier instead of naming it', () => {
    // `.accessibilityIdentifier("inbox.search")` compiles and works, and is
    // exactly the thing that drifts: it is invisible to the check above.
    const offenders = swiftFiles(join(APP, 'Sources')).filter((path) =>
      /accessibilityIdentifier\(\s*"/.test(readFileSync(path, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });
});
