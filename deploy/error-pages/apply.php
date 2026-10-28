<?php

// Puts this folder's pages into Coolify (4.5 or later), as its own settings
// would: Server → Proxy → "Custom error page" and, on every application and
// service, Maintenance → "Maintenance page". Run inside the coolify container
// with the two HTML files next to this script:
//
//   docker exec -u root coolify rm -rf /tmp/error-pages
//   docker cp /root/error-pages/. coolify:/tmp/error-pages
//   docker exec coolify php artisan tinker --execute="require '/tmp/error-pages/apply.php';"
//   docker exec -u root coolify rm -rf /tmp/error-pages

use App\Models\Application;
use App\Models\Server;
use App\Models\Service;

$error = file_get_contents(__DIR__.'/error-page.html');
$maintenance = file_get_contents(__DIR__.'/maintenance-page.html');
if ($error === false || $maintenance === false || strlen($error) > Server::PROXY_ERROR_PAGE_MAX_BYTES || strlen($maintenance) > Server::PROXY_ERROR_PAGE_MAX_BYTES) {
    throw new RuntimeException('error-page.html and maintenance-page.html must exist and fit the page size limit');
}

// Coolify writes it to /data/coolify/proxy/error-pages/503.html, which the
// catch-all router shows with status 503, as the Save button does.
foreach (Server::all() as $server) {
    if (! $server->usesProxyErrorPage()) {
        echo "skipped server {$server->name}: no proxy error page\n";
        continue;
    }
    $server->proxy_error_page = $error;
    $server->save();
    $server->setupDefaultRedirect();
    echo "error page: server {$server->name}\n";
}

// Shown only while a resource is in maintenance mode. The column alone, no
// model events: it is not part of an application's deployment configuration.
$applications = Application::query()->update(['maintenance_page' => $maintenance]);
$services = Service::query()->update(['maintenance_page' => $maintenance]);
echo "maintenance page: {$applications} applications, {$services} services\n";

// A resource already in maintenance gets the new page now.
foreach ([Application::class, Service::class] as $model) {
    foreach ($model::where('is_maintenance_enabled', true)->get() as $resource) {
        $resource->syncMaintenancePage();
        echo "maintenance page rewritten: {$resource->name}\n";
    }
}
