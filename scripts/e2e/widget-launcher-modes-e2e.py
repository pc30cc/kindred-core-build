import asyncio, functools, http.server, json, socketserver, threading
from pathlib import Path
from playwright.async_api import async_playwright
DIST=Path("/dev-server/dist"); PORT=8097
M=json.loads((DIST/"widget"/"widget-manifest.json").read_text())
h=functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(DIST))
class TS(socketserver.TCPServer): allow_reuse_address=True
threading.Thread(target=TS(("127.0.0.1",PORT),h).serve_forever,daemon=True).start()
B=f"http://127.0.0.1:{PORT}"
def cfg(preview, pos="bottom-right", anim=True):
    c={"brandName":"Support","primaryColor":"#6D5DFB","locale":"en","widgetLanguage":"en","position":pos,
       "runtimeUrl":f"{B}/widget/{M['runtime.js']}","styleUrl":f"{B}/widget/{M['runtime.css']}",
       "loaderVersion":M["loaderVersion"],"assetBase":B,
       "modules":{"chat":f"{B}/widget/{M['runtime-chat.js']}","kb":f"{B}/widget/{M['runtime-kb.js']}","call":f"{B}/widget/{M['runtime-call.js']}"},
       "features":{"chat":True,"knowledgeBase":True,"visitorTracking":False},
       "fab":{"icon":"chat","shape":"circle","scale":100,"animation":anim,"label":""},
       "loaderUrl":f"{B}/widget/loader.js?v={M['loaderVersion']}","_apiBase":B,"_assetBase":B,"_sessionToken":"preview"}
    if preview: c.update({"previewMode":True,"previewView":"chat","previewSeed":{"messages":[{"id":"1","sender_type":"agent","content":"Hello!","created_at":"2026-08-05T10:00:00Z"}]}})
    return c
HTML="""<!doctype html><html><head><meta charset=utf-8><style>html,body{margin:0;height:100%%;background:#eef}</style></head><body><script>
window.__gs_preview_config=%s;var s=document.createElement('script');s.src=window.__gs_preview_config.loaderUrl;s.async=1;document.body.appendChild(s);</script></body></html>"""
async def rects(page):
    return await page.evaluate("""()=>{const r=document.querySelector('gs-widget').shadowRoot;
      const l=r.querySelector('.launcher'),p=r.querySelector('.panel');
      const lb=l.getBoundingClientRect(),pb=p?p.getBoundingClientRect():null;const cs=getComputedStyle(l);
      return {launcher:{t:lb.top,b:lb.bottom,l:lb.left,r:lb.right,vis:cs.visibility,op:cs.opacity,pos:cs.position,anim:cs.animationName,trans:cs.transition},
        panel:pb?{t:pb.top,b:pb.bottom,l:pb.left,r:pb.right,vis:p.classList.contains('visible'),trans:getComputedStyle(p).transitionDuration}:null,
        mode:r.querySelector('.shell').className, vh:innerHeight};}""")
