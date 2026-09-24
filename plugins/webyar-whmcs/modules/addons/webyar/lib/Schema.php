<?php

namespace WebYar\Whmcs;

use WHMCS\Database\Capsule;

/**
 * The addon's own tables, and the WHMCS core columns its readers depend on.
 *
 * Own tables (created on activate, dropped on deactivate — they hold nothing
 * that belongs to WHMCS):
 *   mod_webyar_settings  key/value settings; the installation secret is
 *                        stored encrypted with WHMCS's own EncryptPassword
 *   mod_webyar_grants    one row per (PHP session, user, client account):
 *                        the revocable proof behind every private read
 *   mod_webyar_nonces    replay guard for signed requests (10-minute rows)
 *
 * Core columns are CHECKED, never altered. A WHMCS version whose schema does
 * not have them makes the affected capability disappear from the handshake
 * (and `schema_ok` false) instead of letting a reader guess.
 */
final class Schema
{
    /** @var array<string,string[]> */
    const REQUIRED = array(
        'tblclients' => array('id', 'currency', 'status'),
        'tblcurrencies' => array('id', 'code', 'prefix', 'suffix', 'default'),
        'tblhosting' => array('id', 'userid', 'orderid', 'packageid', 'domain', 'domainstatus', 'billingcycle', 'nextduedate', 'amount', 'firstpaymentamount', 'regdate', 'suspendreason'),
        'tblproducts' => array('id', 'gid', 'name', 'description', 'hidden', 'paytype', 'tax'),
        'tblproductgroups' => array('id', 'name', 'hidden'),
        'tbldomains' => array('id', 'userid', 'orderid', 'domain', 'status', 'registrationdate', 'expirydate', 'nextduedate', 'recurringamount', 'registrationperiod', 'donotrenew'),
        'tblinvoices' => array('id', 'userid', 'invoicenum', 'date', 'duedate', 'datepaid', 'total', 'status'),
        'tblinvoiceitems' => array('id', 'invoiceid', 'description', 'amount'),
        'tblaccounts' => array('invoiceid', 'amountin', 'amountout'),
        'tblorders' => array('id', 'ordernum', 'userid', 'date', 'amount', 'status', 'invoiceid'),
        'tbltickets' => array('id', 'tid', 'did', 'userid', 'title', 'message', 'status', 'urgency', 'date', 'lastreply'),
        'tblticketreplies' => array('id', 'tid', 'admin', 'message', 'date'),
        'tblticketdepartments' => array('id', 'name'),
    );

    /** Which capability each core table backs. */
    const CAPABILITY_TABLES = array(
        'catalog.read' => array('tblproducts', 'tblproductgroups', 'tblcurrencies'),
        'account.services.read' => array('tblhosting', 'tblproducts', 'tblclients', 'tblcurrencies'),
        'account.domains.read' => array('tbldomains', 'tblclients', 'tblcurrencies'),
        'account.invoices.read' => array('tblinvoices', 'tblinvoiceitems', 'tblaccounts', 'tblclients', 'tblcurrencies'),
        'account.orders.read' => array('tblorders', 'tblinvoices', 'tblhosting', 'tbldomains', 'tblclients', 'tblcurrencies'),
        'account.tickets.read' => array('tbltickets', 'tblticketreplies', 'tblticketdepartments'),
    );

    public static function install()
    {
        $schema = Capsule::schema();
        if (!$schema->hasTable('mod_webyar_settings')) {
            $schema->create('mod_webyar_settings', function ($table) {
                $table->string('name', 64)->primary();
                $table->text('value')->nullable();
            });
        }
        if (!$schema->hasTable('mod_webyar_grants')) {
            $schema->create('mod_webyar_grants', function ($table) {
                $table->string('id', 32)->primary();
                $table->unsignedInteger('user_id');
                $table->unsignedInteger('client_id');
                $table->string('session_ref', 64)->index();
                $table->unsignedInteger('created_at');
                $table->unsignedInteger('refreshed_at');
                $table->unsignedInteger('expires_at')->index();
                $table->unsignedInteger('revoked_at')->nullable();
                $table->index(array('user_id', 'revoked_at'));
            });
        }
        if (!$schema->hasTable('mod_webyar_nonces')) {
            $schema->create('mod_webyar_nonces', function ($table) {
                $table->string('nonce', 64)->primary();
                $table->unsignedInteger('expires_at')->index();
            });
        }
    }

    /** Drops ONLY the addon's own tables. No WHMCS data is ever touched. */
    public static function uninstall()
    {
        $schema = Capsule::schema();
        foreach (array('mod_webyar_nonces', 'mod_webyar_grants', 'mod_webyar_settings') as $table) {
            $schema->dropIfExists($table);
        }
    }

    /**
     * Columns the readers use when present and do without otherwise. Checked
     * at activation/upgrade/"Check connection" and cached in settings, so an
     * ordinary request never runs schema introspection.
     */
    const OPTIONAL = array(
        'tblproducts.retired' => array('tblproducts', array('retired')),
        'tblproducts.order' => array('tblproducts', array('order')),
        'tblproductgroups.order' => array('tblproductgroups', array('order')),
        'tbltickets.merged_ticket_id' => array('tbltickets', array('merged_ticket_id')),
        'tblusers_clients.pivot' => array('tblusers_clients', array('auth_user_id', 'client_id', 'owner', 'permissions')),
    );

    /** @var array<string,bool>|null */
    private static $columnCache = null;

    /** @return bool */
    public static function hasColumns($table, array $columns)
    {
        $key = $table . ':' . implode(',', $columns);
        if (self::$columnCache === null) {
            self::$columnCache = array();
        }
        if (!array_key_exists($key, self::$columnCache)) {
            try {
                self::$columnCache[$key] = Capsule::schema()->hasTable($table) && Capsule::schema()->hasColumns($table, $columns);
            } catch (\Exception $e) {
                self::$columnCache[$key] = false;
            }
        }
        return self::$columnCache[$key];
    }

    public static function resetCache()
    {
        self::$columnCache = null;
    }

    /** Whether an optional column set exists — from the cached introspection. */
    public static function has($optionalKey)
    {
        $cached = json_decode((string) Settings::get('schema_optional'), true);
        if (!is_array($cached) || !array_key_exists($optionalKey, $cached)) {
            $cached = self::introspectOptional();
        }
        return !empty($cached[$optionalKey]);
    }

    /** @return array<string,bool> */
    private static function introspectOptional()
    {
        $result = array();
        foreach (self::OPTIONAL as $key => $spec) {
            $result[$key] = self::hasColumns($spec[0], $spec[1]);
        }
        Settings::set('schema_optional', json_encode($result));
        return $result;
    }

    /**
     * Capabilities whose tables are all present with the needed columns.
     * Cached in settings so a normal request never runs schema introspection.
     *
     * @return string[]
     */
    public static function supportedCapabilities($useCache = true)
    {
        if ($useCache) {
            $cached = Settings::get('schema_capabilities');
            if ($cached !== null) {
                $decoded = json_decode($cached, true);
                if (is_array($decoded)) {
                    return $decoded;
                }
            }
        }
        $supported = array();
        foreach (self::CAPABILITY_TABLES as $capability => $tables) {
            $ok = true;
            foreach ($tables as $table) {
                if (!self::hasColumns($table, self::REQUIRED[$table])) {
                    $ok = false;
                    break;
                }
            }
            if ($ok) {
                $supported[] = $capability;
            }
        }
        Settings::set('schema_capabilities', json_encode($supported));
        if (!$useCache) {
            self::introspectOptional();
        }
        return $supported;
    }
}
