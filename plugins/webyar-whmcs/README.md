# Web Yar for WHMCS (addon module)

Read-only, live, permission-aware bridge between the Web Yar widget/AI and a
WHMCS 8+ installation. Architecture, data policy, limits and troubleshooting:
[`docs/commerce/WHMCS.md`](../../docs/commerce/WHMCS.md).

```
modules/addons/webyar/
  webyar.php     addon entry (config / activate / deactivate / upgrade / admin output)
  hooks.php      ClientAreaFooterOutput (widget), UserLogin/UserLogout, password/account-closure revocation
  api.php        the one machine endpoint Web Yar calls (signed JSON, closed op list)
  lib/           Grants, Signer, ReplayGuard, Permissions, Readers/*, Admin/Page, …
  lang/          english, farsi (+ persian alias), turkish
```

Package: `npm run build:whmcs-addon-zip` → `public/downloads/webyar-whmcs.zip`
(also part of `npm run build`).

## Tests

The suite runs the real readers through Illuminate's query builder (what
WHMCS's `Capsule` is) against an in-memory SQLite database shaped like the
WHMCS tables. It is not a WHMCS installation; see the docs for what that does
and does not prove.

```
cd plugins/webyar-whmcs
composer install          # dev tools only; the addon itself has no dependencies
vendor/bin/phpunit
vendor/bin/phpcs --standard=PHPCompatibility --runtime-set testVersion 7.2-8.4 --extensions=php modules/
```
