"""Acceptance test: ordinary customization edits must NOT recreate the preview
iframe/document. The parent posts GS_PREVIEW_CONFIG_PATCH messages; the mounted
widget must update in place with loader executions == 1 and runtime inits == 1."""
import asyncio, functools, http.server, json, socketserver, threading, sys
from pathlib import Path
from playwright.async_api import async_playwright

DIST = Path("/dev-server/dist"); PORT = 8093
SHOTS = Path("/tmp/browser/preview-noreload"); SHOTS.mkdir(parents=True, exist_ok=True)
M = json.loads((DIST / "widget" / "widget-manifest.json").read_text())
h = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(DIST))
class TS(socketserver.TCPServer): allow_reuse_address = True
threading.Thread(target=TS(("127.0.0.1", PORT), h).serve_forever, daemon=True).start()
B = f"http://127.0.0.1:{PORT}"

CFG = {
    "brandName": "Support", "primaryColor": "#6D5DFB", "secondaryColor": "#8B5CF6",
    "locale": "en", "widgetLanguage": "en", "position": "bottom-right",
    "runtimeUrl": f"{B}/widget/{M['runtime.js']}", "styleUrl": f"{B}/widget/{M['runtime.css']}",
    "loaderVersion": M["loaderVersion"], "assetBase": B,
    "modules": {"chat": f"{B}/widget/{M['runtime-chat.js']}", "kb": f"{B}/widget/{M['runtime-kb.js']}", "call": f"{B}/widget/{M['runtime-call.js']}"},
    "features": {"chat": True, "knowledgeBase": True, "visitorTracking": False},
    "fab": {"icon": "chat", "shape": "circle", "scale": 100, "animation": True, "label": ""},
    "previewMode": True, "previewView": "chat",
    "previewSeed": {"messages": [{"id": "1", "sender_type": "agent", "content": "Hello!", "created_at": "2026-08-05T10:00:00Z"}]},
    "loaderUrl": f"{B}/widget/loader.js?v={M['loaderVersion']}",
    "_apiBase": B, "_assetBase": B, "_sessionToken": "preview",
}

INNER = """<!doctype html><html><head><meta charset=utf-8><style>html,body{margin:0;height:100%%;background:#eef}</style></head><body><script>
window.__gs_preview_config=%s;var s=document.createElement('script');s.src=window.__gs_preview_config.loaderUrl;s.async=1;document.body.appendChild(s);
</script></body></html>""" % json.dumps(CFG)

PARENT = """<!doctype html><html><body style="margin:0">
<iframe id="pv" style="width:420px;height:760px;border:0" sandbox="allow-scripts allow-same-origin" srcdoc='%s'></iframe>
</body></html>""" % INNER.replace("'", "&apos;")

PATCHES = [
    {"primaryColor": "#EF4444"},
    {"secondaryColor": "#F59E0B"},
    {"fab": {"scale": 140}},
    {"fab": {"animation": False}},
    {"fab": {"icon": "headset"}},
    {"previewView": "home"},
]

failures = []
def check(name, cond, detail=""):
    print(("ok   " if cond else "FAIL ") + name + ((" :: " + detail) if detail else ""))
    if not cond: failures.append(name + " :: " + detail)

STATE = """() => {
  const f = document.getElementById('pv');
  const w = f.contentWindow, d = f.contentDocument;
  const el = d.querySelector('gs-widget');
  const r = el && el.shadowRoot;
  const sh = r && r.querySelector('.shell');
  const p = r && r.querySelector('.panel');
  const l = r && r.querySelector('.launcher');
  if (!w.__gs_ids) { w.__gs_ids = {}; }
  return {
    loaderExecs: w.__gs_loader_execs, inits: w.__gs_runtime_inits,
    docReady: d.readyState,
    widgets: d.querySelectorAll('gs-widget').length,
    panels: r ? r.querySelectorAll('.panel').length : -1,
    primary: sh ? getComputedStyle(sh).getPropertyValue('--gs-primary').trim() : null,
    secondary: sh ? getComputedStyle(sh).getPropertyValue('--gs-secondary').trim() : null,
    zone: sh ? getComputedStyle(sh).getPropertyValue('--gs-preview-launcher-zone').trim() : null,
    noAnim: sh ? sh.classList.contains('gs-no-anim') : null,
    cssReady: sh ? sh.classList.contains('gs-css-ready') : null,
    launcherW: l ? l.style.width : null,
    launcherIcon: l ? (l.innerHTML.indexOf('M3 18v-6') !== -1 ? 'headset' : 'other') : null,
    panelVisible: p ? p.classList.contains('visible') : null,
    panelView: p ? p.getAttribute('data-view') : null,
  };
}"""

