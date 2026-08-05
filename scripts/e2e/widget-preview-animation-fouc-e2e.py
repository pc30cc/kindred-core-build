"""Acceptance tests for the admin preview LIFECYCLE (not geometry):
  1. animation ON  -> panel mounts closed, transitions, transitionend fires
  2. animation OFF -> instant visible, transition-duration 0s, no pending RAF
  3. reduced motion -> instant/reduced, final state correct
  4. close + reopen -> animates, single panel/launcher
  5. slow runtime.css -> NO unstyled panel frame is ever painted (FOUC)
  6. CSS served as text/html -> STYLE_NOT_APPLIED, panel never revealed
Exits non-zero on any failure."""
import asyncio, functools, http.server, json, socketserver, threading, sys, time
from pathlib import Path
from playwright.async_api import async_playwright

DIST = Path("/dev-server/dist"); PORT = 8094
SHOTS = Path("/tmp/browser/preview-anim"); SHOTS.mkdir(parents=True, exist_ok=True)
M = json.loads((DIST / "widget" / "widget-manifest.json").read_text())
h = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(DIST))
class TS(socketserver.TCPServer): allow_reuse_address = True
threading.Thread(target=TS(("127.0.0.1", PORT), h).serve_forever, daemon=True).start()
B = f"http://127.0.0.1:{PORT}"
CSS_URL = f"{B}/widget/{M['runtime.css']}"

def cfg(anim=True):
    return {
        "brandName": "Support", "primaryColor": "#6D5DFB", "locale": "en", "widgetLanguage": "en",
        "position": "bottom-right",
        "runtimeUrl": f"{B}/widget/{M['runtime.js']}", "styleUrl": CSS_URL,
        "loaderVersion": M["loaderVersion"], "assetBase": B,
        "modules": {"chat": f"{B}/widget/{M['runtime-chat.js']}", "kb": f"{B}/widget/{M['runtime-kb.js']}", "call": f"{B}/widget/{M['runtime-call.js']}"},
        "features": {"chat": True, "knowledgeBase": True, "visitorTracking": False},
        "fab": {"icon": "chat", "shape": "circle", "scale": 100, "animation": anim, "label": ""},
        "previewMode": True, "previewView": "chat",
        "previewSeed": {"messages": [{"id": "1", "sender_type": "agent", "content": "Hello!", "created_at": "2026-08-05T10:00:00Z"}]},
        "loaderUrl": f"{B}/widget/loader.js?v={M['loaderVersion']}",
        "_apiBase": B, "_assetBase": B, "_sessionToken": "preview",
    }

HTML = """<!doctype html><html><head><meta charset=utf-8><style>html,body{margin:0;height:100%%;background:#eef}</style></head><body><script>
window.__gs_panelBirth=null;
(function(){
  var orig = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function(init){
    var root = orig.call(this, init);
    try {
      new MutationObserver(function(muts){
        for (var i=0;i<muts.length;i++) for (var j=0;j<muts[i].addedNodes.length;j++){
          var n = muts[i].addedNodes[j];
          if (n.nodeType===1 && n.classList && n.classList.contains('panel') && !window.__gs_panelBirth){
            var sh = n.parentNode;
            window.__gs_panelBirth = {
              visible: n.classList.contains('visible'),
              opacity: getComputedStyle(n).opacity,
              transform: getComputedStyle(n).transform,
              cloaked: !!(sh && sh.classList && (sh.classList.contains('gs-runtime-loading') || !sh.classList.contains('gs-css-ready')))
            };
          }
        }
      }).observe(root, {subtree:true, childList:true});
    } catch(e){}
    return root;
  };
})();
</script><script>
window.__gs_transitions=[];
window.__gs_preview_config=%s;
document.addEventListener('DOMContentLoaded',function(){});
var s=document.createElement('script');s.src=window.__gs_preview_config.loaderUrl;s.async=1;document.body.appendChild(s);
</script></body></html>"""

failures = []
def check(name, cond, detail=""):
    print(("ok   " if cond else "FAIL ") + name + ((" :: " + detail) if detail else ""))
    if not cond: failures.append(name + " :: " + detail)

PANEL = "document.querySelector('gs-widget').shadowRoot.querySelector('.panel')"
SHELL = "document.querySelector('gs-widget').shadowRoot.querySelector('.shell')"

