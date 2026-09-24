<?php

namespace WebYar\Whmcs\Readers;

use WebYar\Whmcs\Links;
use WebYar\Whmcs\Text;
use WHMCS\Database\Capsule;

/**
 * Orders of ONE client account. Three separate facts are kept separate:
 * the ORDER status (Pending/Active/Fraud/Cancelled), the PAYMENT status (its
 * invoice's status) and each item's own provisioning/registration status.
 *
 * Never selected: IP address, fraud module output, order notes, promo data,
 * transfer secrets, nameservers, serialized order data.
 */
final class Orders
{
    private static function base($clientId)
    {
        return Capsule::table('tblorders')
            ->leftJoin('tblinvoices', function ($join) use ($clientId) {
                // The invoice must belong to the same client, or it is not joined at all.
                $join->on('tblinvoices.id', '=', 'tblorders.invoiceid')
                    ->where('tblinvoices.userid', '=', (int) $clientId);
            })
            ->where('tblorders.userid', (int) $clientId);
    }

    private static function columns()
    {
        return array(
            'tblorders.id', 'tblorders.ordernum', 'tblorders.date', 'tblorders.amount',
            'tblorders.status', 'tblorders.invoiceid', 'tblinvoices.status as payment_status',
        );
    }

    /** @return array<string,mixed> */
    public static function listForClient($clientId, $limit)
    {
        $limit = max(1, min(10, (int) $limit));
        $rows = self::base($clientId)
            ->orderBy('tblorders.date', 'desc')
            ->orderBy('tblorders.id', 'desc')
            ->limit($limit + 1)
            ->get(self::columns());
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
    public static function getForClient($clientId, $orderId)
    {
        $row = self::base($clientId)->where('tblorders.id', (int) $orderId)->first(self::columns());
        if (!$row) {
            $row = self::base($clientId)->where('tblorders.ordernum', (string) $orderId)->first(self::columns());
        }
        if (!$row) {
            return null;
        }
        $item = self::shape($row, Currency::codeForClient($clientId));
        $item['items'] = array();
        $services = Capsule::table('tblhosting')
            ->leftJoin('tblproducts', 'tblproducts.id', '=', 'tblhosting.packageid')
            ->where('tblhosting.orderid', (int) $row->id)
            ->where('tblhosting.userid', (int) $clientId)
            ->limit(10)
            ->get(array('tblproducts.name as name', 'tblhosting.domain', 'tblhosting.domainstatus as status'));
        foreach ($services as $service) {
            $label = trim((string) $service->name . ($service->domain ? ' — ' . $service->domain : ''));
            $item['items'][] = array('kind' => 'service', 'name' => Text::clean($label, 200), 'status' => (string) $service->status);
        }
        $domains = Capsule::table('tbldomains')
            ->where('orderid', (int) $row->id)
            ->where('userid', (int) $clientId)
            ->limit(10)
            ->get(array('domain', 'status'));
        foreach ($domains as $domain) {
            $item['items'][] = array('kind' => 'domain', 'name' => Text::clean($domain->domain, 200), 'status' => (string) $domain->status);
        }
        $item['items'] = array_slice($item['items'], 0, 10);
        return array('item' => $item, 'as_of' => gmdate('c'));
    }

    private static function shape($row, $currency)
    {
        $invoiceId = (int) $row->invoiceid;
        return array(
            'id' => (string) $row->id,
            'number' => ((string) $row->ordernum) !== '' ? Text::clean($row->ordernum, 40) : (string) $row->id,
            'status' => (string) $row->status,
            'payment_status' => $row->payment_status !== null ? (string) $row->payment_status : null,
            'date' => Text::date($row->date),
            'amount' => Text::amount($row->amount),
            'currency' => $currency,
            'invoice_id' => $invoiceId > 0 && $row->payment_status !== null ? (string) $invoiceId : null,
            'view_url' => $invoiceId > 0 && $row->payment_status !== null ? Links::invoice($invoiceId) : null,
        );
    }
}
