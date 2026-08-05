"""Acceptance test: a customization change made BEFORE the iframe bridge is
ready must not be lost. The parent buffers the latest patch and flushes it once
GS_PREVIEW_READY arrives — without reloading the iframe."""
import asyncio, functools, http.server, json, socketserver, threading, sys
from pathlib import Path
from playwright.async_api import async_playwright

DIST = Path("/dev-server/dist"); PORT = 8094
SHOTS = Path("/tmp/browser/preview-ready"); SHOTS.mkdir(parents=True, exist_ok=True)
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
    "previewSeed": {"messages": []},
    "loaderUrl": f"{B}/widget/loader.js?v={M['loaderVersion']}",
    "_apiBase": B, "_assetBase": B, "_sessionToken": "preview",
}

INNER = """<!doctype html><html><head><meta charset=utf-8><style>html,body{margin:0;height:100%%;background:#eef}</style></head><body><script>
var c=%s; c.previewParentOrigin=window.parent.location.origin; window.__gs_preview_config=c;
var s=document.createElement('script');s.src=c.loaderUrl;s.async=1;document.body.appendChild(s);
</script></body></html>""" % json.dumps(CFG)

# Parent emulates WidgetLivePreview's handshake: buffer latest patch, flush on READY.
PARENT = """<!doctype html><html><body style="margin:0">
<iframe id="pv" style="width:420px;height:760px;border:0" sandbox="allow-scripts allow-same-origin" srcdoc='%s'></iframe>
<script>
window.__ready = false; window.__readyCount = 0; window.__latest = null; window.__sent = 0;
function flush(){
  if(!window.__ready || !window.__latest) return;
  document.getElementById('pv').contentWindow.postMessage(
    {type:'GS_PREVIEW_CONFIG_PATCH', patch: window.__latest}, window.location.origin);
  window.__sent++;
}
window.setPatch = function(p){ window.__latest = Object.assign({}, window.__latest||{}, p); flush(); };
window.addEventListener('message', function(ev){
  var win = document.getElementById('pv').contentWindow;
  if (ev.source !== win) return;
  if (ev.origin !== window.location.origin && ev.origin !== 'null') return;
  if (!ev.data || ev.data.type !== 'GS_PREVIEW_READY') return;
  window.__ready = true; window.__readyCount++; flush();
});
</script>
</body></html>""" % INNER.replace("'", "&apos;")

failures = []
def check(name, cond, detail=""):
    print(("ok   " if cond else "FAIL ") + name + ((" :: " + detail) if detail else ""))
    if not cond: failures.append(name + " :: " + detail)

STATE = """() => {
  const f = document.getElementById('pv');
  const w = f.contentWindow, d = f.contentDocument;
  const r = d.querySelector('gs-widget')?.shadowRoot;
  const sh = r && r.querySelector('.shell');
  const l = r && r.querySelector('.launcher');
  return {
    loaderExecs: w.__gs_loader_execs, inits: w.__gs_runtime_inits,
    widgets: d.querySelectorAll('gs-widget').length,
    primary: sh ? getComputedStyle(sh).getPropertyValue('--gs-primary').trim() : null,
    secondary: sh ? getComputedStyle(sh).getPropertyValue('--gs-secondary').trim() : null,
    launcherW: l ? l.style.width : null,
    ready: w.parent.__ready, readyCount: w.parent.__readyCount, sent: w.parent.__sent,
  };
}"""

async def main():
    async with async_playwright() as pw:
        b = await pw.chromium.launch(headless=True)
        c = await b.new_context(viewport={"width": 900, "height": 820})
        pg = await c.new_page()
        await pg.goto(f"{B}/", wait_until="domcontentloaded")
        # Throttle the runtime script so the bridge is definitely not ready yet.
        await pg.route("**/runtime.*.js", lambda route: asyncio.ensure_future(
            asyncio.sleep(1.2)).add_done_callback(lambda _: asyncio.ensure_future(route.continue_())))
        await pg.set_content(PARENT)
        # Fire customization edits IMMEDIATELY, before READY can have arrived.
        pre_ready = await pg.evaluate("""() => {
          window.setPatch({ primaryColor: '#111111' });
          window.setPatch({ primaryColor: '#EF4444', secondaryColor: '#F59E0B' });
          window.setPatch({ fab: { scale: 140 } });
          return { ready: window.__ready, sent: window.__sent };
        }""")
        print("pre-ready:", json.dumps(pre_ready))
        check("bridge not ready when edits were made", pre_ready["ready"] is False)
        check("no patch sent before READY", pre_ready["sent"] == 0, str(pre_ready["sent"]))
        await pg.evaluate("""() => {
          const f = document.getElementById('pv');
          window.__win0 = f.contentWindow; window.__doc0 = f.contentDocument;
        }""")
        await pg.wait_for_function("() => window.__ready === true", timeout=25000)
        await pg.wait_for_timeout(700)
        st = await pg.evaluate(STATE)
        ident = await pg.evaluate("""() => {
          const f = document.getElementById('pv');
          return { sameWin: f.contentWindow === window.__win0, sameDoc: f.contentDocument === window.__doc0 };
        }""")
        print("after ready:", json.dumps(st)); print("identity:", json.dumps(ident))
        await pg.screenshot(path=str(SHOTS / "after_ready.png"))
        check("READY received exactly once", st["readyCount"] == 1, str(st["readyCount"]))
        check("exactly one flush after READY", st["sent"] == 1, str(st["sent"]))
        check("latest primary applied", st["primary"] == "#EF4444", str(st["primary"]))
        check("latest secondary applied", st["secondary"] == "#F59E0B", str(st["secondary"]))
        check("latest fab scale applied", st["launcherW"] == "81px", str(st["launcherW"]))
        check("same iframe window (no reload)", ident["sameWin"])
        check("same iframe document (no reload)", ident["sameDoc"])
        check("loader execs == 1", st["loaderExecs"] == 1, str(st["loaderExecs"]))
        check("runtime inits == 1", st["inits"] == 1, str(st["inits"]))
        check("single widget", st["widgets"] == 1, str(st["widgets"]))

        # Post-READY edits still flow through the existing bridge.
        await pg.evaluate("() => window.setPatch({ primaryColor: '#0EA5E9' })")
        await pg.wait_for_timeout(400)
        st2 = await pg.evaluate(STATE)
        check("post-ready patch applied live", st2["primary"] == "#0EA5E9", str(st2["primary"]))
        check("still one loader exec / init", st2["loaderExecs"] == 1 and st2["inits"] == 1, json.dumps(st2))
        await b.close()
    if failures:
        print("\nRESULT: FAIL (%d)" % len(failures)); [print(" -", f) for f in failures]; sys.exit(1)
    print("\nRESULT: PASS")

asyncio.run(main())
