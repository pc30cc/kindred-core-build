# Error pages: the proxy's 503 page and the maintenance page

Coolify (4.5 and later) shows two pages of its own on the production server
(`host.respok.app`), both with status 503:

- the **error page**, for every request no running app answers: an unknown
  host (the bare IP included), or an app that is stopped, deploying,
  restarting or failing its health check. While the backend is stopped,
  `api.webyar.ai` answers with it.
- the **maintenance page**, for an app or service while its Maintenance mode
  is on.

Coolify's own versions named Coolify and linked to its documentation. Since
2026-10-28 (owner) both are ours, from this folder: English, brand-neutral
(the same server answers for WebYar, RESPOK and limer.tr), with the visitor's
host name filled in by the page itself.

| Page | File | Where Coolify keeps it |
| --- | --- | --- |
| Error page | `error-page.html` | Server `localhost` → Proxy → "Custom error page (HTML)" (`servers.proxy_error_page`) |
| Maintenance page | `maintenance-page.html` | Each application's and service's Maintenance → "Maintenance page" (`maintenance_page`) |

Coolify writes the error page to `/data/coolify/proxy/error-pages/503.html`,
which the container `coolify-proxy-error-pages` (busybox httpd) serves and
the catch-all router in `/data/coolify/proxy/dynamic/default_redirect_503.yaml`
shows; maintenance pages go next to it as `maintenance-<uuid>.html` while a
resource is in maintenance. Coolify rewrites those files from its database
whenever the proxy starts or its settings are saved, so never edit them
there: change the HTML here and apply it.

## What the pages do

- One self-contained file each (inline CSS, SVG and script; no fonts, images
  or requests to anywhere else), light and dark, from phone width up.
- The page reads the host name from the address bar, shows where the request
  stopped (browser and gateway working, the service unavailable or in
  maintenance) and checks the same address in the background, after 15, 30,
  60 and then every 120 seconds (the maintenance page 30, 60, 120), only while
  the tab is visible. As soon as the address answers below 500 it reloads.
  "Try again" runs that check at once. Without JavaScript the button reloads.
- The status stays 503 (the proxy sets it, the page only fills the body), so
  webhooks and the plugins keep retrying while the backend is down.

## Apply (or re-apply after a change)

On the host, with this folder copied to `/root/error-pages`:

    docker cp /root/error-pages coolify:/tmp/error-pages
    docker exec coolify php artisan tinker --execute="require '/tmp/error-pages/apply.php';"
    docker exec -u root coolify rm -rf /tmp/error-pages

`apply.php` does what the Save buttons do: it stores the error page on the
server and has Coolify write `503.html`, and stores the maintenance page on
every application and service (the column only; it is not part of an app's
deployment configuration, so no app shows a pending redeploy). Check:

    curl -s -o /dev/null -w '%{http_code} %{size_download}\n' -H 'Host: nothing.example' http://127.0.0.1/
    sha256sum /data/coolify/proxy/error-pages/503.html error-page.html

A new application or service starts with Coolify's maintenance page: run
`apply.php` again after adding one (or paste the file into its Maintenance
page field).

To go back to Coolify's pages, press "Reset to default" in both places, or set
`proxy_error_page` and `maintenance_page` to null and call
`setupDefaultRedirect()` on the server. The state before the first apply
(Coolify's `503.html`, the catch-all file, all fields null) is in
`/root/error-pages-20261028/before/` on the host.

## Not covered

Traefik's own plain-text `Bad Gateway` (502) and `Gateway Timeout` (504)
appear when an app's container runs but does not answer in time. They come
from that app's own router; an errors middleware there would also replace the
app's own 5xx responses (the backend's JSON `{ error }` bodies, for
example), so they are left as they are.
