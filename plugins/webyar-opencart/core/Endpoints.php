<?php
namespace WebYar\OpenCart;

/**
 * Where Web Yar lives. Fixed in the package (the build can substitute other
 * addresses for a self-hosted Web Yar); the store owner never types them.
 *
 * A staging or test install can point the extension elsewhere by defining
 * WEBYAR_APP_URL / WEBYAR_API_URL (and, for its own release key,
 * WEBYAR_UPDATE_PUBLIC_KEY) in OpenCart's config.php. Writing config.php
 * already means full control of the shop, so this opens nothing new.
 */
final class Endpoints {
	public const APP_URL = 'https://app.webyar.ai';
	public const API_URL = 'https://api.webyar.ai';

	public static function app(): string {
		return rtrim(defined('WEBYAR_APP_URL') ? (string)constant('WEBYAR_APP_URL') : self::APP_URL, '/');
	}

	public static function api(): string {
		return rtrim(defined('WEBYAR_API_URL') ? (string)constant('WEBYAR_API_URL') : self::API_URL, '/');
	}

	public static function updatePublicKey(): string {
		return defined('WEBYAR_UPDATE_PUBLIC_KEY') ? (string)constant('WEBYAR_UPDATE_PUBLIC_KEY') : Protocol::UPDATE_PUBLIC_KEY;
	}
}
