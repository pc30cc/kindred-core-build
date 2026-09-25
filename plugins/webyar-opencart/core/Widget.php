<?php
namespace WebYar\OpenCart;

/**
 * One cache-safe, same-origin identity check per page. It runs before widget
 * bootstrap so login enriches the current guest and logout/account changes
 * rotate the visitor before any private chat history is restored.
 * No identity or store session credential is embedded in cacheable HTML.
 */
final class Widget {
	/** Rate limit for the browser identity endpoint, per storefront session. */
	public const CONTEXT_LIMIT = 120;
	public const CONTEXT_WINDOW = 600;

	/**
	 * Built from the stored connection record's PUBLIC fields only — no
	 * secret is decrypted (or even read from disk) on a page view.
	 *
	 * @param array<string,mixed> $record
	 */
	public static function snippet(array $record, string $contextUrl): string {
		$workspaceId = (string)($record['workspace_id'] ?? '');
		$apiBase = rtrim((string)($record['api_base'] ?? ''), '/');
		$appBase = rtrim((string)($record['app_base'] ?? ''), '/');
		$connectionId = (string)($record['connection_id'] ?? '');
		$attrs = [
			'workspace-id'        => $workspaceId,
			'api-base'            => $apiBase,
			'asset-base'          => $appBase,
			'commerce-provider'   => 'opencart',
			'commerce-context-url' => $contextUrl,
			'commerce-context-eager' => 'true',
		];

		if ($connectionId !== '') {
			$attrs['commerce-connection'] = $connectionId;
		}

		$set = '';

		foreach ($attrs as $name => $value) {
			$set .= "s.setAttribute('data-" . $name . "'," . self::js($value) . ");";
		}

		// Same contract as src/lib/widgetEmbed.ts and the WooCommerce bridge:
		// window.__gs_id / __gs_api_base + the loader's own singleton guards,
		// so a merchant who ALSO pasted the manual snippet gets one widget.
		return '<script>(function(){if(window.__gs_loaded||window.__gs_loader_injected||document.getElementById("gs-widget-loader")){return;}'
			. 'window.__gs_loader_injected=true;window.__gs=window.__gs||[];'
			. 'window.__gs_id=' . self::js($workspaceId) . ';window.__gs_api_base=' . self::js($apiBase) . ';'
			. 'var s=document.createElement("script");s.id="gs-widget-loader";s.async=true;s.src=' . self::js($appBase . '/widget/loader.js') . ';'
			. $set . 'document.head.appendChild(s);})();</script>';
	}

	/** Inserts the snippet before </body> once; a page that already has a loader is left alone. */
	public static function inject(string $html, string $snippet): string {
		if ($html === '' || strpos($html, 'gs-widget-loader') !== false || strpos($html, '/widget/loader.js') !== false) {
			return $html;
		}

		$pos = strripos($html, '</body>');

		return $pos === false ? $html . $snippet : substr($html, 0, $pos) . $snippet . substr($html, $pos);
	}

	/** @param array<string,mixed> $session OpenCart session data, by reference */
	public static function allowContextRequest(array &$session, int $now): bool {
		$bucket = $session['webyar_ctx'] ?? null;

		if (!is_array($bucket) || (int)($bucket['start'] ?? 0) + self::CONTEXT_WINDOW < $now) {
			$bucket = ['start' => $now, 'count' => 0];
		}

		$bucket['count'] = (int)$bucket['count'] + 1;
		$session['webyar_ctx'] = $bucket;

		return $bucket['count'] <= self::CONTEXT_LIMIT;
	}

	private static function js(string $value): string {
		return (string)json_encode($value, JSON_HEX_TAG | JSON_HEX_AMP | JSON_HEX_APOS | JSON_HEX_QUOT | JSON_UNESCAPED_SLASHES);
	}
}
