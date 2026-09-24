<?php
namespace WebYar\OpenCart;

/**
 * The page the store owner lands on after approving (or cancelling) the
 * connection in Web Yar. Shared by the OpenCart 4.1 and 3.0 storefront
 * controllers; self-contained HTML in the owner's language, with a button
 * back to the extension's settings page.
 *
 * The return link carries the admin's user_token, so the page sends no
 * referrer, is never cached, and is only shown for the pairing it belongs to.
 */
final class CallbackPage {
	/** Seconds before a successful connection returns to the module by itself. */
	private const AUTO_RETURN = 4;

	public static function render(bool $ok, string $error, string $lang, string $returnUrl): string {
		$lang = in_array($lang, I18n::LANGUAGES, true) ? $lang : 'en';
		$t = I18n::strings($lang);
		$dir = I18n::direction($lang);
		$font = I18n::font($lang);
		$returnUrl = self::safeUrl($returnUrl);
		$e = static fn (string $s): string => htmlspecialchars($s, ENT_QUOTES, 'UTF-8');

		$title = $ok ? $t['text_callback_success'] : $t['text_callback_failed'];
		$help = $ok ? $t['text_callback_success_help'] : $t['text_callback_failed_help'];
		$icon = $ok
			? '<path d="M20 6 9 17l-5-5"/>'
			: '<path d="M18 6 6 18M6 6l12 12"/>';
		$meta = ($ok && $returnUrl !== '') ? '<meta http-equiv="refresh" content="' . self::AUTO_RETURN . ';url=' . $e($returnUrl) . '">' : '';
		$button = $returnUrl !== ''
			? '<a class="btn" href="' . $e($returnUrl) . '"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="' . ($dir === 'rtl' ? 'M5 12h14M13 6l6 6-6 6' : 'M19 12H5M11 18l-6-6 6-6') . '"/></svg>' . $e($t['button_back_to_module']) . '</a>'
			: '<p class="note">' . $e($t['text_callback_return']) . '</p>';
		$progress = ($ok && $returnUrl !== '') ? '<div class="auto"><div class="bar"><i></i></div><span>' . $e($t['text_callback_redirect']) . '</span></div>' : '';
		$detail = (!$ok && $error !== '') ? '<code>' . $e($error) . '</code>' : '';

		return '<!doctype html><html lang="' . $lang . '" dir="' . $dir . '"><head><meta charset="utf-8">'
			. '<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer">' . $meta
			. '<title>' . $e($t['text_callback_title']) . '</title>'
			. '<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>'
			. '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=' . rawurlencode($font) . ':wght@400;600;800&amp;display=swap">'
			. '<style>'
			. ':root{--ink:#0f172a;--muted:#64748b;--brand:#4f46e5;--brand2:#7c3aed;--tone:' . ($ok ? '#059669' : '#dc2626') . ';--tonebg:' . ($ok ? '#ecfdf5' : '#fef2f2') . '}'
			. '*{box-sizing:border-box}html,body{height:100%}'
			. 'body{margin:0;display:grid;place-items:center;padding:24px;font-family:\'' . $font . '\',system-ui,-apple-system,\'Segoe UI\',Tahoma,sans-serif;color:var(--ink);line-height:1.8;'
			. 'background:radial-gradient(1200px 600px at 10% -10%,#e0e7ff 0,transparent 60%),radial-gradient(900px 500px at 110% 110%,#fce7f3 0,transparent 55%),#f5f7fb}'
			. '.card{width:100%;max-width:460px;background:rgba(255,255,255,.92);backdrop-filter:blur(8px);border:1px solid #e2e8f0;border-radius:24px;padding:36px 32px 30px;text-align:center;box-shadow:0 30px 60px -30px rgba(79,70,229,.35)}'
			. '.badge{width:76px;height:76px;margin:0 auto 18px;border-radius:50%;display:grid;place-items:center;background:var(--tonebg);color:var(--tone);box-shadow:0 0 0 10px color-mix(in srgb,var(--tonebg) 55%,transparent);animation:pop .45s cubic-bezier(.2,1.4,.4,1)}'
			. '@keyframes pop{from{transform:scale(.6);opacity:0}to{transform:none;opacity:1}}'
			. 'h1{margin:0 0 8px;font-size:21px;font-weight:800;letter-spacing:-.01em}'
			. 'p{margin:0 0 22px;color:var(--muted);font-size:14.5px}'
			. 'code{display:inline-block;direction:ltr;margin:-8px 0 20px;padding:3px 10px;border-radius:8px;background:#f1f5f9;color:#475569;font-size:12px}'
			. '.btn{display:inline-flex;align-items:center;justify-content:center;gap:10px;width:100%;padding:13px 20px;border-radius:14px;font-weight:700;font-size:15px;color:#fff;text-decoration:none;background:linear-gradient(135deg,var(--brand),var(--brand2));box-shadow:0 12px 24px -12px var(--brand);transition:transform .15s}'
			. '.btn:hover{transform:translateY(-1px)}'
			. '.auto{margin-top:16px;color:var(--muted);font-size:12.5px}.bar{height:4px;border-radius:4px;background:#e2e8f0;overflow:hidden;margin-bottom:8px}'
			. '.bar i{display:block;height:100%;width:100%;background:var(--tone);transform-origin:' . ($dir === 'rtl' ? 'right' : 'left') . ';animation:fill ' . self::AUTO_RETURN . 's linear forwards}'
			. '@keyframes fill{from{transform:scaleX(0)}to{transform:scaleX(1)}}'
			. '.note{margin:0;font-size:13px}'
			. '@media (prefers-reduced-motion:reduce){.badge,.bar i{animation:none}}'
			. '</style></head><body><main class="card" role="main">'
			. '<div class="badge"><svg viewBox="0 0 24 24" width="36" height="36" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' . $icon . '</svg></div>'
			. '<h1>' . $e($title) . '</h1><p>' . $e($help) . '</p>' . $detail . $button . $progress
			. '</main></body></html>';
	}

	/** Only an absolute http(s) URL we issued ourselves is ever linked. */
	private static function safeUrl(string $url): string {
		return preg_match('#^https?://[^\s"\'<>]+$#i', $url) ? $url : '';
	}
}
