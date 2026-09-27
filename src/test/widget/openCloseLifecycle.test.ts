import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(process.cwd(), "public/widget");
const loader = fs.readFileSync(path.join(root, "loader.js"), "utf8");
const css = fs.readFileSync(path.join(root, "presentation-default.css"), "utf8");
const runtime = fs.readFileSync(path.join(root, "runtime.js"), "utf8");

describe("widget open/close lifecycle contract", () => {
  it("runtime toggles the panel with .visible", () => {
    expect(runtime).toContain("panel.classList.add('visible')");
    expect(runtime).toContain("panel.classList.remove('visible')");
  });

  it("template shows the panel for .panel.visible (not .panel.open)", () => {
    expect(css).toMatch(/\.panel\.visible\s*\{[^}]*opacity:\s*1/);
    expect(css).not.toMatch(/\.panel\.open\s*\{/);
  });

  it("panel is inert while closed", () => {
    const base = css.match(/\n\.panel \{[\s\S]*?\n\}/)?.[0] ?? "";
    expect(base).toMatch(/opacity:\s*0/);
    expect(base).toMatch(/pointer-events:\s*none/);
  });

  it("launcher slides out of view while open and the panel owns a close control", () => {
    expect(loader).toContain(".launcher.open,.launcher.open:hover{transform:translateY(var(--gs-fab-exit,112px));");
    // The FAB enters from outside the browser edge on first paint.
    expect(loader).toContain(".launcher.enter,.launcher.enter:hover{transform:translateY(var(--gs-fab-exit,112px));");
    expect(loader).toContain(".launcher.open svg.chat-icon{display:none;}");
    expect(loader).toContain(".launcher:not(.open) svg.close-icon{display:none;}");
    const tpl = fs.readFileSync(path.join(root, "presentation-default.js"), "utf8");
    expect(tpl).toContain("data-panel-close");
  });

  it("explicitly raises the launcher while the panel close animation runs", () => {
    expect(loader).toContain("var wasOpen = isOpen || !!(launcherEl && launcherEl.classList.contains(\"open\"))");
    expect(loader).toContain("if (wasOpen) {");
    expect(loader).toContain("playFabEntry(launcherEl)");
    expect(loader).toContain('{ duration: 280, easing: "cubic-bezier(.22,1,.36,1)", fill: "none" }');
    expect(css).toContain("transition: transform 0.3s cubic-bezier(0.22, 1, 0.36, 1)");
  });

  it("launcher image crossfades over the configured icon on hover", () => {
    expect(loader).toContain(".launcher.has-image:hover .fab-img{opacity:0;transform:scale(.88);}");
  });

  it("panel fades and moves a short distance from the launcher corner", () => {
    expect(css).toMatch(/transform-origin:\s*bottom right/);
    expect(css).toMatch(/transform:\s*translateY\(16px\) scale\(0\.97\)/);
    // Both surfaces share ONE anchored corner: the shell is the zero-size
    // fixed parent and each child is absolute at bottom:0 of that corner.
    expect(loader).toContain(".shell.pos-bottom-right{bottom:24px;right:24px;left:auto;top:auto;}");
    expect(css).toMatch(/\.panel \{[\s\S]*?position:\s*absolute/);
  });

  it("template does not re-implement launcher icon state with wrong selectors", () => {
    expect(css).not.toContain(".shell.open .launcher");
    expect(css).not.toContain("launcher-open");
    expect(css).not.toContain("launcher-close");
  });

  it("close button has an X icon and retains its accessible name", () => {
    const tpl = fs.readFileSync(path.join(root, "presentation-default.js"), "utf8");
    expect(tpl).toContain('class="panel-close" data-panel-close aria-label=');
    expect(tpl).toContain('M18 6 6 18M6 6l12 12');
    expect(css).toMatch(/\.panel-close:focus-visible\s*\{[^}]*outline:/);
  });
});
