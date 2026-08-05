"""Acceptance test: in the ADMIN CUSTOMIZATION PREVIEW the launcher must be
geometrically BELOW the panel (>=12px gap) at every launcher scale, animation
state, alignment and customization-iframe size. Exits non-zero on any overlap."""
import asyncio, functools, http.server, json, socketserver, threading, sys
from pathlib import Path
from playwright.async_api import async_playwright

DIST = Path("/dev-server/dist"); PORT = 8096
SHOTS = Path("/tmp/browser/preview-geometry"); SHOTS.mkdir(parents=True, exist_ok=True)
M = json.loads((DIST / "widget" / "widget-manifest.json").read_text())
h = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(DIST))
class TS(socketserver.TCPServer): allow_reuse_address = True
threading.Thread(target=TS(("127.0.0.1", PORT), h).serve_forever, daemon=True).start()
B = f"http://127.0.0.1:{PORT}"

def cfg(pos, scale, anim, label=""):
    return {
        "brandName": "Support", "primaryColor": "#6D5DFB", "locale": "en", "widgetLanguage": "en",
        "position": pos,
        "runtimeUrl": f"{B}/widget/{M['runtime.js']}", "styleUrl": f"{B}/widget/{M['runtime.css']}",
        "loaderVersion": M["loaderVersion"], "assetBase": B,
        "modules": {"chat": f"{B}/widget/{M['runtime-chat.js']}", "kb": f"{B}/widget/{M['runtime-kb.js']}", "call": f"{B}/widget/{M['runtime-call.js']}"},
        "features": {"chat": True, "knowledgeBase": True, "visitorTracking": False},
        "fab": {"icon": "chat", "shape": "circle", "scale": scale, "animation": anim, "label": label},
        "previewMode": True, "previewView": "chat",
        "previewSeed": {"messages": [{"id": "1", "sender_type": "agent", "content": "Hello!", "created_at": "2026-08-05T10:00:00Z"}]},
        "loaderUrl": f"{B}/widget/loader.js?v={M['loaderVersion']}",
        "_apiBase": B, "_assetBase": B, "_sessionToken": "preview",
    }

HTML = """<!doctype html><html><head><meta charset=utf-8><style>html,body{margin:0;height:100%%;background:#eef}</style></head><body><script>
window.__gs_preview_config=%s;var s=document.createElement('script');s.src=window.__gs_preview_config.loaderUrl;s.async=1;document.body.appendChild(s);</script></body></html>"""

MEASURE = """() => {
  const r = document.querySelector('gs-widget').shadowRoot;
  const l = r.querySelector('.launcher'), p = r.querySelector('.panel');
  const lb = l.getBoundingClientRect(), pb = p.getBoundingClientRect();
  const pcs = getComputedStyle(p);
  return { launcher: {top: lb.top, bottom: lb.bottom, left: lb.left, right: lb.right, position: getComputedStyle(l).position},
           panel: {top: pb.top, bottom: pb.bottom, left: pb.left, right: pb.right, height: pb.height, inset: pcs.inset},
           vh: innerHeight, vw: innerWidth,
           zone: getComputedStyle(r.querySelector('.shell')).getPropertyValue('--gs-preview-launcher-zone').trim() };
}"""

SIZES = [(420, 720), (390, 700), (375, 667), (360, 640)]
failures = []

async def main():
    async with async_playwright() as pw:
        b = await pw.chromium.launch(headless=True)
        for (w, hgt) in SIZES:
            for pos in ["bottom-right", "bottom-left"]:
                for scale in [80, 100, 140]:
                    for anim in [True, False]:
                        ctx = await b.new_context(viewport={"width": w, "height": hgt})
                        pg = await ctx.new_page()
                        await pg.set_content(HTML % json.dumps(cfg(pos, scale, anim)))
                        await pg.wait_for_function("!!document.querySelector('gs-widget')?.shadowRoot?.querySelector('.panel.visible')", timeout=25000)
                        await pg.wait_for_timeout(500)
                        d = await pg.evaluate(MEASURE)
                        gap = d["launcher"]["top"] - d["panel"]["bottom"]
                        tag = f"{w}x{hgt} {pos} scale={scale} anim={anim}"
                        errs = []
                        if gap < 12: errs.append(f"gap={gap:.1f} < 12")
                        if d["launcher"]["bottom"] > d["vh"] + 0.5: errs.append("launcher below canvas")
                        if d["launcher"]["top"] < 0: errs.append("launcher above canvas")
                        if d["launcher"]["position"] != "absolute": errs.append(f"position={d['launcher']['position']}")
                        if d["panel"]["height"] >= d["vh"] - 0.5: errs.append("panel is fullscreen height")
                        if d["panel"]["top"] <= 0.5 and d["panel"]["bottom"] >= d["vh"] - 0.5: errs.append("panel uses inset:0")
                        print(("FAIL " if errs else "ok   ") + f"{tag} gap={gap:.1f} zone={d['zone']} panelH={d['panel']['height']:.0f}" + (" :: " + "; ".join(errs) if errs else ""))
                        if errs: failures.append(tag + " :: " + "; ".join(errs))
                        if scale in (100, 140) and (w, hgt) == (390, 700) and pos == "bottom-right" and anim:
                            await pg.screenshot(path=str(SHOTS / f"preview-scale{scale}.png"))
                        await ctx.close()
        await b.close()
    if failures:
        print("\nRESULT: FAIL (%d)" % len(failures)); [print(" -", f) for f in failures]; sys.exit(1)
    print("\nRESULT: PASS")

asyncio.run(main())
