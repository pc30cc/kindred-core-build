<?php

namespace WebYar\Whmcs\Readers;

use WebYar\Whmcs\Platform;
use WebYar\Whmcs\Text;
use WHMCS\Database\Capsule;

/** Bounded, read-only excerpts. No view counters, full-table exports or localAPI writes. */
final class Content
{
    const MAX_ITEMS = 5;
    const MAX_CATEGORIES = 512;

    public static function read($section, array $params)
    {
        $limit = max(1, min(self::MAX_ITEMS, isset($params['limit']) ? (int) $params['limit'] : self::MAX_ITEMS));
        $query = isset($params['q']) && is_string($params['q']) ? Text::clean($params['q'], 80) : '';
        $terms = Catalog::terms($query);
        $locale = isset($params['locale']) ? (string) $params['locale'] : '';
        $items = array();
        $base = Platform::systemUrl();

        if ($section === 'announcements') {
            $q = Capsule::table('tblannouncements')->where('parentid', 0)
                ->where('published', 1)->where('date', '<=', date('Y-m-d H:i:s', Platform::now()));
            $rows = $q->orderBy('date', 'desc')->orderBy('id', 'desc')->limit($limit + 1)
                ->get(array('id', 'title', 'date', Capsule::raw('SUBSTR(announcement, 1, 4096) as body')))->all();
            $more = count($rows) > $limit;
            $rows = array_slice($rows, 0, $limit);
            $translations = self::translations('tblannouncements', 'announcement', $rows, $locale);
            foreach ($rows as $r) {
                $tr = isset($translations[(int) $r->id]) ? $translations[(int) $r->id] : $r;
                $items[] = self::item($r->id, $tr->title, $tr->body, $base . '/announcements.php?id=' . (int) $r->id, $r->date, null, null);
            }
        } elseif ($section === 'knowledgebase') {
            // Category ancestors can hide an otherwise public article. Read a
            // bounded category tree once; cycles, missing parents and oversized
            // trees fail closed. Category translations are never parent nodes.
            $cats = Capsule::table('tblknowledgebasecats')->where('catid', 0)
                ->limit(self::MAX_CATEGORIES + 1)->get(array('id', 'parentid', 'hidden'))->all();
            if (count($cats) > self::MAX_CATEGORIES) {
                return array('items' => array(), 'has_more' => true, 'as_of' => gmdate('c', Platform::now()), 'limited' => true);
            }
            $tree = array();
            foreach ($cats as $cat) { $tree[(int) $cat->id] = $cat; }
            $visible = array();
            foreach ($tree as $id => $cat) {
                $seen = array();
                $current = $id;
                while ($current !== 0 && isset($tree[$current]) && !isset($seen[$current]) && count($seen) < 32) {
                    $node = $tree[$current];
                    if (!in_array((string) $node->hidden, array('', '0'), true)) { break; }
                    $seen[$current] = true;
                    $current = (int) $node->parentid;
                }
                if ($current === 0) { $visible[] = $id; }
            }
            if (!$visible) { return self::page(array(), false); }
            $q = Capsule::table('tblknowledgebase as kb')->where('kb.parentid', 0)
                ->whereIn('kb.private', array('', '0'))
                ->whereExists(function ($sub) use ($visible) {
                    $sub->select(Capsule::raw('1'))->from('tblknowledgebaselinks as l')
                        ->whereColumn('l.articleid', 'kb.id')->whereIn('l.categoryid', $visible);
                })
                // Conservatively exclude articles also linked into a hidden
                // or unknown category, even if another link is public.
                ->whereNotExists(function ($sub) use ($visible) {
                    $sub->select(Capsule::raw('1'))->from('tblknowledgebaselinks as l')
                        ->whereColumn('l.articleid', 'kb.id')->whereNotIn('l.categoryid', $visible);
                });
            if ($terms) {
                $languages = self::languages($locale);
                $q->where(function ($sub) use ($terms, $languages) {
                    foreach ($terms as $term) {
                        $like = '%' . str_replace(array('\\', '%', '_'), array('\\\\', '\\%', '\\_'), $term) . '%';
                        $sub->orWhere('kb.title', 'like', $like)->orWhereRaw('SUBSTR(kb.article, 1, 4096) LIKE ?', array($like));
                    }
                    if ($languages) {
                        $sub->orWhereExists(function ($tr) use ($terms, $languages) {
                            $tr->select(Capsule::raw('1'))->from('tblknowledgebase as tr')
                                ->whereColumn('tr.parentid', 'kb.id')->whereIn('tr.language', $languages)
                                ->whereIn('tr.private', array('', '0'))->where(function ($match) use ($terms) {
                                    foreach ($terms as $term) {
                                        $like = '%' . str_replace(array('\\', '%', '_'), array('\\\\', '\\%', '\\_'), $term) . '%';
                                        $match->orWhere('tr.title', 'like', $like)->orWhereRaw('SUBSTR(tr.article, 1, 4096) LIKE ?', array($like));
                                    }
                                });
                        });
                    }
                });
            }
            $rows = $q->orderBy('kb.id', 'desc')->limit($limit + 1)
                ->get(array('kb.id', 'kb.title', Capsule::raw('SUBSTR(kb.article, 1, 4096) as body')))->all();
            $more = count($rows) > $limit;
            $rows = array_slice($rows, 0, $limit);
            $translations = self::translations('tblknowledgebase', 'article', $rows, $locale);
            foreach ($rows as $r) {
                $tr = isset($translations[(int) $r->id]) ? $translations[(int) $r->id] : $r;
                $items[] = self::item($r->id, $tr->title, $tr->body, $base . '/knowledgebase.php?action=displayarticle&id=' . (int) $r->id, null, null, null);
            }
        } elseif ($section === 'networkstatus') {
            // Router has already applied NetworkIssuesRequireLogin and the
            // live grant check. Internal server ids/names/IPs are not selected.
            $rows = Capsule::table('tblnetworkissues')->where('status', '<>', 'Resolved')
                ->orderBy('lastupdate', 'desc')->orderBy('id', 'desc')->limit($limit + 1)
                ->get(array('id', 'title', 'status', 'startdate', 'lastupdate', Capsule::raw('SUBSTR(description, 1, 4096) as body')))->all();
            $more = count($rows) > $limit;
            foreach (array_slice($rows, 0, $limit) as $r) {
                $items[] = self::item($r->id, $r->title, $r->body, $base . '/networkstatus.php', $r->startdate, $r->lastupdate, $r->status);
            }
        } else {
            return self::page(array(), false);
        }
        return self::page($items, $more);
    }

