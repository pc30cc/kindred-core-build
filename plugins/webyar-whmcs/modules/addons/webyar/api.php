<?php
/**
 * Machine endpoint for Web Yar. POST, JSON, HMAC-signed with this
 * installation's secret — see lib/Api/Endpoint.php and lib/Api/Router.php.
 * Bootstraps WHMCS the documented way for a module callback file.
 */

require_once __DIR__ . '/../../../init.php';
require_once __DIR__ . '/lib/bootstrap.php';

\WebYar\Whmcs\Api\Endpoint::handle();