async def main():
    async with async_playwright() as pw:
        b = await pw.chromium.launch(headless=True)
        c = await b.new_context(viewport={"width": 900, "height": 820})
        pg = await c.new_page()
        await pg.goto(f"{B}/", wait_until="domcontentloaded")
        await pg.set_content(PARENT)
        await pg.wait_for_function(
            "(() => { const d = document.getElementById('pv').contentDocument;"
            "const el = d.querySelector('gs-widget');"
            "return !!(el && el.shadowRoot.querySelector('.panel.visible')); })()", timeout=25000)
        await pg.wait_for_timeout(600)
        # identity handles
        await pg.evaluate("""() => {
          const f = document.getElementById('pv');
          window.__win0 = f.contentWindow; window.__doc0 = f.contentDocument;
          window.__el0 = f.contentDocument.querySelector('gs-widget');
          window.__panel0 = window.__el0.shadowRoot.querySelector('.panel');
        }""")
        before = await pg.evaluate(STATE)
        print("before:", json.dumps(before))
        check("loader execs == 1 before", before["loaderExecs"] == 1, str(before["loaderExecs"]))
        check("runtime inits == 1 before", before["inits"] == 1, str(before["inits"]))
        await pg.screenshot(path=str(SHOTS / "before.png"))

        for p in PATCHES:
            await pg.evaluate("""(patch) => {
              document.getElementById('pv').contentWindow.postMessage(
                { type: 'GS_PREVIEW_CONFIG_PATCH', patch }, window.location.origin);
            }""", p)
            await pg.wait_for_timeout(350)

        after = await pg.evaluate(STATE)
        ident = await pg.evaluate("""() => {
          const f = document.getElementById('pv');
          return {
            sameWin: f.contentWindow === window.__win0,
            sameDoc: f.contentDocument === window.__doc0,
            sameEl: f.contentDocument.querySelector('gs-widget') === window.__el0,
            samePanel: window.__el0.shadowRoot.querySelector('.panel') === window.__panel0,
          };
        }""")
        print("after:", json.dumps(after))
        print("identity:", json.dumps(ident))
        await pg.screenshot(path=str(SHOTS / "after.png"))

        check("same iframe contentWindow", ident["sameWin"])
        check("same iframe document", ident["sameDoc"])
        check("same <gs-widget>", ident["sameEl"])
        check("same panel element (no remount)", ident["samePanel"])
        check("loader execs still 1", after["loaderExecs"] == 1, str(after["loaderExecs"]))
        check("runtime inits still 1", after["inits"] == 1, str(after["inits"]))
        check("single widget + single panel", after["widgets"] == 1 and after["panels"] == 1, json.dumps(after))
        check("primary color updated", after["primary"] == "#EF4444", str(after["primary"]))
        check("secondary color updated", after["secondary"] == "#F59E0B", str(after["secondary"]))
        check("fab scale applied", after["launcherW"] == "81px", str(after["launcherW"]))
        check("preview launcher zone recalculated", after["zone"] not in (None, "", before["zone"]),
              f"{before['zone']} -> {after['zone']}")
        check("animation toggle applied", after["noAnim"] is True)
        check("fab icon updated", after["launcherIcon"] == "headset", str(after["launcherIcon"]))
        check("preview view updated", after["panelView"] == "home", str(after["panelView"]))
        check("panel still visible / styled", after["panelVisible"] is True and after["cssReady"] is True, json.dumps(after))
        await b.close()
    if failures:
        print("\nRESULT: FAIL (%d)" % len(failures)); [print(" -", f) for f in failures]; sys.exit(1)
    print("\nRESULT: PASS")

asyncio.run(main())
