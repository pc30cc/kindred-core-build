import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import ts from "typescript";
import en from "@/i18n/locales/en";
import fa from "@/i18n/locales/fa";
import tr from "@/i18n/locales/tr";

const files = [
  "src/components/admin/observability/AlertsPanel.tsx",
  "src/components/admin/observability/AutoActionsPanel.tsx",
];

const technicalCopy = new Set([
  "X-Alert-Signature",
  "https://hooks.example.com/alerts",
]);

function leaves(value: unknown, prefix = ""): string[] {
  if (!value || typeof value !== "object") return [prefix];
  return Object.entries(value as Record<string, unknown>).flatMap(
    ([key, child]) => leaves(child, prefix ? `${prefix}.${key}` : key),
  );
}

function untranslated(path: string): string[] {
  const source = readFileSync(resolve(process.cwd(), path), "utf8");
  const file = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const result: string[] = [];

  const visit = (node: ts.Node) => {
    if (ts.isJsxText(node)) {
      const text = node.text.replace(/\s+/g, " ").trim();
      if (/[A-Za-z]{2}/.test(text)) result.push(text);
    }
    if (
      ts.isJsxAttribute(node) &&
      node.initializer &&
      ts.isStringLiteral(node.initializer)
    ) {
      const visibleAttributes = [
        "placeholder",
        "title",
        "aria-label",
        "label",
        "description",
      ];
      if (
        visibleAttributes.includes(node.name.getText(file)) &&
        /[A-Za-z]{2}/.test(node.initializer.text)
      ) {
        result.push(node.initializer.text);
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(file);
  return result.filter((text) => !technicalCopy.has(text));
}

describe("Super Admin phase 4 localization", () => {
  it("keeps the expanded observability keys identical in all locales", () => {
    const expected = leaves(en.admin.observability).sort();
    expect(leaves(fa.admin.observability).sort()).toEqual(expected);
    expect(leaves(tr.admin.observability).sort()).toEqual(expected);
  });

  it.each(files)("%s contains no untranslated visible English copy", (path) => {
    expect(untranslated(path)).toEqual([]);
  });
});
