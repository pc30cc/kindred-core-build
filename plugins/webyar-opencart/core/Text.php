<?php
namespace WebYar\OpenCart;

/**
 * Merchant content (names, descriptions, reviews, order comments) is
 * untrusted DATA. It is stripped of markup and control characters and cut to
 * a bound here; Web Yar sanitizes it again on its own side.
 */
final class Text {
	public static function clean($value, int $max = 300): string {
		$text = html_entity_decode(strip_tags(str_replace(['<br>', '<br/>', '<br />', '</p>'], ' ', (string)$value)), ENT_QUOTES | ENT_HTML5, 'UTF-8');
		$text = preg_replace('/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/u', '', $text) ?? '';
		$text = trim(preg_replace('/\s+/u', ' ', $text) ?? '');

		return mb_strlen($text, 'UTF-8') > $max ? rtrim(mb_substr($text, 0, $max, 'UTF-8')) . '…' : $text;
	}

	/** Search terms: letters, digits, ZWNJ and '-' only, bounded. */
	public static function terms($value): array {
		$out = [];

		foreach (is_array($value) ? $value : [] as $term) {
			$term = preg_replace('/[^\p{L}\p{N}\x{200C}\-]/u', '', (string)$term) ?? '';
			$term = mb_substr($term, 0, Protocol::MAX_TERM_LENGTH, 'UTF-8');

			if (mb_strlen($term, 'UTF-8') >= 2 && !in_array($term, $out, true)) {
				$out[] = $term;
			}

			if (count($out) >= Protocol::MAX_TERMS) {
				break;
			}
		}

		return $out;
	}

	/**
	 * The spellings a shop and a shopper mix up (Arabic vs Persian yeh and
	 * kaf, ZWNJ or none). Bounded: at most two variants per term.
	 */
	public static function variants(string $term): array {
		$persian = str_replace(['ي', 'ك'], ['ی', 'ک'], $term);
		$arabic = str_replace(['ی', 'ک'], ['ي', 'ك'], $term);
		$plain = str_replace("\u{200C}", '', $persian);

		return array_values(array_unique(array_slice(array_unique([$persian, $arabic, $plain]), 0, 3)));
	}
}
