<?php

namespace WebYar\Whmcs\Api;

use WebYar\Whmcs\Grants;
use WebYar\Whmcs\Permissions;
use WebYar\Whmcs\Platform;
use WebYar\Whmcs\Readers\Catalog;
use WebYar\Whmcs\Readers\Domains;
use WebYar\Whmcs\Readers\Invoices;
use WebYar\Whmcs\Readers\Orders;
use WebYar\Whmcs\Readers\Services;
use WebYar\Whmcs\Readers\Tickets;
use WebYar\Whmcs\Schema;
use WebYar\Whmcs\Settings;
use WebYar\Whmcs\Version;

/**
 * The closed set of operations. Each op names its section, the capability
 * it needs, and — for account ops — the WHMCS user permission it needs on
 * the client account. Anything not in OPS is rejected; there is no generic
 * API, SQL or proxy path.
 *
 * For every account op, in this order:
 *   1. the WHMCS admin allowed the section (addon settings);
 *   2. the grant is live and names exactly this user + client account;
 *   3. the client account is not closed;
 *   4. the user holds the permission on that account (live, not cached);
 *   5. the reader's own query is scoped to that account.
 */
final class Router
{
    const OPS = array(
        'health' => array('section' => null, 'capability' => null, 'permission' => null),
        'catalog.search' => array('section' => 'catalog', 'capability' => 'catalog.read', 'permission' => null),
        'catalog.browse' => array('section' => 'catalog', 'capability' => 'catalog.read', 'permission' => null),
        'session.check' => array('section' => null, 'capability' => null, 'permission' => null, 'grant' => true),
        'services.list' => array('section' => 'services', 'capability' => 'account.services.read', 'permission' => 'products'),
        'services.get' => array('section' => 'services', 'capability' => 'account.services.read', 'permission' => 'products'),
        'domains.list' => array('section' => 'domains', 'capability' => 'account.domains.read', 'permission' => 'domains'),
        'domains.get' => array('section' => 'domains', 'capability' => 'account.domains.read', 'permission' => 'domains'),
        'invoices.list' => array('section' => 'invoices', 'capability' => 'account.invoices.read', 'permission' => 'invoices'),
        'invoices.get' => array('section' => 'invoices', 'capability' => 'account.invoices.read', 'permission' => 'invoices'),
        'orders.list' => array('section' => 'orders', 'capability' => 'account.orders.read', 'permission' => 'orders'),
        'orders.get' => array('section' => 'orders', 'capability' => 'account.orders.read', 'permission' => 'orders'),
        'tickets.list' => array('section' => 'tickets', 'capability' => 'account.tickets.read', 'permission' => 'tickets'),
        'tickets.get' => array('section' => 'tickets', 'capability' => 'account.tickets.read', 'permission' => 'tickets'),
    );

