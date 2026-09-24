<?php

namespace WebYar\Whmcs\Readers;

use WebYar\Whmcs\Links;
use WebYar\Whmcs\Text;
use WHMCS\Database\Capsule;

/**
 * Products/services of ONE client account. Ownership is part of every query
 * (`tblhosting.userid = <client>`), so an id that belongs to someone else is
 * simply "not found" — never "found, but not yours".
 *
 * Only billing facts WHMCS itself shows the customer are selected. Never
 * selected: username, password, server, dedicated/assigned IPs, notes,
 * subscription ids, usage counters.
 */
final class Services
{
    private static function base($clientId)
    {
        return Capsule::table('tblhosting')
            ->leftJoin('tblproducts', 'tblproducts.id', '=', 'tblhosting.packageid')
            ->leftJoin('tblproductgroups', 'tblproductgroups.id', '=', 'tblproducts.gid')
            ->where('tblhosting.userid', (int) $clientId);
    }

    /** @return array<string,mixed> */
    public static function listForClient($clientId, $limit)
    {
        $limit = max(1, min(10, (int) $limit));
        $rows = self::base($clientId)
            ->orderByRaw("CASE WHEN tblhosting.domainstatus IN ('Active','Suspended','Pending') THEN 0 ELSE 1 END")
            ->orderBy('tblhosting.nextduedate')
            ->orderBy('tblhosting.id', 'desc')
            ->limit($limit + 1)
            ->get(array(
                'tblhosting.id', 'tblhosting.domain', 'tblhosting.domainstatus', 'tblhosting.billingcycle',
                'tblhosting.nextduedate', 'tblhosting.amount',
                'tblproducts.name as product', 'tblproductgroups.name as grp',
            ));
        $currency = Currency::codeForClient($clientId);
        $items = array();
        foreach ($rows as $i => $row) {
            if ($i >= $limit) {
                break;
            }
            $items[] = self::shape($row, $currency);
        }
        return array('items' => $items, 'has_more' => count($rows) > $limit, 'as_of' => gmdate('c'));
    }

    /** @return array<string,mixed>|null */
    public static function getForClient($clientId, $serviceId)
    {
        $row = self::base($clientId)
            ->where('tblhosting.id', (int) $serviceId)
            ->first(array(
                'tblhosting.id', 'tblhosting.domain', 'tblhosting.domainstatus', 'tblhosting.billingcycle',
                'tblhosting.nextduedate', 'tblhosting.amount', 'tblhosting.firstpaymentamount',
                'tblhosting.regdate', 'tblhosting.suspendreason',
                'tblproducts.name as product', 'tblproductgroups.name as grp',
            ));
        if (!$row) {
            return null;
        }
        $currency = Currency::codeForClient($clientId);
        $item = self::shape($row, $currency);
        $status = (string) $row->domainstatus;
        $item['registered_at'] = Text::date($row->regdate);
        $item['first_payment_amount'] = Text::amount($row->firstpaymentamount);
        // Shown to the customer by WHMCS on the service page — only while suspended.
        $item['suspension_reason'] = $status === 'Suspended' ? Text::clean($row->suspendreason, 200) : null;
        $due = Text::date($row->nextduedate);
        $item['overdue'] = $due !== null && substr($due, 0, 10) < Text::today() && in_array($status, array('Active', 'Suspended'), true);
        return array('item' => $item, 'as_of' => gmdate('c'));
    }

    private static function shape($row, $currency)
    {
        return array(
            'id' => (string) $row->id,
            'product' => Text::clean($row->product, 120),
            'group' => Text::clean($row->grp, 120),
            'domain' => Text::clean($row->domain, 253),
            'status' => (string) $row->domainstatus,
            'billing_cycle' => Text::clean($row->billingcycle, 40),
            'next_due_date' => Text::date($row->nextduedate),
            'recurring_amount' => Text::amount($row->amount),
            'currency' => $currency,
            'manage_url' => Links::service($row->id),
        );
    }
}
