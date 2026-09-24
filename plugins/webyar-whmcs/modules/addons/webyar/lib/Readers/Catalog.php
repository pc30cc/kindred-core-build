<?php

namespace WebYar\Whmcs\Readers;

use WebYar\Whmcs\Links;
use WebYar\Whmcs\Platform;
use WebYar\Whmcs\Schema;
use WebYar\Whmcs\Text;
use WHMCS\Database\Capsule;

/**
 * Public plans, bounded.
 *
 * `GetProducts` (Local API) is the official source of prices — WHMCS computes
 * them per currency and cycle — but it has neither a text filter nor
 * pagination, and it does not report whether a product or its group is
 * hidden. So it is never called for "everything":
 *
 *   1. one bounded SELECT picks at most CANDIDATES visible products
 *      (product AND group not hidden, product not retired), optionally
 *      matching the visitor's words against product/group names;
 *   2. `GetProducts` is then asked for exactly those ids (≤ MAX_RESULTS).
 *
 * Hidden or retired products — including the ones WHMCS reserves for
 * specific customers via direct links — never leave this class.
 */
final class Catalog
{
    const MAX_RESULTS = 5;
    const MAX_BROWSE = 10;
    const CANDIDATES = 25;

    /** Words that carry no product meaning in fa/en/tr questions. */
    const STOPWORDS = array(
        'قیمت', 'تعرفه', 'هزینه', 'خرید', 'چند', 'چنده', 'است', 'هست', 'دارید', 'دارین', 'چه', 'های', 'ها', 'برای', 'با', 'و', 'یا', 'از', 'به', 'را', 'رو', 'یک', 'میخوام', 'می‌خوام', 'میخواهم', 'پلن', 'پکیج', 'سرویس',
        'price', 'pricing', 'cost', 'how', 'much', 'do', 'you', 'have', 'the', 'a', 'an', 'for', 'with', 'and', 'or', 'of', 'to', 'plan', 'plans', 'package', 'packages', 'buy', 'what', 'is', 'are', 'your',
        'fiyat', 'ne', 'kadar', 'var', 'mı', 'mi', 'için', 've', 'bir', 'paket', 'plan', 'satın', 'almak',
    );

    /** @return string[] */
    public static function terms($query)
    {
        $query = function_exists('mb_strtolower') ? mb_strtolower((string) $query, 'UTF-8') : strtolower((string) $query);
        $parts = preg_split('/[\s,.;:!?؟،()«»"\'\/\\\\]+/u', $query, -1, PREG_SPLIT_NO_EMPTY);
        $terms = array();
        foreach ((array) $parts as $part) {
            $length = function_exists('mb_strlen') ? mb_strlen($part, 'UTF-8') : strlen($part);
            if ($length < 2 || $length > 40 || in_array($part, self::STOPWORDS, true)) {
                continue;
            }
            $terms[] = $part;
            if (count($terms) >= 4) {
                break;
            }
        }
        return $terms;
    }

    private static function visible()
    {
        $query = Capsule::table('tblproducts')
            ->join('tblproductgroups', 'tblproductgroups.id', '=', 'tblproducts.gid')
            ->where('tblproducts.hidden', 0)
            ->where('tblproductgroups.hidden', 0);
        if (Schema::has('tblproducts.retired')) {
            $query->where('tblproducts.retired', 0);
        }
        return $query;
    }

    private static function likeEscape($term)
    {
        return '%' . str_replace(array('\\', '%', '_'), array('\\\\', '\\%', '\\_'), $term) . '%';
    }

    /** @return array<string,mixed> */
    public static function search($query, $limit)
    {
        $limit = max(1, min(self::MAX_RESULTS, (int) $limit));
        $terms = self::terms($query);
        if (!$terms) {
            return self::browse($limit);
        }
        $rows = self::visible()
            ->where(function ($q) use ($terms) {
                foreach ($terms as $term) {
                    $like = self::likeEscape($term);
                    $q->orWhere('tblproducts.name', 'like', $like)->orWhere('tblproductgroups.name', 'like', $like);
                }
            })
            ->orderBy('tblproducts.id')
            ->limit(self::CANDIDATES)
            ->get(array('tblproducts.id', 'tblproducts.name', 'tblproducts.description', 'tblproducts.paytype', 'tblproducts.tax', 'tblproductgroups.name as grp'));

        $scored = array();
        foreach ($rows as $row) {
            $hay = function_exists('mb_strtolower')
                ? mb_strtolower($row->name . ' ' . $row->grp, 'UTF-8')
                : strtolower($row->name . ' ' . $row->grp);
            $score = 0;
            foreach ($terms as $term) {
                if (strpos($hay, $term) !== false) {
                    $score++;
                }
            }
            $scored[] = array($score, $row);
        }
        usort($scored, function ($a, $b) {
            return $b[0] - $a[0];
        });
        $picked = array();
        foreach (array_slice($scored, 0, $limit) as $pair) {
            $picked[] = $pair[1];
        }
        return self::withPrices($picked);
    }

