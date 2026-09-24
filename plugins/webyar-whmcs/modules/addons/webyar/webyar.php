<?php
/**
 * Web Yar for WHMCS — addon module entry point.
 *
 * Lets the Web Yar AI assistant (already embedded as the Web Yar widget)
 * recognise a logged-in WHMCS customer and answer about THEIR OWN services,
 * domains, invoices, orders and tickets, plus public plans — by asking this
 * WHMCS install live, one bounded question at a time. No customer data is
 * copied to Web Yar; no cron, no sync, no polling.
 *
 * Requirements: WHMCS 8.0+ (Users & Client Accounts, CurrentUser), PHP 7.2+.
 */

if (!defined('WHMCS')) {
    die('This file cannot be accessed directly');
}

require_once __DIR__ . '/lib/bootstrap.php';

use WebYar\Whmcs\Admin\Page;
use WebYar\Whmcs\Schema;
use WebYar\Whmcs\Settings;
use WebYar\Whmcs\Version;

function webyar_config()
{
    return array(
        'name' => 'Web Yar',
        'description' => 'Connects the Web Yar AI assistant to this WHMCS so it can answer customers about their own services, domains, invoices, orders and tickets. Read-only; nothing is copied out of WHMCS.',
        'author' => 'Web Yar',
        'language' => 'english',
        'version' => Version::ADDON,
        'fields' => array(),
    );
}

function webyar_activate()
{
    if (version_compare(PHP_VERSION, Version::MIN_PHP, '<')) {
        return array('status' => 'error', 'description' => 'Web Yar requires PHP ' . Version::MIN_PHP . ' or newer.');
    }
    if (!class_exists('\WHMCS\Authentication\CurrentUser')) {
        return array('status' => 'error', 'description' => 'Web Yar requires WHMCS ' . Version::MIN_WHMCS . ' or newer.');
    }
    try {
        Schema::install();
        Schema::resetCache();
        Schema::supportedCapabilities(false);
    } catch (\Exception $e) {
        return array('status' => 'error', 'description' => 'Web Yar could not create its tables.');
    }
    return array('status' => 'success', 'description' => 'Web Yar activated. Open Addons → Web Yar to connect it to your workspace.');
}

/**
 * Removes ONLY what this addon created (its three mod_webyar_* tables). No
 * WHMCS client, service, domain, invoice, order or ticket is touched. Web Yar
 * is told (best effort) that the connection is gone.
 */
function webyar_deactivate()
{
    try {
        if (Settings::credential() !== null) {
            \WebYar\Whmcs\Pairing::disconnect();
        }
    } catch (\Exception $e) {
        // Local cleanup never depends on the network.
    }
    try {
        Schema::uninstall();
    } catch (\Exception $e) {
        return array('status' => 'error', 'description' => 'Web Yar could not remove its tables.');
    }
    return array('status' => 'success', 'description' => 'Web Yar deactivated. Its own tables were removed; your WHMCS data was not touched.');
}

function webyar_upgrade($vars)
{
    Schema::install();
    Schema::resetCache();
    Schema::supportedCapabilities(false);
}

function webyar_output($vars)
{
    Page::render(is_array($vars) ? $vars : array());
}
