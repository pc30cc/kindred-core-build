# webyar-opencart

The OpenCart extension of Web Yar. It is a thin, read-only bridge. It adds the
chat widget to the storefront and answers Web Yar's signed questions about
products and a signed-in customer's own orders, live, from the store's
database. It has no LLM, no sync, no cron, no queue and no copy of any data
in Web Yar.

Full documentation: [`docs/commerce/OPENCART.md`](../../docs/commerce/OPENCART.md).
Measured cost: [`docs/commerce/OPENCART_RESOURCE_REPORT.md`](../../docs/commerce/OPENCART_RESOURCE_REPORT.md).

## Packages

| OpenCart | Package | Built from |
|---|---|---|
| 4.1.0.x (tested on 4.1.0.0 and 4.1.0.4) | `public/downloads/opencart/4.1/webyar.ocmod.zip` | `core/` + `oc4/` |
| 3.0.5.x (tested on 3.0.5.1) | `public/downloads/opencart/3.0/webyar-oc3.ocmod.zip` | `core/` + `oc3/` |

PHP 8.1 or later. Build with `npm run build:opencart-plugin-zip`. The build
is deterministic, and `public/downloads/opencart/manifest.json` carries each
package's sha256. The 4.1 archive must keep the name `webyar.ocmod.zip`
because OpenCart 4 derives the extension code and namespace from it.

## Layout

```
core/        version-agnostic PHP: protocol, signing, replay guard, crypto,
             identity (assertion, session_ref), context (language, currency,
             group, tax), catalogue and order reads, pairing, widget snippet
oc4/         OpenCart 4.1 wrappers: admin + catalog controllers, admin view,
             Oc4Platform (4.1.0.0 vs 4.1.0.3+ schema differences)
oc3/         OpenCart 3.0.5 wrappers: same surface, Oc3Platform
i18n/        en / fa / tr strings (the build generates both versions' language files)
tests/unit/run.php          PHP unit checks (no framework): php tests/unit/run.php
tests/fixtures/             signing vector shared with the TypeScript tests
tests/integration/run.sh    real OpenCart installs on loopback (up | test | down)
```

No OpenCart core file is modified. The widget is one event
(`catalog/view/common/footer/after`). Install and upgrade are idempotent.
Uninstall removes the event, the settings, the `webyar_nonce` table and the
local key.
