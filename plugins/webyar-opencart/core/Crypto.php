<?php
namespace WebYar\OpenCart;

/**
 * Small, dependency-free crypto helpers. HMAC-SHA256 for signing, AES-256-GCM
 * (OpenSSL) for secrets at rest and for the opaque session reference.
 */
final class Crypto {
	public static function base64url(string $raw): string {
		return rtrim(strtr(base64_encode($raw), '+/', '-_'), '=');
	}

	public static function base64urlDecode(string $value): ?string {
		if ($value === '' || !preg_match('/^[A-Za-z0-9_-]+$/', $value)) {
			return null;
		}

		$decoded = base64_decode(strtr($value, '-_', '+/') . str_repeat('=', (4 - strlen($value) % 4) % 4), true);

		return $decoded === false ? null : $decoded;
	}

	public static function random(int $bytes = 16): string {
		return bin2hex(random_bytes($bytes));
	}

	public static function hmac(string $secret, string $data): string {
		return hash_hmac('sha256', $data, $secret);
	}

	public static function equals(string $known, string $given): bool {
		return hash_equals($known, $given);
	}

	/** AES-256-GCM; output is base64url(iv | tag | ciphertext). */
	public static function encrypt(string $key, string $plain, string $aad = ''): string {
		$iv = random_bytes(12);
		$tag = '';
		$cipher = openssl_encrypt($plain, 'aes-256-gcm', self::key32($key), OPENSSL_RAW_DATA, $iv, $tag, $aad, 16);

		if ($cipher === false) {
			throw new \RuntimeException('encryption failed');
		}

		return self::base64url($iv . $tag . $cipher);
	}

	public static function decrypt(string $key, string $encoded, string $aad = ''): ?string {
		$raw = self::base64urlDecode($encoded);

		if ($raw === null || strlen($raw) < 29) {
			return null;
		}

		$plain = openssl_decrypt(substr($raw, 28), 'aes-256-gcm', self::key32($key), OPENSSL_RAW_DATA, substr($raw, 0, 12), substr($raw, 12, 16), $aad);

		return $plain === false ? null : $plain;
	}

	private static function key32(string $key): string {
		return hash('sha256', $key, true);
	}
}