    private static function translations($table, $bodyColumn, array $rows, $locale)
    {
        $languages = self::languages($locale);
        if (!$rows || !$languages) { return array(); }
        $ids = array_map(function ($r) { return (int) $r->id; }, $rows);
        $q = Capsule::table($table)->whereIn('parentid', $ids)->whereIn('language', $languages);
        if ($table === 'tblknowledgebase') { $q->whereIn('private', array('', '0')); }
        else { $q->where('published', 1)->where('date', '<=', date('Y-m-d H:i:s', Platform::now())); }
        $translated = $q->orderBy('id')->limit(self::MAX_ITEMS * 2)
            ->get(array('parentid', 'title', Capsule::raw('SUBSTR(' . $bodyColumn . ', 1, 4096) as body')));
        $result = array();
        foreach ($translated as $row) { $result[(int) $row->parentid] = $row; }
        return $result;
    }

    private static function languages($locale)
    {
        $languages = array('fa' => array('farsi', 'persian'), 'tr' => array('turkish'), 'en' => array('english'));
        return isset($languages[$locale]) ? $languages[$locale] : array();
    }

    private static function item($id, $title, $body, $url, $published, $updated, $status)
    {
        return array('id' => Text::id($id), 'title' => Text::clean($title, 160),
            'excerpt' => Text::clean($body, 699), 'url' => $url,
            'published_at' => Text::date($published), 'updated_at' => Text::date($updated),
            'status' => Text::clean($status, 40));
    }

    private static function page(array $items, $more)
    {
        return array('items' => $items, 'has_more' => $more, 'as_of' => gmdate('c', Platform::now()));
    }
}
