<?php

namespace WebYar\Whmcs;

use WHMCS\Database\Capsule;

/**
 * Grants: the revocable, session-bound proof behind every private read.
 *
 * A grant says "PHP session S is logged in as WHMCS User U, acting for Client
 * Account C". It is created on a client-area page render, stored in the
 * addon's table and referenced from the PHP session. It ends when:
 *
 *   - the user logs out (UserLogout hook) or logs in again (UserLogin);
 *   - the session switches to another client account (next page render);
 *   - it sits idle longer than IDLE_SECONDS (no client-area page render);
 *   - it is older than ABSOLUTE_SECONDS, whatever the activity;
 *   - the user changes password, or the client account is closed/deleted;
 *   - the administrator disconnects the addon or revokes all grants.
 *
 * Web Yar never decides whether a grant is valid; it asks, on every read.
 *
 * Write cost: one INSERT when a grant starts, at most one UPDATE per
 * REFRESH_SECONDS while a user browses, one UPDATE when it ends. Page loads
 * in between read the grant from the PHP session and touch no table.
 */
final class Grants
{
    const IDLE_SECONDS = 1800;
    const ABSOLUTE_SECONDS = 43200;
    const REFRESH_SECONDS = 300;
    const SESSION_KEY = 'webyar_whmcs_grant';
    const SWEEP_BATCH = 200;

    /** HMAC of the PHP session id — the raw id is never stored. */
    public static function sessionRef($secret)
    {
        $sid = session_id();
        return hash_hmac('sha256', 'session:' . ($sid !== '' ? $sid : 'none'), $secret);
    }

    /**
     * The grant for the current session and (user, client), created or
     * refreshed as needed. Returns the grant id, or null when it could not be
     * stored (the page then simply renders without an assertion).
     *
     * @return string|null
     */
    public static function ensureForSession($userId, $clientId, $secret)
    {
        $now = Platform::now();
        $userId = (int) $userId;
        $clientId = (int) $clientId;
        $current = isset($_SESSION[self::SESSION_KEY]) && is_array($_SESSION[self::SESSION_KEY]) ? $_SESSION[self::SESSION_KEY] : null;

        if ($current !== null) {
            $sameSubject = (int) $current['uid'] === $userId && (int) $current['cid'] === $clientId;
            $alive = (int) $current['exp'] > $now + 60 && (int) $current['abs'] > $now;
            if ($sameSubject && $alive) {
                if ($now - (int) $current['ref'] < self::REFRESH_SECONDS) {
                    return (string) $current['id'];
                }
                $newExpiry = min($now + self::IDLE_SECONDS, (int) $current['abs']);
                try {
                    $updated = Capsule::table('mod_webyar_grants')
                        ->where('id', $current['id'])
                        ->whereNull('revoked_at')
                        ->where('expires_at', '>', $now)
                        ->update(array('refreshed_at' => $now, 'expires_at' => $newExpiry));
                } catch (\Exception $e) {
                    $updated = 0;
                }
                if ($updated > 0) {
                    $current['ref'] = $now;
                    $current['exp'] = $newExpiry;
                    $_SESSION[self::SESSION_KEY] = $current;
                    return (string) $current['id'];
                }
            }
            // Account switch, expiry, or revoked elsewhere: the old grant ends here.
            self::revokeIds(array((string) $current['id']));
            unset($_SESSION[self::SESSION_KEY]);
        }

        $id = bin2hex(random_bytes(16));
        $row = array(
            'id' => $id,
            'user_id' => $userId,
            'client_id' => $clientId,
            'session_ref' => self::sessionRef($secret),
            'created_at' => $now,
            'refreshed_at' => $now,
            'expires_at' => $now + self::IDLE_SECONDS,
            'revoked_at' => null,
        );
        try {
            Capsule::table('mod_webyar_grants')->insert($row);
        } catch (\Exception $e) {
            return null;
        }
        $_SESSION[self::SESSION_KEY] = array(
            'id' => $id,
            'uid' => $userId,
            'cid' => $clientId,
            'ref' => $now,
            'exp' => $now + self::IDLE_SECONDS,
            'abs' => $now + self::ABSOLUTE_SECONDS,
        );
        self::sweep($now);
        return $id;
    }

