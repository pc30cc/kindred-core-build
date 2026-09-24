<?php

namespace WebYar\Whmcs\Readers;

use WebYar\Whmcs\Links;
use WebYar\Whmcs\Text;
use WHMCS\Database\Capsule;

/**
 * Invoices of ONE client account (ownership in every WHERE). Drafts are never
 * returned — WHMCS does not show them to customers either.
 *
 * Balance = total − Σ(amountin − amountout) over the invoice's transactions,
 * computed by the database on WHMCS's own DECIMAL columns (no PHP float
 * arithmetic). That is the same definition WHMCS uses for an invoice's
 * balance; `total` already has applied credit deducted.
 *
 * Never selected: payment method tokens, gateway data, notes.
 */
final class Invoices
{
    const FILTERS = array('unpaid', 'overdue');

    private static function base($clientId)
    {
        return Capsule::table('tblinvoices')
            ->where('tblinvoices.userid', (int) $clientId)
            ->where('tblinvoices.status', '!=', 'Draft');
    }

    private static function columns()
    {
        return array(
            'tblinvoices.id', 'tblinvoices.invoicenum', 'tblinvoices.date', 'tblinvoices.duedate',
            'tblinvoices.datepaid', 'tblinvoices.total', 'tblinvoices.status',
            Capsule::raw('(tblinvoices.total - COALESCE((SELECT SUM(a.amountin - a.amountout) FROM tblaccounts a WHERE a.invoiceid = tblinvoices.id), 0)) AS balance'),
        );
    }

    /** @return array<string,mixed> */
    public static function listForClient($clientId, $limit, $filter)
    {
        $limit = max(1, min(10, (int) $limit));
        $query = self::base($clientId);
        if ($filter === 'unpaid' || $filter === 'overdue') {
            $query->where('tblinvoices.status', 'Unpaid');
            if ($filter === 'overdue') {
                $query->where('tblinvoices.duedate', '<', Text::today());
            }
            $query->orderBy('tblinvoices.duedate')->orderBy('tblinvoices.id');
        } else {
            $query->orderBy('tblinvoices.date', 'desc')->orderBy('tblinvoices.id', 'desc');
        }
        $rows = $query->limit($limit + 1)->get(self::columns());
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
    public static function getForClient($clientId, $invoiceId)
    {
        $row = self::base($clientId)->where('tblinvoices.id', (int) $invoiceId)->first(self::columns());
        if (!$row) {
            // Customers quote the sequential number they see on the PDF as often as the id.
            $row = self::base($clientId)->where('tblinvoices.invoicenum', (string) $invoiceId)->first(self::columns());
        }
        if (!$row) {
            return null;
        }
        $item = self::shape($row, Currency::codeForClient($clientId));
        $lines = Capsule::table('tblinvoiceitems')
            ->where('invoiceid', (int) $row->id)
            ->orderBy('id')
            ->limit(10)
            ->get(array('description', 'amount'));
        $item['items'] = array();
        foreach ($lines as $line) {
            $item['items'][] = array('description' => Text::clean($line->description, 200), 'amount' => Text::amount($line->amount));
        }
        return array('item' => $item, 'as_of' => gmdate('c'));
    }

    private static function shape($row, $currency)
    {
        $status = (string) $row->status;
        $due = Text::date($row->duedate);
        return array(
            'id' => (string) $row->id,
            'number' => ((string) $row->invoicenum) !== '' ? Text::clean($row->invoicenum, 40) : (string) $row->id,
            'status' => $status,
            'date' => Text::date($row->date),
            'due_date' => $due,
            'date_paid' => Text::date($row->datepaid),
            'total' => Text::amount($row->total),
            'balance' => Text::amount($row->balance),
            'currency' => $currency,
            'overdue' => $status === 'Unpaid' && $due !== null && substr($due, 0, 10) < Text::today(),
            'view_url' => Links::invoice($row->id),
        );
    }
}
