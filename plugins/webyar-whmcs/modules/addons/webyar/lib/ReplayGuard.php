<?php

namespace WebYar\Whmcs;

use WHMCS\Database\Capsule;

/**
 * Nonce replay cache for signed requests. The primary key makes "seen" an
 * atomic insert: a concurrent duplicate fails the insert instead of racing a
 * read. Rows live 2x the signing clock-skew window — a nonce older than that
 * can never validate again because its timestamp fails first — and are swept
 * opportunistically in small bounded batches (no cron).
 */
final class ReplayGuard
{
    const TTL_SECONDS = 600;
    const SWEEP_BATCH = 200;

    /** 1-in-N requests sweeps expired rows; 0 disables (tests use it for exact query counts). */
    public static $sweepOneIn = 50;

    public static function remember($nonce)
    {
        $now = Platform::now();
        try {
            Capsule::table('mod_webyar_nonces')->insert(array(
                'nonce' => substr(hash('sha256', $nonce), 0, 64),
                'expires_at' => $now + self::TTL_SECONDS,
            ));
        } catch (\Exception $e) {
            return false;
        }
        // ~1 in 50 requests pays for a bounded sweep.
        if (self::$sweepOneIn > 0 && random_int(1, self::$sweepOneIn) === 1) {
            self::sweep($now);
        }
        return true;
    }

    public static function sweep($now)
    {
        try {
            $expired = Capsule::table('mod_webyar_nonces')
                ->where('expires_at', '<', $now)
                ->orderBy('expires_at')
                ->limit(self::SWEEP_BATCH)
                ->pluck('nonce');
            $keys = array();
            foreach ($expired as $key) {
                $keys[] = $key;
            }
            if ($keys) {
                Capsule::table('mod_webyar_nonces')->whereIn('nonce', $keys)->delete();
            }
        } catch (\Exception $e) {
            // Cleanup must never fail a request.
        }
    }
}
