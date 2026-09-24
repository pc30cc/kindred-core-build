<?php

namespace WebYar\Whmcs\Readers;

use WebYar\Whmcs\Links;
use WebYar\Whmcs\Schema;
use WebYar\Whmcs\Text;
use WHMCS\Database\Capsule;

/**
 * Support tickets of ONE client account.
 *
 * The list reads ticket headers only — never message bodies. A single ticket
 * adds at most MAX_REPLIES customer-visible entries, each cut to
 * MAX_REPLY_CHARS. Staff replies are labelled "staff" without the staff
 * member's name.
 *
 * Never read at all: internal ticket notes (tblticketnotes), attachments,
 * CC lists, IP addresses, the per-ticket access key.
 */
final class Tickets
{
    const MAX_REPLIES = 3;
    const MAX_REPLY_CHARS = 600;

    private static function base($clientId)
    {
        $query = Capsule::table('tbltickets')
            ->leftJoin('tblticketdepartments', 'tblticketdepartments.id', '=', 'tbltickets.did')
            ->where('tbltickets.userid', (int) $clientId);
        if (Schema::has('tbltickets.merged_ticket_id')) {
            // A ticket merged into another is shown as the one it was merged into.
            $query->where(function ($q) {
                $q->whereNull('tbltickets.merged_ticket_id')->orWhere('tbltickets.merged_ticket_id', 0);
            });
        }
        return $query;
    }

    private static function columns()
    {
        return array(
            'tbltickets.id', 'tbltickets.tid', 'tbltickets.title', 'tbltickets.status', 'tbltickets.urgency',
            'tbltickets.date', 'tbltickets.lastreply', 'tblticketdepartments.name as department',
        );
    }

    /** @return array<string,mixed> */
    public static function listForClient($clientId, $limit, $filter)
    {
        $limit = max(1, min(10, (int) $limit));
        $query = self::base($clientId);
        if ($filter === 'open') {
            $query->where('tbltickets.status', '!=', 'Closed');
        }
        $rows = $query->orderBy('tbltickets.lastreply', 'desc')->orderBy('tbltickets.id', 'desc')
            ->limit($limit + 1)
            ->get(self::columns());
        $items = array();
        foreach ($rows as $i => $row) {
            if ($i >= $limit) {
                break;
            }
            $items[] = self::shape($row);
        }
        return array('items' => $items, 'has_more' => count($rows) > $limit, 'as_of' => gmdate('c'));
    }

    /** @return array<string,mixed>|null */
    public static function getForClient($clientId, $ticketId, $tid)
    {
        $query = self::base($clientId);
        if ($tid !== null && $tid !== '') {
            $query->where('tbltickets.tid', (string) $tid);
        } else {
            $query->where('tbltickets.id', (int) $ticketId);
        }
        $columns = self::columns();
        $columns[] = 'tbltickets.message';
        $row = $query->first($columns);
        if (!$row) {
            return null;
        }
        $item = self::shape($row);

        $replies = Capsule::table('tblticketreplies')
            ->where('tid', (int) $row->id)
            ->orderBy('date', 'desc')
            ->orderBy('id', 'desc')
            ->limit(self::MAX_REPLIES)
            ->get(array('admin', 'message', 'date'));
        $entries = array();
        foreach ($replies as $reply) {
            $excerpt = Text::clean($reply->message, self::MAX_REPLY_CHARS);
            if ($excerpt === null) {
                continue;
            }
            $entries[] = array(
                'from' => trim((string) $reply->admin) !== '' ? 'staff' : 'customer',
                'date' => Text::date($reply->date),
                'excerpt' => $excerpt,
            );
        }
        if (count($entries) < self::MAX_REPLIES) {
            $opening = Text::clean($row->message, self::MAX_REPLY_CHARS);
            if ($opening !== null) {
                $entries[] = array('from' => 'customer', 'date' => Text::date($row->date), 'excerpt' => $opening);
            }
        }
        $item['replies'] = $entries;
        return array('item' => $item, 'as_of' => gmdate('c'));
    }

    private static function shape($row)
    {
        return array(
            'id' => (string) $row->id,
            'tid' => Text::clean($row->tid, 40),
            'subject' => Text::clean($row->title, 200),
            'status' => (string) $row->status,
            'department' => Text::clean($row->department, 120),
            'priority' => Text::clean($row->urgency, 40),
            'date' => Text::date($row->date),
            'last_reply' => Text::date($row->lastreply),
            'view_url' => Links::tickets(),
        );
    }
}
