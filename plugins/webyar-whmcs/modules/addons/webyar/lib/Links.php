<?php

namespace WebYar\Whmcs;

/**
 * Client-area links handed to the assistant. All relative to the WHMCS System
 * URL, all pages that require the customer's own login: a link never grants
 * access by itself. The per-ticket access key (`c`) is deliberately NOT used —
 * ticket links go to the ticket list.
 */
final class Links
{
    private static function base()
    {
        return Platform::systemUrl();
    }

    public static function service($id)
    {
        return self::base() . '/clientarea.php?action=productdetails&id=' . (int) $id;
    }

    public static function domain($id)
    {
        return self::base() . '/clientarea.php?action=domaindetails&id=' . (int) $id;
    }

    public static function invoice($id)
    {
        return self::base() . '/viewinvoice.php?id=' . (int) $id;
    }

    public static function tickets()
    {
        return self::base() . '/supporttickets.php';
    }

    public static function orderProduct($productId)
    {
        return self::base() . '/cart.php?a=add&pid=' . (int) $productId;
    }

    public static function clientArea()
    {
        return self::base() . '/clientarea.php';
    }
}
