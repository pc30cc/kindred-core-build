#!/usr/bin/env node
// Generates the Android app's Strings.kt from the iOS app's Strings.swift.
//
// WHY NOT strings.xml, which is what an Android app normally does:
//
// `Strings.swift` is a `switch` over `Language` rather than a set of
// `.strings` files on purpose, and its own comment says why — the compiler
// refuses to build if a case is missing, so a key can never ship translated
// in one language and blank in another. `strings.xml` gives exactly the
// opposite guarantee: a key missing from `values-fa` silently falls back to
// English, which is the failure the iOS design was built to prevent.
//
// The usual argument for strings.xml is that the platform resolves the user's
// locale for you. This product does not want that. `Language.swift`: "The web
// app deliberately never reads the device language — the operator picks one
// and it sticks." So the one thing strings.xml would buy is the one thing
// that must not happen.
//
// Hence a Kotlin `when` over the same enum, generated rather than transcribed,
// so the two native apps cannot drift. strings.xml keeps only what the SYSTEM
// reads: the launcher label.
//
// Usage:  node scripts/android/strings-from-ios.mjs [--check]
//         --check  exits non-zero if the committed file is out of date

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SOURCE = resolve(root, 'ios/Webyar/Sources/Localization/Strings.swift');
const TARGET = resolve(root, 'android/app/src/main/kotlin/com/platform/app/i18n/Strings.kt');
// The lines that name the product: the Iranian flavor's own source set, so
// that RESPOK's app, built from the same src/main, never carries them.
const BRAND_TARGET = resolve(root, 'android/app/src/webyar/kotlin/com/platform/app/i18n/StringsBrand.kt');

const LANGS = ['en', 'fa', 'tr'];

