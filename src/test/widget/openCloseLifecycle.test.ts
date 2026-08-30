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

  it("launcher never disappears while open — only the icon swaps", () => {
    expect(loader).not.toMatch(/\.launcher\.open\{opacity:0/);
    expect(loader).toContain(".launcher.open svg.chat-icon{display:none;}");
    expect(loader).toContain(".launcher:not(.open) svg.close-icon{display:none;}");
    expect(loader).not.toContain("panel owns");
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
