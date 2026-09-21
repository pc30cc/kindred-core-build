/**
 * Where a plugin update is allowed to come from.
 *
 * The WooCommerce connector is not on wordpress.org — a store downloads it
 * from the Web Yar install that issued its credentials — so WordPress has
 * nowhere to look for a newer build and a site silently keeps whatever it was
 * first given. The plugin now checks for updates itself, which puts a trust
 * boundary in the middle of it: WordPress will fetch whatever URL it is
 * handed, unzip it and run it.
 *
 * The manifest is data pulled over the network. If it could name its own
 * download host, tampering with it would be a way to install anything on
 * every connected store. So the host comes from what the admin configured
 * locally and the manifest only gets to say which path on it.
 *
 * This runs the REAL PHP — the same file that ships — rather than asserting
 * on its source text, so the check is the behaviour and not a description of
 * it. Skipped where no PHP binary exists; the logic is also covered by
 * plugins/webyar-woocommerce/tests/unit/UpdaterTest.php.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const PLUGIN_DIR = resolve(process.cwd(), 'plugins/webyar-woocommerce');

function hasPhp(): boolean {
  try {
    execFileSync('php', ['-v'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Runs the updater's WordPress-facing entry point against a scripted manifest
 * response and reports what it put in the update transient.
 */
function checkForUpdate(opts: {
  manifest?: Record<string, unknown> | string;
  status?: number;
  appUrl?: string | null;
  networkError?: boolean;
  repeat?: number;
}): { update: string | null; toggle: string | null; fetches: number; url: string | null } {
  const payload = JSON.stringify({
    manifest: opts.manifest ?? null,
    status: opts.status ?? 200,
    appUrl: opts.appUrl === undefined ? 'https://app.example.com' : opts.appUrl,
    networkError: !!opts.networkError,
    repeat: opts.repeat ?? 1,
  });
  const script = `
    require getcwd() . "/tests/bootstrap.php";
    $in = json_decode($argv[1], true);
    $GLOBALS["__webyar_test_options"]["webyar_wc_settings"] = $in["appUrl"] === null ? [] : ["app_url" => $in["appUrl"]];
    $body = is_string($in["manifest"]) ? $in["manifest"] : json_encode($in["manifest"]);
    $GLOBALS["__webyar_test_http"] = $in["networkError"]
      ? new WP_Error("timeout")
      : ["response" => ["code" => $in["status"]], "body" => $body];
    $GLOBALS["__webyar_test_fetched"] = [];
    $class = "WebYar\\\\WooCommerce\\\\Support\\\\Updater";
    $u = new $class();
    for ($i = 0; $i < $in["repeat"]; $i++) {
      $t = (object) ["response" => [], "no_update" => []];
      $t = $u->inject_update($t);
    }
    $k = "webyar-woocommerce/webyar-woocommerce.php";
    echo json_encode([
      "update"  => isset($t->response[$k]) ? $t->response[$k]->new_version : null,
      "toggle"  => isset($t->no_update[$k]) ? $t->no_update[$k]->new_version : null,
      "fetches" => count($GLOBALS["__webyar_test_fetched"]),
      "url"     => $GLOBALS["__webyar_test_fetched"][0] ?? null,
    ]);
  `;
  return JSON.parse(execFileSync('php', ['-r', script, '--', payload], { cwd: PLUGIN_DIR, encoding: 'utf8' }));
}

const MANIFEST = {
  slug: 'webyar-woocommerce',
  version: '1.2.0',
  package: '/downloads/webyar-woocommerce.zip',
  requires: '6.0',
  requires_php: '7.4',
  tested: '9.4',
  homepage: 'https://webyar.ai',
  description: 'd',
  changelog: 'c',
};

/** `null` means the updater refused the package outright. */
function resolvePackage(pkg: string, base: string): string | null {
  // The class is referenced through a variable so the namespace separators
  // only ever live inside a PHP string — a bare `new A\B\C()` would need a
  // different number of backslashes than the string above it, which is
  // exactly the mistake this shape avoids.
  const script = `
    require "tests/bootstrap.php";
    $class = "WebYar\\\\WooCommerce\\\\Support\\\\Updater";
    $m = new ReflectionMethod($class, "same_origin_package");
    $m->setAccessible(true);
    $r = $m->invoke(new $class(), $argv[1], $argv[2]);
    echo $r === null ? "__REFUSED__" : $r;
  `;
  const out = execFileSync('php', ['-r', script, '--', pkg, base], { cwd: PLUGIN_DIR, encoding: 'utf8' }).trim();
  return out === '__REFUSED__' ? null : out;
}

