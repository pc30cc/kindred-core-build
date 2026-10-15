/**
 * The commerce plugins' two editions (scripts/build/pluginEdition.mjs).
 *
 * The RESPOK (International) packages are built from the same sources as the
 * Iran region's by a rename/rewrite step. Here both are built into a temp
 * folder by the builders' own exported functions, then unpacked:
 *
 *   - nothing in a RESPOK package — file names, contents, manifests — carries
 *     the Iran brand (scripts/build/brandAudit.mjs IRAN_BRAND_PATTERNS);
 *   - each still follows its platform's rules (WordPress slug = folder = text
 *     domain; WHMCS folder = module name = function prefix; OpenCart 4.1
 *     file name = extension code = namespace);
 *   - their wire names are the server's neutral dialect;
 *   - the Iran packages come out byte for byte as committed;
 *   - with PHP available: every RESPOK PHP file parses, and the OpenCart
 *     core's own unit tests pass on the rewritten core, against a signature
 *     vector computed by the server's signing code in the neutral dialect.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { IRAN_BRAND_PATTERNS } from '../../../scripts/build/brandAudit.mjs';
import { compileMo, parsePo, readMo, respokName, respokText } from '../../../scripts/build/pluginEdition.mjs';
import { checkDist, editionDownloads } from '../../../scripts/build/assertDist.mjs';
import { computeSignature, sha256Hex } from '../../../server/services/commerce/signing.js';
import { NEUTRAL_DIALECT } from '../../../server/services/commerce/pluginDialect.js';
import { OPENCART_LATEST_CONNECTOR_VERSION } from '../../../server/services/commerce/connectors/opencart.js';

const root = join(__dirname, '..', '..', '..');
const has = (bin: string, arg = '-v') => { try { execFileSync(bin, [arg], { stdio: 'ignore' }); return true; } catch { return false; } };
const HAS_ZIP = has('zip') && has('unzip', '-v');
const HAS_PHP = has('php');

const brandHit = (text: string) => IRAN_BRAND_PATTERNS.find((re: RegExp) => re.test(text)) ?? null;

function walk(dir: string): string[] {
  return readdirSync(dir).sort().flatMap((n) => (statSync(join(dir, n)).isDirectory() ? walk(join(dir, n)) : [join(dir, n)]));
}

function unpack(zip: string, into: string): string[] {
  mkdirSync(into, { recursive: true });
  execFileSync('unzip', ['-q', zip, '-d', into]);
  return walk(into).map((f) => relative(into, f));
}

const quiet = { log: () => {}, warn: () => {} };
let work = '';
const out = { iran: '', respok: '' };

describe.skipIf(!HAS_ZIP)('commerce plugin editions, built from one source', () => {
  beforeAll(async () => {
    work = mkdtempSync(join(tmpdir(), 'plugin-editions-'));
    const { packageWooCommerce } = await import('../../../scripts/build-woocommerce-plugin-zip.mjs');
    const { packageWhmcs } = await import('../../../scripts/build-whmcs-addon-zip.mjs');
    const { packageOpenCart } = await import('../../../scripts/build-opencart-plugin-zip.mjs');
    for (const edition of ['iran', 'respok'] as const) {
      const dir = join(work, edition);
      mkdirSync(join(dir, 'opencart'), { recursive: true });
      packageWooCommerce({ edition, outDir: dir, log: quiet });
      packageWhmcs({ edition, outDir: dir, log: quiet });
      packageOpenCart({ edition, outDir: join(dir, 'opencart'), log: quiet });
      out[edition] = dir;
    }
  }, 60_000);

  afterAll(() => {
    if (work) rmSync(work, { recursive: true, force: true });
  });

  describe('the RESPOK packages', () => {
    it('are named for RESPOK', () => {
      expect(walk(out.respok).map((f) => relative(out.respok, f))).toEqual([
        'opencart/3.0/respok-oc3.ocmod.zip',
        'opencart/4.1/respok.ocmod.zip',
        'opencart/respok-manifest.json',
        'respok-whmcs.json',
        'respok-whmcs.zip',
        'respok-woocommerce.json',
        'respok-woocommerce.zip',
      ]);
    });

    it('carry no Iran brand in any file name or byte, inside the archives included', () => {
      const findings: string[] = [];
      for (const file of walk(out.respok)) {
        const rel = relative(out.respok, file);
        if (brandHit(rel)) findings.push(`${rel}: name`);
        if (brandHit(readFileSync(file).toString('utf8'))) findings.push(`${rel}: bytes`);
        if (file.endsWith('.zip')) {
          const into = join(work, 'scan', rel);
          for (const entry of unpack(file, into)) {
            if (brandHit(entry)) findings.push(`${rel}!${entry}: name`);
            const text = readFileSync(join(into, entry)).toString('utf8');
            const hit = brandHit(text);
            if (hit) findings.push(`${rel}!${entry}: ${String(hit)}`);
          }
        }
      }
      expect(findings).toEqual([]);
    });

    it('WordPress: one top folder = slug = main file = text domain, catalogue renamed and rebuilt', () => {
      const into = join(work, 'wc');
      const entries = unpack(join(out.respok, 'respok-woocommerce.zip'), into);
      expect(new Set(entries.map((e) => e.split('/')[0]))).toEqual(new Set(['respok-woocommerce']));
      const main = readFileSync(join(into, 'respok-woocommerce', 'respok-woocommerce.php'), 'utf8');
      expect(main).toMatch(/^ \* Plugin Name:\s+RESPOK for WooCommerce$/m);
      expect(main).toMatch(/^ \* Text Domain:\s+respok-woocommerce$/m);
      expect(main).toMatch(/^ \* Plugin URI:\s+https:\/\/respok\.app$/m);
      expect(main).toContain("define( 'RESPOK_WC_PROTOCOL_VERSION', 'platform-commerce/1' );");
      expect(main).toContain("$prefix = 'Respok\\\\WooCommerce\\\\';");
      const mo = readMo(readFileSync(join(into, 'respok-woocommerce', 'languages', 'respok-woocommerce-fa_IR.mo')));
      expect(mo.get('Connect to RESPOK')).toBe('اتصال به RESPOK');
      const router = readFileSync(join(into, 'respok-woocommerce', 'src', 'Rest', 'Router.php'), 'utf8');
      expect(router).toContain(`'${NEUTRAL_DIALECT.moduleCode}/v1'`);
      const signer = readFileSync(join(into, 'respok-woocommerce', 'src', 'Auth', 'RequestSigner.php'), 'utf8');
      for (const h of ['Installation', 'Timestamp', 'Nonce', 'Signature', 'Protocol']) expect(signer).toContain(`'${NEUTRAL_DIALECT.headerPrefix}${h}'`);
      expect(readFileSync(join(into, 'respok-woocommerce', 'src', 'Identity', 'CustomerContext.php'), 'utf8')).toContain(`'${NEUTRAL_DIALECT.identityAudience}'`);
      // The RESPOK icon, not the Iran one.
      expect(readFileSync(join(into, 'respok-woocommerce', 'assets', 'icon-128x128.png'))).toEqual(readFileSync(join(root, 'plugins', 'editions', 'respok', 'icon-128x128.png')));
    });

    it('WHMCS: the addon folder is the module name and prefixes its functions', () => {
      const into = join(work, 'wh');
      const entries = unpack(join(out.respok, 'respok-whmcs.zip'), into);
      expect(entries.filter((e) => !e.startsWith('modules/addons/respok/'))).toEqual(['INSTALL.txt']);
      const main = readFileSync(join(into, 'modules', 'addons', 'respok', 'respok.php'), 'utf8');
      for (const fn of ['config', 'activate', 'deactivate', 'output']) expect(main).toContain(`function respok_${fn}(`);
      const version = readFileSync(join(into, 'modules', 'addons', 'respok', 'lib', 'Version.php'), 'utf8');
      expect(version).toContain(`'${NEUTRAL_DIALECT.protocol}'`);
      expect(version).toContain(`'${NEUTRAL_DIALECT.whmcsCanonicalPath}'`);
      const updater = readFileSync(join(into, 'modules', 'addons', 'respok', 'lib', 'Updater.php'), 'utf8');
      expect(updater).toContain("'/downloads/respok-whmcs.json'");
      expect(readFileSync(join(into, 'modules', 'addons', 'respok', 'assets', 'icon.png'))).toEqual(readFileSync(join(root, 'public', 'brand', 'intl', 'maskable-icon-512.png')));
    });

    it('OpenCart 4.1: file name = extension code = folder and namespace; 3.0: routes under module/respok', () => {
      const into4 = join(work, 'oc4');
      const e4 = unpack(join(out.respok, 'opencart', '4.1', 'respok.ocmod.zip'), into4);
      expect(e4).toContain('install.json');
      expect(e4).toContain('admin/controller/module/respok.php');
      expect(e4).toContain('system/library/respok/autoload.php');
      const admin = readFileSync(join(into4, 'admin', 'controller', 'module', 'respok.php'), 'utf8');
      expect(admin).toContain('namespace Opencart\\Admin\\Controller\\Extension\\Respok\\Module;');
      expect(admin).toContain('class Respok extends');
      expect(admin).toContain("'extension/respok/module/respok'");
      const catalog = readFileSync(join(into4, 'catalog', 'controller', 'module', 'respok.php'), 'utf8');
      expect(catalog).toContain("strncmp($name, 'HTTP_X_PLATFORM_', 16)");
      expect(readFileSync(join(into4, 'system', 'library', 'respok', 'Updater.php'), 'utf8')).toContain("'/downloads/opencart/respok-manifest.json'");
      expect(JSON.parse(readFileSync(join(into4, 'install.json'), 'utf8')).name).toMatch(/^RESPOK /);

      const into3 = join(work, 'oc3');
      const e3 = unpack(join(out.respok, 'opencart', '3.0', 'respok-oc3.ocmod.zip'), into3);
      expect(e3.every((e) => e.startsWith('upload/'))).toBe(true);
      const admin3 = readFileSync(join(into3, 'upload', 'admin', 'controller', 'extension', 'module', 'respok.php'), 'utf8');
      expect(admin3).toContain('class ControllerExtensionModuleRespok extends');
    });

    it('their manifests point at RESPOK files and speak the neutral protocol', () => {
      const wc = JSON.parse(readFileSync(join(out.respok, 'respok-woocommerce.json'), 'utf8'));
      expect(wc).toMatchObject({ slug: 'respok-woocommerce', package: '/downloads/respok-woocommerce.zip', homepage: 'https://respok.app' });
      const wh = JSON.parse(readFileSync(join(out.respok, 'respok-whmcs.json'), 'utf8'));
      expect(wh).toMatchObject({ slug: 'respok-whmcs', package: '/downloads/respok-whmcs.zip' });
      const oc = JSON.parse(readFileSync(join(out.respok, 'opencart', 'respok-manifest.json'), 'utf8'));
      expect(oc.slug).toBe('respok-opencart');
      expect(oc.protocol).toBe(NEUTRAL_DIALECT.protocol);
      expect(oc.version).toBe(OPENCART_LATEST_CONNECTOR_VERSION);
      expect(oc.packages.map((p: { path: string }) => p.path)).toEqual(['/downloads/opencart/4.1/respok.ocmod.zip', '/downloads/opencart/3.0/respok-oc3.ocmod.zip']);
      for (const p of oc.packages) expect(sha256Hex(readFileSync(join(out.respok, p.path.replace('/downloads/', ''))))).toBe(p.sha256);
    });

    it('are deterministic: the committed ones are what the source builds', () => {
      for (const rel of ['respok-woocommerce.zip', 'respok-whmcs.zip', 'opencart/4.1/respok.ocmod.zip', 'opencart/3.0/respok-oc3.ocmod.zip', 'respok-whmcs.json', 'opencart/respok-manifest.json']) {
        expect(sha256Hex(readFileSync(join(root, 'public', 'downloads', rel))), rel).toBe(sha256Hex(readFileSync(join(out.respok, rel))));
      }
    });

    it.skipIf(!HAS_PHP)('every PHP file parses', () => {
      const bad: string[] = [];
      for (const zip of walk(out.respok).filter((f) => f.endsWith('.zip'))) {
        const into = join(work, 'lint', relative(out.respok, zip));
        for (const entry of unpack(zip, into).filter((e) => e.endsWith('.php'))) {
          try { execFileSync('php', ['-l', join(into, entry)], { stdio: 'pipe' }); } catch { bad.push(`${relative(out.respok, zip)}!${entry}`); }
        }
      }
      expect(bad).toEqual([]);
    });

    it.skipIf(!HAS_PHP)('the rewritten OpenCart core passes its own unit tests, signing as the server does', () => {
      // Lay the rewritten core and tests out as the repo does, with the real
      // RESPOK packages where run.php looks for them.
      const tree = join(work, 'octree');
      const src = join(root, 'plugins', 'webyar-opencart');
      const dst = join(tree, 'plugins', 'respok-opencart');
      for (const sub of ['core', 'i18n', join('tests', 'unit'), join('tests', 'fixtures')]) {
        for (const name of readdirSync(join(src, sub))) {
          if (!statSync(join(src, sub, name)).isFile()) continue;
          mkdirSync(join(dst, sub), { recursive: true });
          writeFileSync(join(dst, sub, respokName(name)), respokText(readFileSync(join(src, sub, name), 'utf8')));
        }
      }
      const vectorFile = join(dst, 'tests', 'fixtures', 'signing-vector.json');
      const v = JSON.parse(readFileSync(vectorFile, 'utf8'));
      expect(v.protocolVersion).toBe(NEUTRAL_DIALECT.protocol);
      v.expectedSignature = computeSignature(v.secret, { ...v, bodySha256Hex: sha256Hex(v.body) });
      writeFileSync(vectorFile, JSON.stringify(v));
      cpSync(join(out.respok, 'opencart'), join(tree, 'public', 'downloads', 'opencart'), { recursive: true });
      const output = execFileSync('php', [join(dst, 'tests', 'unit', 'run.php')], { encoding: 'utf8' });
      expect(output).toMatch(/core unit tests: \d+ passed, 0 failed/);
      // Including the checks that unpack the real 4.1 and 3.0 packages.
      const original = execFileSync('php', [join(src, 'tests', 'unit', 'run.php')], { encoding: 'utf8' });
      expect(output.match(/(\d+) passed/)?.[1]).toBe(original.match(/(\d+) passed/)?.[1]);
    });
  });

  describe('the Iran packages', () => {
    it('keep their names', () => {
      expect(walk(out.iran).map((f) => relative(out.iran, f))).toEqual([
        'opencart/3.0/webyar-oc3.ocmod.zip',
        'opencart/4.1/webyar.ocmod.zip',
        'opencart/manifest.json',
        'webyar-whmcs.json',
        'webyar-whmcs.zip',
        'webyar-woocommerce.json',
        'webyar-woocommerce.zip',
      ]);
    });

    it('come out byte for byte as the committed releases', () => {
      for (const rel of ['webyar-woocommerce.zip', 'webyar-whmcs.zip']) {
        expect(sha256Hex(readFileSync(join(out.iran, rel))), rel).toBe(sha256Hex(readFileSync(join(root, 'public', 'downloads', rel))));
      }
      // OpenCart's committed release is signed and frozen; a fresh build is
      // still the same extension under the same names and protocol.
      const oc = JSON.parse(readFileSync(join(out.iran, 'opencart', 'manifest.json'), 'utf8'));
      const committed = JSON.parse(readFileSync(join(root, 'public', 'downloads', 'opencart', 'manifest.json'), 'utf8'));
      expect({ ...oc, packages: oc.packages.map(({ sha256: _s, ...p }: Record<string, unknown>) => p) })
        .toEqual({ ...committed, packages: committed.packages.map(({ sha256: _s, ...p }: Record<string, unknown>) => p) });
    });
  });
});

describe('the rewrite', () => {
  it('turns wire names neutral, names RESPOK and keeps identifiers consistent', () => {
    expect(respokText("'X-WebYar-Signature' x-webyar-nonce 'webyar-commerce/1' 'webyar-widget' '/webyar/whmcs/v1'"))
      .toBe("'X-Platform-Signature' x-platform-nonce 'platform-commerce/1' 'platform-widget' '/platform/whmcs/v1'");
    expect(respokText("__( 'Connect to WebYar', 'webyar-woocommerce' )")).toBe("__( 'Connect to RESPOK', 'respok-woocommerce' )");
    expect(respokText('namespace WebYar\\OpenCart; class Webyar; WEBYAR_WC_DIR; module_webyar_status')).toBe('namespace Respok\\OpenCart; class Respok; RESPOK_WC_DIR; module_respok_status');
    expect(respokText('https://app.webyar.ai https://api.webyar.ai https://webyar.ai Web Yar وب‌یار')).toBe('https://app.respok.app https://api.respok.app https://respok.app RESPOK RESPOK');
    expect(respokText("strncmp($name, 'HTTP_X_WEBYAR_', 14)")).toBe("strncmp($name, 'HTTP_X_PLATFORM_', 16)");
    expect(() => respokText("substr($k, 0, strlen('HTTP_X_WEBYAR_'))")).toThrow(/HTTP_X_WEBYAR_/);
    expect(respokName('webyar-woocommerce-fa_IR.mo')).toBe('respok-woocommerce-fa_IR.mo');
  });

  it('compiles a .po exactly as the committed .mo reads', () => {
    const dir = join(root, 'plugins', 'webyar-woocommerce', 'languages');
    const po = readFileSync(join(dir, 'webyar-woocommerce-fa_IR.po'), 'utf8');
    const committed = readMo(readFileSync(join(dir, 'webyar-woocommerce-fa_IR.mo')));
    expect(readMo(compileMo(po))).toEqual(committed);
    expect(parsePo(po).length).toBe(committed.size);
  });
});

describe('the app offers its build’s edition', () => {
  it('the RESPOK bundle names only RESPOK packages', async () => {
    vi.resetModules();
    (globalThis as Record<string, unknown>).__SHIPS_IRAN_KIT__ = false;
    try {
      const { COMMERCE_PLUGIN_DOWNLOADS } = await import('../../../src/components/plugins/pluginDownloads');
      expect(brandHit(JSON.stringify(COMMERCE_PLUGIN_DOWNLOADS))).toBeNull();
      expect(COMMERCE_PLUGIN_DOWNLOADS).toMatchObject({
        wooCommerceZip: '/downloads/respok-woocommerce.zip',
        whmcsZip: '/downloads/respok-whmcs.zip',
        whmcsAddonDir: 'modules/addons/respok/',
        openCartManifest: '/downloads/opencart/respok-manifest.json',
        openCartOc4File: 'respok.ocmod.zip',
      });
      // What the RESPOK packages are actually called and say.
      for (const p of COMMERCE_PLUGIN_DOWNLOADS.openCartPackages) expect(existsSync(join(root, 'public', p.path))).toBe(true);
      expect(existsSync(join(root, 'public', COMMERCE_PLUGIN_DOWNLOADS.wooCommerceZip))).toBe(true);
      expect(existsSync(join(root, 'public', COMMERCE_PLUGIN_DOWNLOADS.whmcsZip))).toBe(true);
    } finally {
      delete (globalThis as Record<string, unknown>).__SHIPS_IRAN_KIT__;
      vi.resetModules();
    }
  });

  it('the Iran bundle (and dev/tests) keeps today’s packages', async () => {
    vi.resetModules();
    const { COMMERCE_PLUGIN_DOWNLOADS } = await import('../../../src/components/plugins/pluginDownloads');
    expect(COMMERCE_PLUGIN_DOWNLOADS.wooCommerceZip).toBe('/downloads/webyar-woocommerce.zip');
    expect(COMMERCE_PLUGIN_DOWNLOADS.whmcsZip).toBe('/downloads/webyar-whmcs.zip');
    expect(COMMERCE_PLUGIN_DOWNLOADS.openCartManifest).toBe('/downloads/opencart/manifest.json');
    expect(COMMERCE_PLUGIN_DOWNLOADS.openCartOc4File).toBe('webyar.ocmod.zip');
  });
});

describe('the image build checks the downloads per brand (scripts/build/assertDist.mjs)', () => {
  const make = (files: string[]) => {
    const dir = mkdtempSync(join(tmpdir(), 'dist-check-'));
    for (const f of files) { mkdirSync(join(dir, f, '..'), { recursive: true }); writeFileSync(join(dir, f), ''); }
    return dir;
  };

  it('a RESPOK dist needs the RESPOK downloads and must not hold the Iran ones', () => {
    const ok = make(editionDownloads('respok'));
    expect(checkDist(ok, 'respok')).toEqual([]);
    const leaked = make([...editionDownloads('respok'), 'downloads/webyar-whmcs.zip']);
    expect(checkDist(leaked, 'respok')).toEqual(['Iran file in the RESPOK build: downloads/webyar-whmcs.zip']);
    expect(checkDist(make([]), 'respok')).toHaveLength(editionDownloads('respok').length);
    for (const d of [ok, leaked]) rmSync(d, { recursive: true, force: true });
  });

  it('an Iran dist needs today’s files; `both` needs both', () => {
    expect(editionDownloads('iran')).toContain('downloads/opencart/4.1/webyar.ocmod.zip');
    const iran = make(editionDownloads('iran'));
    expect(checkDist(iran, 'iran')).toEqual([]);
    expect(checkDist(iran, 'both').every((p: string) => p.startsWith('missing downloads/') && !brandHit(p))).toBe(true);
    rmSync(iran, { recursive: true, force: true });
  });
});