    /**
     * @param array<string,mixed> $request decoded body
     * @return array{0:int,1:array<string,mixed>} [status, payload]
     */
    public static function dispatch(array $request)
    {
        $op = isset($request['op']) && is_string($request['op']) ? $request['op'] : '';
        if (!isset(self::OPS[$op])) {
            return self::error(400, 'unknown_op');
        }
        $spec = self::OPS[$op];
        $params = isset($request['params']) && is_array($request['params']) ? $request['params'] : array();

        if ($op === 'health') {
            return self::ok(self::health());
        }

        if ($spec['section'] !== null && !Settings::sectionEnabled($spec['section'])) {
            return self::error(403, 'feature_disabled');
        }
        if ($spec['capability'] !== null && !in_array($spec['capability'], Schema::supportedCapabilities(), true)) {
            return self::error(409, 'schema_unsupported');
        }

        if ($spec['section'] === 'catalog') {
            if ($op === 'catalog.search') {
                $query = isset($params['q']) && is_string($params['q']) ? substr($params['q'], 0, 160) : '';
                return self::ok(Catalog::search($query, self::limit($params, Catalog::MAX_RESULTS)));
            }
            return self::ok(Catalog::browse(self::limit($params, Catalog::MAX_BROWSE)));
        }

        // ── Everything below is account data: the grant is mandatory. ──
        $grant = isset($request['grant']) && is_array($request['grant']) ? $request['grant'] : null;
        if ($grant === null) {
            return self::error(403, 'grant_invalid');
        }
        $grantId = isset($grant['id']) ? (string) $grant['id'] : '';
        $userId = isset($grant['uid']) ? (string) $grant['uid'] : '';
        $clientId = isset($grant['cid']) ? (string) $grant['cid'] : '';
        if (!Grants::validate($grantId, $userId, $clientId) || !Permissions::clientIsActive($clientId)) {
            return self::error(403, 'grant_invalid');
        }
        $permissions = Permissions::forUserOnClient($userId, $clientId);

        if ($op === 'session.check') {
            return self::ok(array('valid' => true, 'permissions' => $permissions));
        }
        if (!in_array($spec['permission'], $permissions, true)) {
            return self::error(403, 'permission_denied');
        }

        $limit = self::limit($params, 10);
        $filter = isset($params['filter']) && is_string($params['filter']) ? $params['filter'] : null;
        $id = isset($params['id']) && preg_match('/^\d{1,12}$/', (string) $params['id']) ? (string) $params['id'] : null;

        switch ($op) {
            case 'services.list':
                return self::ok(Services::listForClient($clientId, $limit));
            case 'domains.list':
                return self::ok(Domains::listForClient($clientId, $limit));
            case 'invoices.list':
                return self::ok(Invoices::listForClient($clientId, $limit, in_array($filter, Invoices::FILTERS, true) ? $filter : null));
            case 'orders.list':
                return self::ok(Orders::listForClient($clientId, $limit));
            case 'tickets.list':
                return self::ok(Tickets::listForClient($clientId, $limit, $filter === 'open' ? 'open' : null));
        }

        // Single-item ops: an id is required, and "not yours" == "not found".
        if ($op === 'tickets.get') {
            $tid = isset($params['tid']) && is_string($params['tid']) && preg_match('/^[A-Za-z0-9-]{1,20}$/', $params['tid']) ? $params['tid'] : null;
            if ($id === null && $tid === null) {
                return self::error(400, 'invalid_params');
            }
            $found = Tickets::getForClient($clientId, $id, $tid);
        } else {
            if ($id === null) {
                return self::error(400, 'invalid_params');
            }
            switch ($op) {
                case 'services.get':
                    $found = Services::getForClient($clientId, $id);
                    break;
                case 'domains.get':
                    $found = Domains::getForClient($clientId, $id);
                    break;
                case 'invoices.get':
                    $found = Invoices::getForClient($clientId, $id);
                    break;
                case 'orders.get':
                    $found = Orders::getForClient($clientId, $id);
                    break;
                default:
                    $found = null;
            }
        }
        return $found === null ? self::error(404, 'not_found') : self::ok($found);
    }

    /** @return array<string,mixed> */
    public static function health()
    {
        $capabilities = array('identity.grant', 'widget.bootstrap');
        foreach (Schema::supportedCapabilities() as $capability) {
            $section = self::sectionOf($capability);
            if ($section === null || Settings::sectionEnabled($section)) {
                $capabilities[] = $capability;
            }
        }
        return array(
            'protocol_version' => Version::PROTOCOL,
            'addon_version' => Version::ADDON,
            'whmcs_version' => Platform::whmcsVersion(),
            'php_version' => PHP_VERSION,
            'capabilities' => $capabilities,
            'schema_ok' => count(Schema::supportedCapabilities()) === count(Schema::CAPABILITY_TABLES),
            'system_url' => Platform::systemUrl(),
        );
    }

    private static function sectionOf($capability)
    {
        $map = array(
            'catalog.read' => 'catalog',
            'account.services.read' => 'services',
            'account.domains.read' => 'domains',
            'account.invoices.read' => 'invoices',
            'account.orders.read' => 'orders',
            'account.tickets.read' => 'tickets',
        );
        return isset($map[$capability]) ? $map[$capability] : null;
    }

    private static function limit(array $params, $max)
    {
        $limit = isset($params['limit']) ? (int) $params['limit'] : $max;
        return max(1, min($max, $limit));
    }

    private static function ok($data)
    {
        return array(200, array('ok' => true, 'data' => $data));
    }

    private static function error($status, $code)
    {
        return array($status, array('ok' => false, 'error' => $code));
    }
}
