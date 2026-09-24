<?php

namespace WebYar\Whmcs\Readers;

use WebYar\Whmcs\Links;
use WebYar\Whmcs\Text;
use WHMCS\Database\Capsule;

/**
 * Domains of ONE client account (ownership in every WHERE). Expiry (registry)
 * and next due date (billing) are returned as the separate facts they are.
 * `donotrenew = 0` is WHMCS's "auto renew on". No EPP codes, nameservers,
 * registrar or contact data are read.
 */
final class Domains
{
    const COLUMNS = array(
        'id', 'domain', 'status', 'registrationdate', 'expirydate', 'nextduedate',
        'recurringamount', 'registrationperiod', 'donotrenew',
    );

    /** @return array<string,mixed> */
    public static function listForClient($clientId, $limit)
    {
        $limit = max(1, min(10, (int) $limit));
        $rows = Capsule::table('tbldomains')
            ->where('userid', (int) $clientId)
            ->orderByRaw("CASE WHEN status IN ('Active','Pending','Pending Transfer','Grace','Redemption') THEN 0 ELSE 1 END")
            ->orderBy('expirydate')
            ->orderBy('id', 'desc')
            ->limit($limit + 1)
            ->get(self::COLUMNS);
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
    public static function getForClient($clientId, $domainId)
    {
        $row = Capsule::table('tbldomains')
            ->where('userid', (int) $clientId)
            ->where('id', (int) $domainId)
            ->first(self::COLUMNS);
        return $row ? array('item' => self::shape($row, Currency::codeForClient($clientId)), 'as_of' => gmdate('c')) : null;
    }

    private static function shape($row, $currency)
    {
        return array(
            'id' => (string) $row->id,
            'domain' => Text::clean($row->domain, 253),
            'status' => (string) $row->status,
            'registration_date' => Text::date($row->registrationdate),
            'expiry_date' => Text::date($row->expirydate),
            'next_due_date' => Text::date($row->nextduedate),
            'recurring_amount' => Text::amount($row->recurringamount),
            'currency' => $currency,
            'registration_period' => (int) $row->registrationperiod,
            'auto_renew' => (int) $row->donotrenew === 0,
            'manage_url' => Links::domain($row->id),
        );
    }
}