describe.skipIf(!hasPhp())('a plugin update may only come from the configured Web Yar install', () => {
  const BASE = 'https://app.example.com';

  it('resolves the manifest’s path against that install', () => {
    // The build that writes the manifest cannot know which host will serve
    // it — Web Yar is self-hostable — so a path is the normal form.
    expect(resolvePackage('/downloads/webyar-woocommerce.zip', BASE))
      .toBe('https://app.example.com/downloads/webyar-woocommerce.zip');
  });

  it('accepts an absolute URL on the same host', () => {
    expect(resolvePackage(`${BASE}/downloads/webyar-woocommerce.zip`, BASE))
      .toBe('https://app.example.com/downloads/webyar-woocommerce.zip');
  });

  it('refuses another host — the attack this exists to stop', () => {
    expect(resolvePackage('https://evil.example.net/webyar-woocommerce.zip', BASE)).toBeNull();
  });

  it('refuses a lookalike subdomain', () => {
    expect(resolvePackage('https://app.example.com.evil.net/p.zip', BASE)).toBeNull();
  });

  it('refuses plain http, which anyone on the path could swap', () => {
    expect(resolvePackage('http://app.example.com/p.zip', BASE)).toBeNull();
  });

  it('allows http only for a localhost dev install', () => {
    expect(resolvePackage('http://localhost/p.zip', 'http://localhost')).toBe('http://localhost/p.zip');
  });

  it('refuses an empty or host-less value rather than guessing', () => {
    expect(resolvePackage('', BASE)).toBeNull();
    expect(resolvePackage('webyar-woocommerce.zip', BASE)).toBeNull();
  });

  it('refuses when the CONFIGURED url is itself malformed', () => {
    // A store whose Web Yar URL was mistyped must not start accepting
    // packages: with no host to compare against, nothing can match it.
    expect(resolvePackage('webyar-woocommerce.zip', 'not-a-url')).toBeNull();
    expect(resolvePackage('/downloads/p.zip', '')).toBeNull();
    expect(resolvePackage('https:///p.zip', 'not-a-url')).toBeNull();
  });
});

describe.skipIf(!hasPhp())('what the store is told about a new build', () => {
  it('offers the update when the manifest is newer than what is installed', () => {
    // The plugin's own header says 1.1.0 (see the test bootstrap).
    expect(checkForUpdate({ manifest: MANIFEST }).update).toBe('1.2.0');
  });

  it('claims no update for the same or an older version', () => {
    expect(checkForUpdate({ manifest: { ...MANIFEST, version: '1.1.0' } }).update).toBeNull();
    expect(checkForUpdate({ manifest: { ...MANIFEST, version: '1.0.0' } }).update).toBeNull();
  });

  it('still reports itself when up to date — that is what shows the auto-update toggle', () => {
    // WordPress only offers "Enable auto-updates" for a plugin it has update
    // information about. A plugin that speaks up ONLY when an update exists
    // never gets the toggle at all, so the up-to-date case is filled in too.
    const result = checkForUpdate({ manifest: { ...MANIFEST, version: '1.1.0' } });

    expect(result.update).toBeNull();
    expect(result.toggle).toBe('1.1.0');
  });

  it('says nothing at all when the manifest points somewhere else', () => {
    const result = checkForUpdate({ manifest: { ...MANIFEST, package: 'https://evil.example.net/p.zip' } });

    expect(result.update).toBeNull();
    expect(result.toggle).toBeNull();
  });

  it('rejects a version string that is not a version', () => {
    // It is compared with version_compare() and printed into wp-admin.
    expect(checkForUpdate({ manifest: { ...MANIFEST, version: '1.2.0; rm -rf' } }).update).toBeNull();
  });

  it('fails closed on every way the check can go wrong', () => {
    for (const broken of [
      { status: 500, manifest: MANIFEST },
      { manifest: '<html>oops</html>' },
      { networkError: true, manifest: MANIFEST },
      { manifest: { ...MANIFEST, version: undefined } },
    ]) {
      const result = checkForUpdate(broken as never);
      expect(result.update).toBeNull();
      expect(result.toggle).toBeNull();
    }
  });

  it('does not reach the network before the store is configured', () => {
    // A fresh install with no Web Yar URL has nothing to check against, and
    // must not start making requests to guess one.
    const result = checkForUpdate({ manifest: MANIFEST, appUrl: null });

    expect(result.fetches).toBe(0);
    expect(result.update).toBeNull();
  });

  it('asks the configured install, once, however often WordPress checks', () => {
    // wp-admin fires this filter on many page loads; refetching each time
    // would put every store on a loop against the dashboard.
    const result = checkForUpdate({ manifest: MANIFEST, repeat: 3 });

    expect(result.fetches).toBe(1);
    expect(result.url).toBe('https://app.example.com/downloads/webyar-woocommerce.json');
  });
});
