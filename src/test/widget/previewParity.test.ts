/**
 * Production ↔ Preview parity contract.
 *
 * The studio preview is allowed to fake the host page (background, viewport)
 * and nothing else. The moment it re-implements panel geometry or the
 * open/close lifecycle it starts masking real production bugs, which is
 * exactly the regression these tests lock out.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const preview = fs.readFileSync(
  path.resolve(process.cwd(), 'src/components/app/widget/WidgetLivePreview.tsx'),
  'utf8',
);
const css = fs.readFileSync(
  path.resolve(process.cwd(), 'public/widget/presentation-web-yar.css'),
  'utf8',
);
const loader = fs.readFileSync(path.resolve(process.cwd(), 'public/widget/loader.js'), 'utf8');
const runtime = fs.readFileSync(path.resolve(process.cwd(), 'public/widget/runtime.js'), 'utf8');

describe('preview never redefines widget geometry or lifecycle', () => {
  it('has no !important panel geometry overrides', () => {
    expect(preview).not.toMatch(/\.panel\{position:fixed!important/);
    expect(preview).not.toMatch(/\.panel\.bottom-(right|left)\{[^}]*!important/);
  });

  it('drives open/close through the production classes, not [hidden]', () => {
    expect(preview).not.toContain(".panel[hidden]");
    expect(preview).toContain("panel.classList.toggle('visible'");
    expect(preview).toContain("launcher.classList.toggle('open'");
  });

  it('uses the production launcher icon contract', () => {
    expect(preview).toContain('.launcher.open svg.chat-icon{display:none;}');
    expect(preview).toContain('.launcher:not(.open) svg.close-icon{display:none;}');
    expect(preview).toContain('class="close-icon"');
  });

  it('publishes the same --gs-fab-size variable production uses', () => {
    expect(preview).toContain('--gs-fab-size:');
    expect(loader).toContain('"--gs-fab-size"');
  });
});

describe('production panel positioning contract', () => {
  it('positions the panel itself — never a phantom .shell.pos-* class', () => {
    expect(css).not.toContain('.shell.pos-bottom-right');
    expect(css).not.toContain('.shell.pos-bottom-left');
    expect(css).toMatch(/\.panel\s*\{[\s\S]*?position:\s*fixed/);
  });

  it('anchors the panel above the launcher with the design geometry', () => {
    expect(css).toContain('bottom: calc(24px + var(--gs-fab-size, 56px) + 14px)');
    expect(css).toMatch(/\.panel\.bottom-right\s*\{[\s\S]*?right:\s*24px/);
    expect(css).toMatch(/\.panel\.bottom-left\s*\{[\s\S]*?left:\s*24px/);
    expect(css).toMatch(/width:\s*400px/);
    expect(css).toMatch(/height:\s*640px/);
    expect(css).toMatch(/max-height:\s*calc\(100dvh - 118px\)/);
  });

  it('the runtime puts the position class on the panel', () => {
    expect(runtime).toMatch(/bottom-left'\s*:\s*'bottom-right'/);
  });

  it('scrollbars are 6px with a stable gutter', () => {
    expect(css).toContain('scrollbar-gutter: stable');
    expect(css).toMatch(/\.wy-scroll::-webkit-scrollbar \{ width: 6px; \}/);
  });

  it('the powered-by dot matches the design pulse', () => {
    expect(css).toMatch(/\.wy-powered-dot[\s\S]*?width: 12px; height: 12px/);
    expect(css).toContain('animation: wy-load-pulse 0.9s ease-in-out 3');
  });
});

describe('generic presentation readiness', () => {
  it('lets the active presentation prepare itself without font/template knowledge in Core', () => {
    expect(loader).toContain('typeof presentationModule.prepare === "function"');
    expect(loader).not.toContain('IRANSans');
    expect(loader).not.toContain('web-yar');
    expect(preview).toContain("typeof mod.prepare === 'function'");
  });

  it('passes distinct workspace/platform identity and custom reply time to preview', () => {
    expect(preview).toContain('workspaceName: title');
    expect(preview).toContain('platformName: platformName');
    expect(preview).toContain('replyTimeText:');
  });

  it('opens articles through the same full KB renderer as production', () => {
    expect(preview).toContain('body.innerHTML = R.kbHtml(vm)');
  });
});

describe('silent preload lifecycle', () => {
  it('runtime.init() only mounts — it never opens the panel', () => {
    expect(runtime).toContain('shellStore.set({ isOpen: false, mounted: true });');
    expect(runtime).toContain('// LIFECYCLE CONTRACT: init() ONLY mounts.');
  });

  it('runtime exposes an isOpen() getter as the single source of truth', () => {
    expect(runtime).toMatch(/isOpen: function \(\) \{ return !!shellStore\.get\(\)\.isOpen; \}/);
  });

  it('loader syncs launcher state from the runtime instead of flipping a copy', () => {
    expect(loader).toContain('function syncOpenStateFromRuntime()');
    expect(loader).not.toContain('isOpen = !isOpen');
  });

  it('loader opens the panel only when something asked for it', () => {
    expect(loader).toMatch(/if \(wantRuntimeOpen\) \{\s*try \{ instance\.open\(\); \} catch/);
  });
});

describe('home surface — design renderVals() contract', () => {
  it('keeps article chips visible even with recent conversations', () => {
    const js = fs.readFileSync(
      path.resolve(process.cwd(), 'public/widget/presentation-web-yar.js'),
      'utf8',
    );
    // renderVals(): showArticleChips true, showArticlesButton false.
    expect(js).toContain('var showChips = vm.kbEnabled && articles.length > 0;');
    expect(js).toContain('var showArticlesButton = false;');
    expect(js).toContain('slice(0, 2)');
  });

  it('the footer credits the platform, not the workspace brand', () => {
    const js = fs.readFileSync(
      path.resolve(process.cwd(), 'public/widget/presentation-web-yar.js'),
      'utf8',
    );
    expect(js).toContain('(pb && pb.brand) || (config && config.platformName)');
    expect(js).not.toContain('config.brandName');
  });
});