async def main():
  async with async_playwright() as pw:
    b=await pw.chromium.launch(headless=True)
    for name,size in [("desktop",(1280,900)),("tablet",(768,900)),("mobile",(390,760))]:
      for pos in ["bottom-right","bottom-left"]:
        ctx=await b.new_context(viewport={"width":size[0],"height":size[1]})
        pg=await ctx.new_page(); await pg.set_content(HTML % json.dumps(cfg(True,pos)))
        await pg.wait_for_function("!!document.querySelector('gs-widget')?.shadowRoot?.querySelector('.panel.visible')",timeout=20000)
        await pg.wait_for_timeout(600); d=await rects(pg)
        overlap = d["panel"] and not (d["launcher"]["t"] >= d["panel"]["b"]-0.5)
        inside = d["launcher"]["b"]<=size[1] and d["launcher"]["t"]>=0
        print(f"PREVIEW {name} {pos}: gap={round(d['launcher']['t']-d['panel']['b'],1)} overlap={overlap} inside={inside} pos={d['launcher']['pos']} launcherVis={d['launcher']['vis']}/{d['launcher']['op']} aligned={round(d['launcher']['r']-d['panel']['r'],1)}/{round(d['launcher']['l']-d['panel']['l'],1)}")
        await ctx.close()
    # runtime
    ctx=await b.new_context(viewport={"width":1280,"height":900}); pg=await ctx.new_page()
    await pg.set_content(HTML % json.dumps(cfg(False)))
    await pg.wait_for_function("!!document.querySelector('gs-widget')?.shadowRoot?.querySelector('.panel')",timeout=20000)
    # settle to CLOSED first (the injected-config bootstrap auto-opens)
    await pg.evaluate("window.__gs_widget && window.__gs_widget.close ? window.__gs_widget.close() : window.__gs_runtime._instance.close()")
    await pg.evaluate("document.querySelector('gs-widget').shadowRoot.querySelector('.launcher').classList.remove('open')")
    await pg.wait_for_timeout(600); d=await rects(pg); lb0=d["launcher"]
    print("RUNTIME closed:",{"launcherVis":d["launcher"]["vis"],"panelVisible":d["panel"]["vis"],"mode":d["mode"]})
    await pg.evaluate("document.querySelector('gs-widget').shadowRoot.querySelector('.launcher').click()")
    await pg.wait_for_function("!!document.querySelector('gs-widget').shadowRoot.querySelector('.panel.visible')",timeout=20000)
    await pg.wait_for_timeout(700); d=await rects(pg)
    print("LCLS:", await pg.evaluate("document.querySelector('gs-widget').shadowRoot.querySelector('.launcher').className"))
    print("RUNTIME open:",{"launcherVis":d["launcher"]["vis"],"launcherOp":d["launcher"]["op"],"panelBottomOffset":round(900-d["panel"]["b"],1),"panelVisible":d["panel"]["vis"]})
    await pg.evaluate("document.querySelector('gs-widget').shadowRoot.querySelector('[data-header-close]')?.click()")
    await pg.wait_for_timeout(700); d=await rects(pg)
    print("RUNTIME closed again:",{"launcherVis":d["launcher"]["vis"],"same_pos":abs(d["launcher"]["b"]-lb0["b"])<0.5 and abs(d["launcher"]["r"]-lb0["r"])<0.5,"panelVisible":d["panel"]["vis"],"launchers":await pg.evaluate("document.querySelector('gs-widget').shadowRoot.querySelectorAll('.launcher').length")})
    await ctx.close()
    # anim off
    ctx=await b.new_context(viewport={"width":1280,"height":900}); pg=await ctx.new_page()
    await pg.set_content(HTML % json.dumps(cfg(False,anim=False)))
    await pg.wait_for_function("!!document.querySelector('gs-widget')?.shadowRoot?.querySelector('.launcher.revealed')",timeout=20000)
    await pg.wait_for_function("!!document.querySelector('gs-widget').shadowRoot.querySelector('.panel.visible')",timeout=20000)
    await pg.wait_for_timeout(300); d=await rects(pg)
    print("ANIM OFF:",{"panelTransition":d["panel"]["trans"],"launcherTransition":d["launcher"]["trans"],"launcherAnim":d["launcher"]["anim"],"shell":d["mode"]})
    await ctx.close()
    # reduced motion
    ctx=await b.new_context(viewport={"width":1280,"height":900},reduced_motion="reduce"); pg=await ctx.new_page()
    await pg.set_content(HTML % json.dumps(cfg(False,anim=True)))
    await pg.wait_for_function("!!document.querySelector('gs-widget')?.shadowRoot?.querySelector('.launcher.revealed')",timeout=20000)
    await pg.wait_for_function("!!document.querySelector('gs-widget').shadowRoot.querySelector('.panel.visible')",timeout=20000)
    d=await rects(pg); print("REDUCED MOTION:",{"panelTransition":d["panel"]["trans"],"launcherAnim":d["launcher"]["anim"]})
    await b.close()
asyncio.run(main())