    /**
     * The read-time check. Every private operation goes through this — a
     * signed request from Web Yar is NOT enough on its own.
     *
     * @return object|null the grant row when valid
     */
    public static function validate($grantId, $userId, $clientId)
    {
        if (!is_string($grantId) || !preg_match('/^[a-f0-9]{32}$/', $grantId)) {
            return null;
        }
        if (!preg_match('/^\d{1,12}$/', (string) $userId) || !preg_match('/^\d{1,12}$/', (string) $clientId)) {
            return null;
        }
        $now = Platform::now();
        try {
            $row = Capsule::table('mod_webyar_grants')->where('id', $grantId)->first();
        } catch (\Exception $e) {
            return null;
        }
        if (!$row || $row->revoked_at !== null) {
            return null;
        }
        if ((int) $row->expires_at <= $now || (int) $row->created_at + self::ABSOLUTE_SECONDS <= $now) {
            return null;
        }
        if ((int) $row->user_id !== (int) $userId || (int) $row->client_id !== (int) $clientId) {
            return null;
        }
        return $row;
    }

    /** UserLogout / UserLogin: end whatever this session had. */
    public static function revokeCurrentSession($secret)
    {
        $ids = array();
        if (isset($_SESSION[self::SESSION_KEY]['id'])) {
            $ids[] = (string) $_SESSION[self::SESSION_KEY]['id'];
        }
        unset($_SESSION[self::SESSION_KEY]);
        $now = Platform::now();
        try {
            if ($ids) {
                self::revokeIds($ids);
            }
            if ($secret !== null && $secret !== '') {
                Capsule::table('mod_webyar_grants')
                    ->where('session_ref', self::sessionRef($secret))
                    ->whereNull('revoked_at')
                    ->update(array('revoked_at' => $now));
            }
        } catch (\Exception $e) {
            // A failed revoke must not break logout; the grant still idles out.
        }
    }

    public static function revokeForUser($userId)
    {
        try {
            Capsule::table('mod_webyar_grants')
                ->where('user_id', (int) $userId)
                ->whereNull('revoked_at')
                ->update(array('revoked_at' => Platform::now()));
        } catch (\Exception $e) {
        }
    }

    public static function revokeForClient($clientId)
    {
        try {
            Capsule::table('mod_webyar_grants')
                ->where('client_id', (int) $clientId)
                ->whereNull('revoked_at')
                ->update(array('revoked_at' => Platform::now()));
        } catch (\Exception $e) {
        }
    }

    public static function revokeAll()
    {
        Capsule::table('mod_webyar_grants')->whereNull('revoked_at')->update(array('revoked_at' => Platform::now()));
    }

    /** @param string[] $ids */
    public static function revokeIds(array $ids)
    {
        if (!$ids) {
            return;
        }
        try {
            Capsule::table('mod_webyar_grants')->whereIn('id', $ids)->whereNull('revoked_at')->update(array('revoked_at' => Platform::now()));
        } catch (\Exception $e) {
        }
    }

    public static function countActive()
    {
        try {
            return (int) Capsule::table('mod_webyar_grants')
                ->whereNull('revoked_at')
                ->where('expires_at', '>', Platform::now())
                ->count();
        } catch (\Exception $e) {
            return 0;
        }
    }

    /** Bounded removal of rows that ended more than a day ago. */
    public static function sweep($now)
    {
        try {
            $ids = Capsule::table('mod_webyar_grants')
                ->where('expires_at', '<', $now - 86400)
                ->orderBy('expires_at')
                ->limit(self::SWEEP_BATCH)
                ->pluck('id');
            $list = array();
            foreach ($ids as $id) {
                $list[] = $id;
            }
            if ($list) {
                Capsule::table('mod_webyar_grants')->whereIn('id', $list)->delete();
            }
        } catch (\Exception $e) {
        }
    }
}
