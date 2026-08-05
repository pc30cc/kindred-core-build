"""End-to-end proof that the admin live preview mounts the REAL widget:
config -> loader -> hashed runtime CSS/JS -> <gs-widget> -> visible panel -> RTL."""
import asyncio, functools, http.server, json, socketserver, threading
from pathlib import Path
from playwright.async_api import async_playwright

DIST = Path("/dev-server/dist")
SHOTS = Path("/tmp/browser/preview/screenshots"); SHOTS.mkdir(parents=True, exist_ok=True)
MANIFEST = json.loads((DIST / "widget" / "widget-manifest.json").read_text())
PORT = 8099

handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(DIST))
class TS(socketserver.TCPServer): allow_reuse_address = True
srv = TS(("127.0.0.1", PORT), handler)
threading.Thread(target=srv.serve_forever, daemon=True).start()
BASE = f"http://127.0.0.1:{PORT}"

# Exactly the document WidgetLivePreview renders, with the authenticated
# config response injected by the parent (fa / RTL).
CFG = {
    "brandName": "پشتیبانی",
    "primaryColor": "#6D5DFB",
    "locale": "fa",
    "widgetLanguage": "fa",
    "position": "bottom-right",
    "runtimeUrl": f"{BASE}/widget/{MANIFEST['runtime.js']}",
    "styleUrl": f"{BASE}/widget/{MANIFEST['runtime.css']}",
    "loaderVersion": MANIFEST["loaderVersion"],
    "assetBase": BASE,
    "modules": {
        "chat": f"{BASE}/widget/{MANIFEST['runtime-chat.js']}",
        "kb": f"{BASE}/widget/{MANIFEST['runtime-kb.js']}",
        "call": f"{BASE}/widget/{MANIFEST['runtime-call.js']}",
    },
    "features": {"chat": True, "knowledgeBase": True, "visitorTracking": False},
    "previewMode": True,
    "previewView": "chat",
    "previewSeed": {"messages": [
        {"id": "p1", "sender_type": "agent", "content": "سلام! چطور می‌توانیم کمکتان کنیم؟", "created_at": "2026-08-05T10:00:00Z"},
        {"id": "p2", "sender_type": "contact", "content": "سلام، دربارهٔ تعرفه‌ها سؤال داشتم.", "created_at": "2026-08-05T10:01:00Z"},
    ]},
    "_apiBase": BASE, "_assetBase": BASE, "_sessionToken": "preview",
}

HTML = """<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;height:100%%;background:#F1F5F9}</style></head>
<body><script>
window.__gs_preview_config = %s;
var s=document.createElement('script');
s.src='%s/widget/loader.js?v=%s';s.async=true;document.body.appendChild(s);
</script></body></html>""" % (json.dumps(CFG, ensure_ascii=False), BASE, MANIFEST["loaderVersion"])

async def main():
    async with async_playwright() as pw:
        b = await pw.chromium.launch(headless=True)
        ctx = await b.new_context(viewport={"width": 1280, "height": 1800})
        page = await ctx.new_page()
        net, errs = [], []
        page.on("response", lambda r: net.append((r.status, r.url)))
        page.on("console", lambda m: errs.append(m.text) if m.type == "error" else None)
        page.on("pageerror", lambda e: errs.append(str(e)))

        await page.set_content(HTML)
        await page.wait_for_function("!!document.querySelector('gs-widget')", timeout=15000)
        print("1. <gs-widget> mounted:", await page.eval_on_selector("gs-widget", "e=>e.tagName"))

        await page.wait_for_function(
            "(() => { const r = document.querySelector('gs-widget')?.shadowRoot;"
            "return !!r && !!r.querySelector('.panel'); })()", timeout=15000)

        # In preview mode the loader auto-invokes the launcher click path at
        # boot, so the panel opens on its own — exactly like a visitor who
        # tapped the launcher. No synthetic click needed.
        await page.wait_for_function(
            "!!document.querySelector('gs-widget').shadowRoot.querySelector('.panel.visible')", timeout=15000)
        await page.wait_for_timeout(800)

        dbg = await page.evaluate('''() => {
          const r = document.querySelector('gs-widget').shadowRoot;
          return {
            launcher: r.querySelector('.launcher')?.className || null,
            panel: r.querySelector('.panel')?.className || null,
            panels: r.querySelectorAll('.panel').length,
            runtime: !!window.__gs_runtime,
            instance: !!(window.__gs_runtime && window.__gs_runtime._instance),
            previewCfg: !!window.__gs_preview_config,
          };
        }''')
        print("debug:", dbg)

        state = await page.evaluate("""() => {
          const r = document.querySelector('gs-widget').shadowRoot;
          const p = r.querySelector('.panel');
          const cs = getComputedStyle(p);
          const rtl = r.querySelector('[dir="rtl"]');
          return {
            panelVisible: p.classList.contains('visible') && cs.opacity !== '0' && cs.visibility !== 'hidden',
            panelOpacity: cs.opacity,
            panelRadius: cs.borderRadius,
            rtlDir: rtl ? getComputedStyle(rtl).direction : null,
            rtlText: rtl ? rtl.innerText.slice(0, 40) : null,
            cssApplied: cs.position === 'fixed' || cs.position === 'absolute',
          };
        }""")
        assets = [(s, u.split('/')[-1]) for s, u in net if '/widget/' in u]
        print("2. widget network:", assets)
        print("3. panel state:", json.dumps(state, ensure_ascii=False))
        print("4. console errors:", errs[:5])
        await page.screenshot(path=str(SHOTS / "preview-fa-rtl.png"))

        ok = (state["panelVisible"] and state["cssApplied"] and state["rtlDir"] == "rtl"
              and all(s == 200 for s, _ in assets)
              and any(u.startswith("runtime.") and u.endswith(".js") for _, u in assets)
              and any(u.startswith("runtime.") and u.endswith(".css") for _, u in assets))
        print("RESULT:", "PASS" if ok else "FAIL")
        await b.close()

asyncio.run(main())