function parse(swift) {
  const lines = swift.split('\n');
  const simple = [];
  const manual = [];

  for (let i = 0; i < lines.length; i++) {
    const signature = lines[i].match(/^\s*static func ([A-Za-z0-9_]+)\((.*)\) -> String \{\s*$/);
    if (!signature) continue;
    const [, name, params] = signature;

    // Collect the doc comment immediately above, so the generated file carries
    // the reasoning rather than stripping it.
    const doc = [];
    for (let d = i - 1; d >= 0 && /^\s*\/\/\//.test(lines[d]); d--) {
      doc.unshift(lines[d].replace(/^\s*\/\/\/ ?/, ''));
    }

    // Find the end of the function by brace depth.
    let depth = 1, end = i;
    for (let j = i + 1; j < lines.length && depth > 0; j++) {
      depth += (lines[j].match(/\{/g) || []).length;
      depth -= (lines[j].match(/\}/g) || []).length;
      end = j;
    }
    const body = lines.slice(i + 1, end);

    if (params !== '_ l: Language') {
      manual.push({ name, params, reason: 'takes more than a language' });
      i = end;
      continue;
    }

    // Only a bare `switch l { case ...: "literal" }` is safe to translate
    // mechanically. Anything with a `let`, a `return` or interpolation is
    // logic, not copy.
    const cases = {};
    let clean = true;
    for (const raw of body) {
      const line = raw.trim();
      if (!line || line === 'switch l {' || line === '}') continue;
      const m = line.match(/^case ((?:\.[a-z]+,\s*)*\.[a-z]+):\s*"(.*)"$/);
      if (!m) { clean = false; break; }
      const value = m[2];
      if (value.includes('\\(')) { clean = false; break; }
      for (const key of m[1].split(',').map(s => s.trim().replace(/^\./, ''))) cases[key] = value;
    }
    if (!clean || LANGS.some(l => cases[l] === undefined)) {
      manual.push({ name, params, reason: clean ? 'a language is missing' : 'not a plain literal switch' });
      i = end;
      continue;
    }

    simple.push({ name, doc, cases });
    i = end;
  }
  return { simple, manual };
}

// The body of a Swift string literal, as the string it denotes. Swift
// writes a zero-width non-joiner as `\u{200C}`; copied through as text, a
// Persian sentence showed the escape itself — «وب\u{200C}یار» on screen.
function swiftUnescape(value) {
  return value.replace(/\\(u\{([0-9a-fA-F]{1,8})\}|[\\"'nrt0])/g, (_, esc, hex) => {
    if (hex) return String.fromCodePoint(parseInt(hex, 16));
    return { '\\': '\\', '"': '"', "'": "'", n: '\n', r: '\r', t: '\t', 0: '\0' }[esc];
  });
}

// A Kotlin literal for a string.
function kotlinLiteral(value) {
  return swiftUnescape(value)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\$/g, '\\$')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

// The Iranian edition's name in any spelling (shared/nativeAppBrands.ts's mark):
// a line that says it is that brand's copy, not shared copy. The Turkish
// "Web yardım" is a word, not the name.
const BRAND_MARK = /[Ww][Ee][Bb] ?[Yy][Aa][Rr](?!\p{Ll})|وب[‌ ]?یار|وبیار/u;

// Whether an entry's text names the product: it then belongs to the flavor
// that is that product (BRAND_TARGET), never to the shared Strings.kt that
// RESPOK's app is built from too.
function namesBrand(entry) {
  return LANGS.some((l) => BRAND_MARK.test(swiftUnescape(entry.cases[l])));
}

function renderEntries(out, entries) {
  for (const entry of entries) {
    if (entry.doc.length === 1) {
      out.push(`    /** ${entry.doc[0]} */`);
    } else if (entry.doc.length > 1) {
      out.push('    /**');
      for (const line of entry.doc) out.push(line ? `     * ${line}` : '     *');
      out.push('     */');
    }
    out.push(`    fun ${entry.name}(l: Language): String = when (l) {`);
    for (const lang of LANGS) {
      out.push(`        Language.${lang.toUpperCase()} -> "${kotlinLiteral(entry.cases[lang])}"`);
    }
    out.push('    }');
    out.push('');
  }
  if (out[out.length - 1] === '') out.pop();
}

function render({ simple, manual }) {
  const shared = simple.filter((e) => !namesBrand(e));
  const branded = simple.filter(namesBrand);
  for (const e of shared) {
    if (e.doc.some((line) => BRAND_MARK.test(line))) {
      throw new Error(`${e.name}: its doc comment in Strings.swift names the brand; Strings.kt is shared by both apps`);
    }
  }

  const out = [];
  out.push('package com.platform.app.i18n');
  out.push('');
  out.push('// GENERATED by scripts/android/strings-from-ios.mjs — do not edit by hand.');
  out.push("// Source of truth: the iOS app's Sources/Localization/Strings.swift");
  out.push('//');
  out.push('// A `when` rather than strings.xml, for the reason the Swift original is a');
  out.push('// `switch` rather than .strings files: the compiler refuses to build if a');
  out.push('// language is missing, so a key can never ship translated in one and blank in');
  out.push('// another. strings.xml would silently fall back to English instead. And the');
  out.push('// product never reads the device language — the operator picks one and it');
  out.push('// sticks — so locale resolution is not wanted here either.');
  out.push('//');
  out.push(`// ${simple.length} of ${simple.length + manual.length} strings are generated.`);
  if (manual.length) {
    out.push('// These are hand-written in StringsManual.kt because they are logic rather');
    out.push('// than copy:');
    for (const m of manual) out.push(`//   ${m.name} — ${m.reason}`);
  }
  if (branded.length) {
    out.push('//');
    out.push('// These name the product, so they are not here: this file is in both apps.');
    out.push("// The iOS app's wording is in the Iranian flavor's StringsBrand.kt");
    out.push("// (src/<flavor>/kotlin/.../i18n); each flavor's BrandCopy has its own:");
    for (const e of branded) out.push(`//   ${e.name} (BrandStr.${e.name})`);
  }
  out.push('');
  out.push('@Suppress("LargeClass", "TooManyFunctions")');
  out.push('object Str {');
  renderEntries(out, shared);
  out.push('}');
  out.push('');

  const brand = [];
  brand.push('package com.platform.app.i18n');
  brand.push('');
  brand.push('// GENERATED by scripts/android/strings-from-ios.mjs — do not edit by hand.');
  brand.push('// Source of truth: ios/Webyar/Sources/Localization/Strings.swift');
  brand.push('//');
  brand.push("// The lines of Strings.swift that name WebYar. Only WebYar's build has them:");
  brand.push("// the shared Strings.kt is in RESPOK's app too, which must never carry WebYar's");
  brand.push("// name. Screens show them through BrandStr (WebYar's BrandCopy).");
  brand.push('');
  brand.push('internal object StrBrand {');
  renderEntries(brand, branded);
  brand.push('}');
  brand.push('');

  return { shared: out.join('\n'), brand: brand.join('\n'), branded };
}

const parsed = parse(readFileSync(SOURCE, 'utf8'));
const rendered = render(parsed);
const outputs = [
  [TARGET, rendered.shared],
  [BRAND_TARGET, rendered.brand],
];

if (process.argv.includes('--check')) {
  let stale = false;
  for (const [file, text] of outputs) {
    let current = '';
    try { current = readFileSync(file, 'utf8'); } catch { /* not generated yet */ }
    if (current !== text) {
      console.error(`${file} is out of date with Strings.swift.`);
      stale = true;
    }
  }
  if (stale) {
    console.error('Run: node scripts/android/strings-from-ios.mjs');
    process.exit(1);
  }
  console.log(`Strings.kt is in sync (${parsed.simple.length} generated, ${rendered.branded.length} of them the brand's, ${parsed.manual.length} hand-written).`);
  process.exit(0);
}

for (const [file, text] of outputs) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
  console.log(`Wrote ${file}`);
}
console.log(`  generated:    ${parsed.simple.length} (${rendered.branded.length} name the brand: ${rendered.branded.map((e) => e.name).join(', ')})`);
console.log(`  hand-written: ${parsed.manual.length}`);
for (const m of parsed.manual) console.log(`    ${m.name} — ${m.reason}`);
