<?php

namespace WebYar\Whmcs;

use WebYar\Whmcs\Readers\Currency;
use WHMCS\Database\Capsule;

/**
 * What a WHMCS User may see on a Client Account — checked live on every
 * private read.
 *
 * WHMCS 8 separates the person who logs in (User) from the account they act
 * for (Client Account). An owner has every permission; any other user has the
 * comma-separated list WHMCS stores for that pair (the same format
 * `UpdateUserPermissions` takes). The names are WHMCS's own
 * (`GetPermissionsList`): profile, contacts, products, manageproducts,
 * productsso, domains, managedomains, invoices, quotes, tickets, affiliates,
 * emails, orders.
 *
 * Source, in order:
 *   1. the user↔client pivot, one indexed SELECT, when its columns exist;
 *   2. the documented Local API `GetUserPermissions`, parsed defensively;
 *   3. neither answers → NO permissions (fail closed).
 */
final class Permissions
{
    const ALL = array(
        'profile', 'contacts', 'products', 'manageproducts', 'productsso', 'domains',
        'managedomains', 'invoices', 'quotes', 'tickets', 'affiliates', 'emails', 'orders',
    );

    /**
     * Closed accounts cannot be read, whatever the grant says. The same row
     * also yields the account's billing currency, so the readers do not ask
     * for it again.
     */
    public static function clientIsActive($clientId)
    {
        try {
            $row = Capsule::table('tblclients')
                ->leftJoin('tblcurrencies', 'tblcurrencies.id', '=', 'tblclients.currency')
                ->where('tblclients.id', (int) $clientId)
                ->first(array('tblclients.status', 'tblcurrencies.code'));
        } catch (\Exception $e) {
            return false;
        }
        if (!$row) {
            return false;
        }
        Currency::prime($clientId, $row->code);
        return strcasecmp((string) $row->status, 'Closed') !== 0;
    }

    /** @return string[] */
    public static function forUserOnClient($userId, $clientId)
    {
        $userId = (int) $userId;
        $clientId = (int) $clientId;
        if ($userId <= 0 || $clientId <= 0) {
            return array();
        }

        if (Schema::has('tblusers_clients.pivot')) {
            try {
                $row = Capsule::table('tblusers_clients')
                    ->where('auth_user_id', $userId)
                    ->where('client_id', $clientId)
                    ->first(array('owner', 'permissions'));
            } catch (\Exception $e) {
                $row = null;
            }
            if (!$row) {
                return array();
            }
            if ((int) $row->owner === 1) {
                return self::ALL;
            }
            return self::parse($row->permissions);
        }

        $result = Platform::localApi('GetUserPermissions', array('user_id' => $userId, 'client_id' => $clientId));
        if (!isset($result['result']) || $result['result'] !== 'success') {
            return array();
        }
        if (!empty($result['owner']) || !empty($result['isOwner'])) {
            return self::ALL;
        }
        if (isset($result['permissions'])) {
            $raw = $result['permissions'];
            if (is_array($raw) && isset($raw['permission'])) {
                $raw = $raw['permission'];
            }
            return self::parse($raw);
        }
        return array();
    }

    /** @return string[] */
    public static function parse($raw)
    {
        if (is_string($raw)) {
            $raw = explode(',', $raw);
        }
        if (!is_array($raw)) {
            return array();
        }
        $out = array();
        foreach ($raw as $name) {
            $name = strtolower(trim((string) $name));
            if (in_array($name, self::ALL, true) && !in_array($name, $out, true)) {
                $out[] = $name;
            }
        }
        return $out;
    }
}