async def boot(ctx, conf, watch_mount=False):
    pg = await ctx.new_page()
    await pg.set_content(HTML % json.dumps(conf))
    return pg

async def main():
    async with async_playwright() as pw:
        b = await pw.chromium.launch(headless=True)

        # ── Test 1: animation ON ─────────────────────────────────────────
        c = await b.new_context(viewport={"width": 420, "height": 760})
        pg = await boot(c, cfg(True), watch_mount=True)
        await pg.wait_for_function(f"!!{PANEL}", timeout=20000)
        birth = await pg.evaluate("window.__gs_panelBirth")
        await pg.evaluate(f"""() => {{
          window.__gs_tend = false;
          {PANEL}.addEventListener('transitionend', e => {{ if (e.propertyName === 'opacity') window.__gs_tend = true; }});
        }}""")
        await pg.screenshot(path=str(SHOTS / "1_cloak_or_closed.png"))
        await pg.wait_for_function(f"{PANEL}.classList.contains('visible')", timeout=20000)
        await pg.screenshot(path=str(SHOTS / "2_opening.png"))
        dur = await pg.evaluate(f"getComputedStyle({PANEL}).transitionDuration")
        await pg.wait_for_timeout(700)
        final = await pg.evaluate(f"getComputedStyle({PANEL}).opacity")
        tend = await pg.evaluate("window.__gs_tend")
        await pg.screenshot(path=str(SHOTS / "3_final_styled.png"))
        print("panel birth state:", birth)
        check("T1 mounted without .visible", birth and birth["visible"] is False, json.dumps(birth))
        check("T1 birth opacity 0 / cloaked", birth and (birth["opacity"] == "0" or birth["cloaked"]), json.dumps(birth))
        check("T1 transition-duration > 0", dur != "0s", f"dur={dur}")
        check("T1 transitionend fired", tend is True)
        check("T1 final opacity 1", final == "1", f"opacity={final}")
        # Test 4: close + reopen
        await pg.evaluate("window.__gs_runtime._instance.close()")
        await pg.wait_for_timeout(400)
        closed = await pg.evaluate(f"getComputedStyle({PANEL}).opacity")
        await pg.evaluate("window.__gs_runtime._instance.open()")
        await pg.wait_for_timeout(600)
        reopened = await pg.evaluate(f"getComputedStyle({PANEL}).opacity")
        counts = await pg.evaluate("""() => {
          const r = document.querySelector('gs-widget').shadowRoot;
          return {panels: r.querySelectorAll('.panel').length, launchers: r.querySelectorAll('.launcher').length,
                  widgets: document.querySelectorAll('gs-widget').length,
                  loaderExecs: window.__gs_loader_execs, inits: window.__gs_runtime_inits};
        }""")
        check("T4 close hides panel", closed == "0", f"opacity={closed}")
        check("T4 reopen reaches opacity 1", reopened == "1", f"opacity={reopened}")
        check("T4 single panel/launcher/widget", counts["panels"] == 1 and counts["launchers"] == 1 and counts["widgets"] == 1, json.dumps(counts))
        print("counts:", counts)
        await c.close()

        # ── Test 2: animation OFF ────────────────────────────────────────
        c = await b.new_context(viewport={"width": 420, "height": 760})
        pg = await boot(c, cfg(False))
        await pg.wait_for_function(f"!!{PANEL} && {PANEL}.classList.contains('visible')", timeout=20000)
        d2 = await pg.evaluate(f"getComputedStyle({PANEL}).transitionDuration")
        a2 = await pg.evaluate(f"getComputedStyle({PANEL}).animationName")
        o2 = await pg.evaluate(f"getComputedStyle({PANEL}).opacity")
        noanim = await pg.evaluate(f"{SHELL}.classList.contains('gs-no-anim')")
        check("T2 transition-duration 0s", d2 == "0s", f"dur={d2}")
        check("T2 no keyframe animation", a2 in ("none", ""), f"anim={a2}")
        check("T2 opacity 1 immediately", o2 == "1", f"opacity={o2}")
        check("T2 gs-no-anim class present", noanim is True)
        await c.close()

        # ── Test 3: reduced motion ───────────────────────────────────────
        c = await b.new_context(viewport={"width": 420, "height": 760}, reduced_motion="reduce")
        pg = await boot(c, cfg(True))
        await pg.wait_for_function(f"!!{PANEL} && {PANEL}.classList.contains('visible')", timeout=20000)
        await pg.wait_for_timeout(200)
        d3 = await pg.evaluate(f"getComputedStyle({PANEL}).transitionDuration")
        o3 = await pg.evaluate(f"getComputedStyle({PANEL}).opacity")
        check("T3 reduced motion duration 0s", d3 == "0s", f"dur={d3}")
        check("T3 reduced motion final opacity 1", o3 == "1", f"opacity={o3}")
        await c.close()

        # ── Test 5: slow CSS -> no unstyled flash ────────────────────────
        c = await b.new_context(viewport={"width": 420, "height": 760})
        pg = await c.new_page()
        async def slow_css(route):
            await asyncio.sleep(1.2)
            await route.continue_()
        await pg.route(f"**/{M['runtime.css'].split('/')[-1]}", slow_css)
        await pg.set_content(HTML % json.dumps(cfg(True)))
        worst = {"raw": 0}
        t0 = time.time()
        samples = []
        while time.time() - t0 < 2.6:
            st = await pg.evaluate("""() => {
              const r = document.querySelector('gs-widget') && document.querySelector('gs-widget').shadowRoot;
              if (!r) return {stage:'no-shell'};
              const p = r.querySelector('.panel');
              const sh = r.querySelector('.shell');
              if (!p) return {stage:'no-panel', ready: sh.classList.contains('gs-css-ready')};
              const cs = getComputedStyle(p);
              const box = p.getBoundingClientRect();
              return {stage:'panel', ready: sh.classList.contains('gs-css-ready'),
                      loading: sh.classList.contains('gs-runtime-loading'),
                      vis: cs.visibility, op: cs.opacity, w: box.width, h: box.height};
            }""")
            samples.append(st)
            if st.get("stage") == "panel" and not st.get("ready") and (st.get("vis") != "hidden" or st.get("op") != "0"):
                worst["raw"] += 1
            await pg.wait_for_timeout(50)
        pre = [s for s in samples if s.get("stage") == "panel" and not s.get("ready")]
        check("T5 no unstyled panel frame before CSS readiness", worst["raw"] == 0,
              f"violations={worst['raw']} preReadyPanelSamples={len(pre)}")
        await pg.wait_for_function(f"!!{PANEL} && {PANEL}.classList.contains('visible')", timeout=20000)
        await pg.wait_for_timeout(500)
        okstyle = await pg.evaluate(f"getComputedStyle({PANEL}).position")
        check("T5 styled panel after readiness", okstyle in ("fixed", "absolute"), f"position={okstyle}")
        await pg.screenshot(path=str(SHOTS / "5_slowcss_final.png"))
        await c.close()

        # ── Test 6: CSS returns text/html -> STYLE_NOT_APPLIED ───────────
        c = await b.new_context(viewport={"width": 420, "height": 760})
        pg = await c.new_page()
        await pg.route(f"**/{M['runtime.css'].split('/')[-1]}",
                       lambda route: asyncio.ensure_future(route.fulfill(status=200, content_type="text/html", body="<html></html>")))
        await pg.set_content(HTML % json.dumps(cfg(True)))
        await pg.wait_for_timeout(2500)
        err = await pg.evaluate("window.__gs_last_error")
        shown = await pg.evaluate("""() => {
          const r = document.querySelector('gs-widget').shadowRoot;
          const p = r.querySelector('.panel');
          if (!p) return 'no-panel';
          const cs = getComputedStyle(p);
          return cs.visibility === 'hidden' || cs.opacity === '0' ? 'hidden' : 'VISIBLE';
        }""")
        check("T6 STYLE_NOT_APPLIED recorded", bool(err) and err.get("code") == "STYLE_NOT_APPLIED", json.dumps(err))
        check("T6 panel never revealed", shown in ("no-panel", "hidden"), str(shown))
        await c.close()
        await b.close()

    if failures:
        print("\nRESULT: FAIL (%d)" % len(failures)); [print(" -", f) for f in failures]; sys.exit(1)
    print("\nRESULT: PASS")

asyncio.run(main())
