<?php

namespace WebYar\Whmcs;

/**
 * The signed introduction handed to the widget on a logged-in page.
 *
 *   whmcs1.<base64url(payload)>.<hex hmac-sha256("whmcs1." + base64url(payload))>
 *
 * It says who the WHMCS User is, which Client Account they are acting for,
 * and which grant backs that — for TTL_SECONDS. It authorizes nothing by
 * itself: Web Yar binds it to a widget visitor, and every later private read
 * is re-authorized here against the live grant and the user's permissions.
 *
 * Only the User's own name/email travel (never the client account's), and
 * only when the administrator left "share contact details" on — so the two
 * users of one shared company account stay two separate contacts.
 */
final class Identity
{
    const PREFIX = 'whmcs1';
    const TTL_SECONDS = 300;

    private static function base64url($raw)
    {
        return rtrim(strtr(base64_encode($raw), '+/', '-_'), '=');
    }

    /**
     * @param array{installation_id:string,secret:string,workspace_id:string} $credential
     */
    public static function issue(array $credential, $grantId, $userId, $clientId, $name, $email)
    {
        $now = Platform::now();
        $payload = array(
            'v' => 1,
            'typ' => 'whmcs.identity',
            'iss' => $credential['installation_id'],
            'wid' => $credential['workspace_id'],
            'aud' => 'webyar-widget',
            'iat' => $now,
            'exp' => $now + self::TTL_SECONDS,
            'jti' => bin2hex(random_bytes(12)),
            'gid' => (string) $grantId,
            'uid' => (string) (int) $userId,
            'cid' => (string) (int) $clientId,
            'sub' => self::subject($credential['secret'], $userId),
        );
        if (Settings::shareContact()) {
            $cleanName = Text::clean($name, 120);
            if ($cleanName !== null) {
                $payload['name'] = $cleanName;
            }
            if (is_string($email) && filter_var($email, FILTER_VALIDATE_EMAIL) && strlen($email) <= 254) {
                $payload['email'] = $email;
            }
        }
        $signed = self::PREFIX . '.' . self::base64url(json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES));
        return $signed . '.' . hash_hmac('sha256', $signed, $credential['secret']);
    }

    /** Opaque, per-installation user fingerprint — lets the widget notice a different person on this browser. */
    public static function subject($secret, $userId)
    {
        return substr(hash_hmac('sha256', 'subject:' . (int) $userId, $secret), 0, 24);
    }

    /** Opaque grant fingerprint — lets the widget skip re-binding the same grant on every page. */
    public static function binding($secret, $grantId)
    {
        return substr(hash_hmac('sha256', 'binding:' . $grantId, $secret), 0, 24);
    }
}
