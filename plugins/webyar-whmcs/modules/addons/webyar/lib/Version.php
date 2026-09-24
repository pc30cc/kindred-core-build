<?php

namespace WebYar\Whmcs;

/**
 * Versions the two ends of the protocol agree on. The protocol string and the
 * signing scheme are shared with the WooCommerce connector
 * (server/services/commerce/signing.ts on the Web Yar side).
 */
final class Version
{
    const ADDON = '1.0.0';
    const PROTOCOL = 'webyar-commerce/1';
    /** Logical path covered by every request signature (not the URL path). */
    const API_CANONICAL_PATH = '/webyar/whmcs/v1';
    /** Minimum WHMCS: 8.0 introduced Users/Client Accounts and CurrentUser. */
    const MIN_WHMCS = '8.0.0';
    const MIN_PHP = '7.2.0';
}