    /** @return array<string,mixed> */
    public static function browse($limit)
    {
        $limit = max(1, min(self::MAX_BROWSE, (int) $limit));
        $query = self::visible();
        if (Schema::has('tblproductgroups.order')) {
            $query->orderBy('tblproductgroups.order');
        }
        if (Schema::has('tblproducts.order')) {
            $query->orderBy('tblproducts.order');
        }
        $rows = $query->orderBy('tblproducts.id')
            ->limit($limit + 1)
            ->get(array('tblproducts.id', 'tblproducts.name', 'tblproducts.description', 'tblproducts.paytype', 'tblproducts.tax', 'tblproductgroups.name as grp'));
        $list = array();
        foreach ($rows as $i => $row) {
            if ($i >= $limit) {
                break;
            }
            $list[] = $row;
        }
        $result = self::withPrices($list);
        $result['has_more'] = count($rows) > $limit;
        return $result;
    }

    /** @param object[] $rows */
    private static function withPrices(array $rows)
    {
        $currency = Currency::defaultCode();
        $ids = array();
        foreach ($rows as $row) {
            $ids[] = (int) $row->id;
        }
        $official = array();
        if ($ids) {
            $response = Platform::localApi('GetProducts', array('pid' => implode(',', $ids)));
            if (isset($response['result']) && $response['result'] === 'success' && isset($response['products']['product']) && is_array($response['products']['product'])) {
                foreach ($response['products']['product'] as $product) {
                    if (isset($product['pid'])) {
                        $official[(int) $product['pid']] = $product;
                    }
                }
            }
        }

        $items = array();
        foreach ($rows as $row) {
            $product = isset($official[(int) $row->id]) ? $official[(int) $row->id] : null;
            $url = $product && !empty($product['product-url']) ? (string) $product['product-url'] : Links::orderProduct($row->id);
            $items[] = array(
                'id' => Text::id($row->id),
                'name' => Text::clean($row->name, 120),
                'group' => Text::clean($row->grp, 120),
                'description' => Text::clean($row->description, 300),
                'pay_type' => (string) $row->paytype,
                'currency' => $currency,
                'prices' => $product ? self::prices($product, (string) $row->paytype, $currency) : array(),
                'taxable' => (int) $row->tax === 1,
                'order_url' => $url,
            );
        }
        return array('items' => $items, 'has_more' => false, 'as_of' => gmdate('c'), 'tax_mode' => self::taxMode());
    }

    /**
     * GetProducts pricing → [{cycle, price, setup_fee}]. `-1` means "cycle not
     * offered"; a one-time product's price sits in the `monthly` slot.
     */
    public static function prices(array $product, $payType, $currency)
    {
        if ($payType === 'free') {
            return array(array('cycle' => 'free', 'price' => '0.00', 'setup_fee' => null));
        }
        if ($currency === null || !isset($product['pricing'][$currency]) || !is_array($product['pricing'][$currency])) {
            return array();
        }
        $pricing = $product['pricing'][$currency];
        $cycles = $payType === 'onetime'
            ? array('onetime' => array('monthly', 'msetupfee'))
            : array(
                'monthly' => array('monthly', 'msetupfee'),
                'quarterly' => array('quarterly', 'qsetupfee'),
                'semiannually' => array('semiannually', 'ssetupfee'),
                'annually' => array('annually', 'asetupfee'),
                'biennially' => array('biennially', 'bsetupfee'),
                'triennially' => array('triennially', 'tsetupfee'),
            );
        $out = array();
        foreach ($cycles as $cycle => $keys) {
            $price = isset($pricing[$keys[0]]) ? Text::amount($pricing[$keys[0]]) : null;
            if ($price === null || (float) $price < 0) {
                continue;
            }
            $setup = isset($pricing[$keys[1]]) ? Text::amount($pricing[$keys[1]]) : null;
            $out[] = array('cycle' => $cycle, 'price' => $price, 'setup_fee' => $setup !== null && (float) $setup > 0 ? $setup : null);
        }
        return $out;
    }

    /** inclusive / exclusive when tax is enabled, null otherwise (setting names as stored by WHMCS). */
    private static function taxMode()
    {
        $enabled = Platform::setting('TaxEnabled');
        if ($enabled === null || !in_array(strtolower($enabled), array('on', '1', 'yes', 'true'), true)) {
            return null;
        }
        $type = strtolower((string) Platform::setting('TaxType'));
        return $type === 'inclusive' || $type === 'exclusive' ? $type : null;
    }
}
