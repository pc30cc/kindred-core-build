/**
 * The Web Yar logo on the store's Plugins screen.
 *
 * WordPress draws no icon in the installed-plugins list, so the connector
 * styles its own row instead of re-rendering it: one rule, keyed to the
 * `data-plugin` attribute WordPress already puts on every row. That keeps
 * the list table's markup and row actions untouched — if the rule ever
 * stops matching, the row just looks the way it did before.
 *
 * Two things are worth holding still. The rule must load on the plugins
 * screen and NOWHERE else (a stylesheet on every admin page for a
 * decoration on one of them is not a trade worth making), and the values
 * interpolated into it must be filtered, because CSS built by string
 * concatenation is CSS that can be escaped from.
 *
 * This runs the REAL PHP that ships, so the assertions are the behaviour
 * rather than a description of it.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const PLUGIN_DIR = resolve(process.cwd(), 'plugins/webyar-woocommerce');
const CLASS = 'WebYar\\\\WooCommerce\\\\Admin\\\\PluginsScreen';

function hasPhp(): boolean {
  try {
    execFileSync('php', ['-v'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function php(body: string, ...args: string[]): string {
  const script = `require "tests/bootstrap.php";\n${body}`;
  return execFileSync('php', ['-r', script, '--', ...args], { cwd: PLUGIN_DIR, encoding: 'utf8' });
}

/** What the plugin hands WordPress when it lands on a given admin screen. */
function stylesFor(hookSuffix: string): { handles: string[]; inline: string } {
  const out = php(
    `
    $class = "${CLASS}";
    $GLOBALS["__webyar_test_styles"] = [];
    (new $class())->enqueue($argv[1]);
    $inline = "";
    foreach ($GLOBALS["__webyar_test_styles"] as $s) { $inline .= implode("", $s["inline"]); }
    echo json_encode([
      "handles" => array_keys($GLOBALS["__webyar_test_styles"]),
      "inline"  => $inline,
    ]);
  `,
    hookSuffix,
  );
  return JSON.parse(out);
}

/** The rule itself, for arbitrary (including hostile) inputs. */
function css(basename: string, iconUrl: string): string {
  return php(
    `
    $class = "${CLASS}";
    echo $class::css($argv[1], $argv[2]);
  `,
    basename,
    iconUrl,
  ).trim();
}

describe.skipIf(!hasPhp())('the connector’s logo in the installed-plugins list', () => {
  it('styles the plugin’s own row, by the attribute WordPress already puts there', () => {
    const { inline } = stylesFor('plugins.php');

    expect(inline).toContain('tr[data-plugin="webyar-woocommerce/webyar-woocommerce.php"]');
    expect(inline).toContain('.plugin-title strong::before');
  });

  it('draws the copy shipped with the plugin, so the row costs no network request', () => {
    expect(stylesFor('plugins.php').inline).toContain(
      'url("https://shop.example.com/wp-content/plugins/webyar-woocommerce/assets/icon-128x128.png")',
    );
  });

  it('sits on the correct side of the name in Persian as well as English', () => {
    // margin-inline-end follows the document direction; a plain margin-right
    // would put the logo on the wrong side of an RTL admin, which is the
    // side every store running this plugin actually sees.
    const { inline } = stylesFor('plugins.php');

    expect(inline).toContain('margin-inline-end');
    expect(inline).not.toContain('margin-right');
    expect(inline).not.toContain('margin-left');
  });

  it('loads on the plugins screen and on no other admin page', () => {
    expect(stylesFor('plugins.php').handles).toEqual(['webyar-wc-plugins-row']);
    // Network admin reaches the same screen under a suffixed hook.
    expect(stylesFor('plugins.php-network').handles).toEqual(['webyar-wc-plugins-row']);

    for (const elsewhere of [
      'index.php',
      'toplevel_page_webyar-woocommerce',
      'woocommerce_page_wc-settings',
      'post.php',
      '',
    ]) {
      expect(stylesFor(elsewhere).handles).toEqual([]);
    }
  });

  it('cannot be escaped from by anything interpolated into it', () => {
    // Neither value is attacker-controlled today — both come from the local
    // install — but this is CSS assembled by concatenation, so a value that
    // could close the string or the rule would be a stylesheet injection on
    // an authenticated admin page.
    const hostile = css(
      'x"]{}body{display:none}[data-plugin="y',
      'https://evil.example.net/x.png");}body{display:none}a{background:url("',
    );

    expect(hostile).not.toContain('body{display:none}');
    // One rule in, one rule out.
    expect(hostile.match(/\{/g) ?? []).toHaveLength(1);
    expect(hostile.match(/\}/g) ?? []).toHaveLength(1);
  });

  it('emits nothing rather than a broken rule when there is nothing usable to say', () => {
    expect(css('', 'https://example.com/icon.png')).toBe('');
    expect(css('webyar-woocommerce/webyar-woocommerce.php', '')).toBe('');
    // A value that is only characters the filter drops is the same as empty.
    expect(css('"""', 'https://example.com/icon.png')).toBe('');
  });
});
