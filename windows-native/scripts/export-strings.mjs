// Builds src/Webyar.Core/Localization/strings.json from the strings the other
// clients already use, so the native app can never word something differently:
//   - windows/src/renderer/src/i18n/strings.json  (generated from the iOS app)
//   - windows/src/renderer/src/i18n/extra.ts      (desktop-only lines)
//   - windows-native/scripts/native-strings.json  (lines only the native app has)
// Later sources win over earlier ones with the same key. Run with:
//   node windows-native/scripts/export-strings.mjs
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '..', '..')
const i18n = join(repo, 'windows', 'src', 'renderer', 'src', 'i18n')
const require = createRequire(join(repo, 'windows', 'package.json'))
const { transformSync } = require('esbuild')

const ios = JSON.parse(readFileSync(join(i18n, 'strings.json'), 'utf8'))
const { code } = transformSync(readFileSync(join(i18n, 'extra.ts'), 'utf8'), { loader: 'ts', format: 'cjs' })
const mod = { exports: {} }
new Function('module', 'exports', code)(mod, mod.exports)
const extra = mod.exports.extra

const native = JSON.parse(readFileSync(join(here, 'native-strings.json'), 'utf8'))
const out = {}
for (const lang of ['en', 'fa', 'tr']) {
  out[lang] = { ...ios[lang], ...extra[lang], ...native[lang] }
}
const missing = Object.keys(out.en).filter((k) => !out.fa[k] || !out.tr[k])
if (missing.length) {
  console.error('Missing translations:', missing.join(', '))
  process.exit(1)
}
const target = join(here, '..', 'src', 'Webyar.Core', 'Localization', 'strings.json')
mkdirSync(dirname(target), { recursive: true })
writeFileSync(target, JSON.stringify(out, null, 1) + '\n')
console.log(`Wrote ${Object.keys(out.en).length} keys × 3 languages to ${target}`)
