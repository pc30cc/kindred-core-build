<?php
namespace WebYar\OpenCart;

/**
 * The extension's own pages (settings, connection result) speak the owner's
 * language: the admin's language when the extension has it, otherwise the
 * store's default language, otherwise English. Strings come from the same
 * i18n/*.json files the OpenCart language files are generated from.
 */
final class I18n {
	public const LANGUAGES = ['en', 'fa', 'tr'];

	/** First of the given OpenCart language codes (en-gb, fa-ir, tr-tr, fa…) the extension speaks. */
	public static function pick(string ...$codes): string {
		foreach ($codes as $code) {
			$short = strtolower(substr(trim($code), 0, 2));

			if ($short !== 'en' && in_array($short, self::LANGUAGES, true)) {
				return $short;
			}
		}

		return 'en';
	}

	/** @return array<string,string> */
	public static function strings(string $lang): array {
		$lang = in_array($lang, self::LANGUAGES, true) ? $lang : 'en';
		$base = self::load('en');

		return $lang === 'en' ? $base : self::load($lang) + $base;
	}

	public static function direction(string $lang): string {
		return $lang === 'fa' ? 'rtl' : 'ltr';
	}

	/** Google Fonts family for the page: Vazirmatn for Persian, Inter otherwise. */
	public static function font(string $lang): string {
		return $lang === 'fa' ? 'Vazirmatn' : 'Inter';
	}

	/** @return array<string,string> */
	private static function load(string $lang): array {
		// Packaged: system/library/webyar/i18n (brand filled in by the build).
		// Source tree: plugins/webyar-opencart/i18n.
		$file = __DIR__ . '/i18n/' . $lang . '.json';
		$file = is_file($file) ? $file : dirname(__DIR__) . '/i18n/' . $lang . '.json';
		$data = is_file($file) ? json_decode((string)file_get_contents($file), true) : null;

		// The build fills {brand} in; the source tree (tests) gets the default.
		$brand = $lang === 'fa' ? 'وب‌یار' : 'Web Yar';

		return is_array($data) ? array_map(fn ($v) => str_replace('{brand}', $brand, (string)$v), $data) : [];
	}
}
