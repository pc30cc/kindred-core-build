import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(process.cwd(), "public/widget");
const loader = fs.readFileSync(path.join(root, "loader.js"), "utf8");
const css = fs.readFileSync(path.join(root, "presentation-web-yar.css"), "utf8");
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
    expect(loader).toContain(".launcher.open{transform:translateY(150%) scale(.6);opacity:0;pointer-events:none;animation:none;}");
    expect(loader).toContain(".launcher.open svg.chat-icon{display:none;}");
    expect(loader).toContain(".launcher:not(.open) svg.close-icon{display:none;}");
    const tpl = fs.readFileSync(path.join(root, "presentation-web-yar.js"), "utf8");
    expect(tpl).toContain("data-panel-close");
  });

  it("launcher image reveals the icon with a clip-path circle on hover", () => {
    expect(loader).toContain(".launcher.has-image:hover .fab-img{clip-path:circle(0% at 50% 50%);}");
  });

  it("panel grows from the launcher corner (shared origin)", () => {
    expect(css).toMatch(/transform-origin:\s*bottom right/);
    expect(css).toMatch(/transform:\s*translateY\(18px\) scale\(0\.68\)/);
  });

  it("template does not re-implement launcher icon state with wrong selectors", () => {
    expect(css).not.toContain(".shell.open .launcher");
    expect(css).not.toContain("launcher-open");
    expect(css).not.toContain("launcher-close");
  });

  it("no header close control is added by the template", () => {
    const tpl = fs.readFileSync(path.join(root, "presentation-web-yar.js"), "utf8");
    expect(tpl).not.toContain("data-close-panel");
  });
});
