import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, posix, sep } from 'node:path';

/**
 * Canonical single-design guard for the Chat Widget.
 *
 * The chat widget ships exactly one visual implementation and exactly one
 * runtime path. No file — existing or newly added — inside the widget-related
 * scope may reintroduce a template/skin selector.
 *
 * This scan is RECURSIVE on purpose: adding a brand-new file must not be a way
 * to smuggle the old multi-template system back in.
 */

/** Directories that are recursively scanned. */
const SCAN_ROOTS = [
  'public/widget',
  'src/components/app/widget',
  'src/components/admin/widget',
  'src/pages/app',
  'src/pages/admin',
  'src/hooks',
  'src/lib',
  'server/routes',
  'server/services/widget',
];

const SCANNABLE_EXTENSIONS = ['.js', '.cjs', '.mjs', '.ts', '.tsx', '.css', '.scss', '.json'];

/** Never descend into these directory names. */
const SKIPPED_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', '.git', 'assets']);

/** Never scan these file names (lock files, generated maps, etc.). */
const SKIPPED_FILES = new Set([
  'package-lock.json',
  'bun.lock',
  'bun.lockb',
  'pnpm-lock.yaml',
  'yarn.lock',
]);

/** Tokens belonging exclusively to the deleted chat-widget template system. */
const FORBIDDEN_TOKENS = [
  'templateSlug',
  'template_slug',
  'template2',
  'isT2',
  'data-template',
  'TemplateRegistry',
  'getActiveTemplateSlug',
  'WidgetTemplatesSection',
  'TemplateGallery',
  'useWidgetTemplates',
  'useWorkspaceWidgetTemplates',
  'widget-templates-api',
  'adminWidgetTemplates',
];

/**
 * Narrow, per-file, per-line exceptions.
 *
 * These exist ONLY because the transactional EMAIL / notification template
 * system legitimately uses similar identifiers. Each entry allows one specific
 * token on lines matching one specific pattern in one specific file — a chat
 * widget template selector coming back would still fail, because it would not
 * match any of these patterns.
 */
type Allowance = { file: string; token: string; pattern: RegExp; reason: string };

const ALLOWANCES: Allowance[] = [
  {
    file: 'server/routes/widget.ts',
    token: 'templateSlug',
    // Transactional email sent when an offline message arrives — an email
    // template slug passed to sendEmail(), not a widget UI skin.
    pattern: /templateSlug:\s*'offline_message_received'/,
    reason: 'Offline-message notification EMAIL template slug (sendEmail payload).',
  },
  {
    file: 'server/routes/email.ts',
    token: 'templateSlug',
    // The email API route forwards the caller-supplied EMAIL template slug.
    pattern: /\btemplateSlug\b/,
    reason: 'Transactional email API surface — email template slug only.',
  },
  {
    file: 'src/lib/api.ts',
    token: 'template_slug',
    // email_logs table column exposed in the email log type/select.
    pattern: /template_slug(:\s*string \| null;|')|select\('id, template_slug/,
    reason: 'email_logs database column (email delivery log).',
  },
  {
    file: 'server/routes/admin.ts',
    token: 'template_slug',
    pattern: /select\('id, template_slug/,
    reason: 'email_logs database column selected for the admin email log.',
  },
  {
    file: 'src/pages/admin/UsersPage.tsx',
    token: 'template_slug',
    // Renders the email-log row's email template slug.
    pattern: /m\.template_slug/,
    reason: 'Renders the email_logs row template slug in the user email history.',
  },
];

/** Files that must NOT come back — the deleted multi-template implementation. */
const REMOVED_FILES = [
  'server/services/widget/templates.ts',
  'server/routes/adminWidgetTemplates.ts',
  'src/lib/widget-templates-api.ts',
  'src/hooks/useWidgetTemplates.ts',
  'src/hooks/useWorkspaceWidgetTemplates.ts',
  'src/components/app/widget/TemplateGallery.tsx',
  'src/components/admin/widget/WidgetTemplatesSection.tsx',
];

function isScannableFile(name: string): boolean {
  if (SKIPPED_FILES.has(name)) return false;
  if (name.endsWith('.map')) return false;
  return SCANNABLE_EXTENSIONS.some((ext) => name.endsWith(ext));
}

function walkDirectory(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) {
      if (SKIPPED_DIRS.has(entry)) continue;
      walkDirectory(full, out);
    } else if (stats.isFile() && isScannableFile(entry)) {
      out.push(full.split(sep).join(posix.sep));
    }
  }
  return out;
}

function isAllowed(file: string, token: string, line: string): boolean {
  return ALLOWANCES.some((a) => a.file === file && a.token === token && a.pattern.test(line));
}

function findForbiddenTokens(file: string): string[] {
  const violations: string[] = [];
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, index) => {
    for (const token of FORBIDDEN_TOKENS) {
      if (!line.includes(token)) continue;
      if (isAllowed(file, token, line)) continue;
      violations.push(
        `Forbidden widget template token "${token}" found in:\n  ${file}:${index + 1}\n    ${line.trim().slice(0, 200)}`,
      );
    }
  });
  return violations;
}

describe('chat widget — single canonical design', () => {
  const files = SCAN_ROOTS.flatMap((root) => walkDirectory(root)).sort();

  it('scans a non-empty, deterministic set of widget-scoped files', () => {
    expect(files.length).toBeGreaterThan(0);
    expect(files).toEqual([...files].sort());
  });

  it('contains no chat-widget template-selection tokens anywhere in scope', () => {
    const violations = files.flatMap((file) => findForbiddenTokens(file));
    expect(
      violations.length,
      violations.length
        ? `\n${violations.join('\n\n')}\n\n(${violations.length} violation(s) across ${files.length} scanned files)`
        : '',
    ).toBe(0);
  });

  it('deleted multi-template implementation files have not returned', () => {
    const resurrected = REMOVED_FILES.filter((f) => existsSync(f));
    expect(resurrected.length, `Deleted template files reappeared:\n  ${resurrected.join('\n  ')}`).toBe(0);
  });

  it('server widget config does not expose a template selector', () => {
    const src = readFileSync('server/routes/widget.ts', 'utf8');
    // NOTE: `templateSlug: 'offline_message_received'` in this file belongs to
    // the transactional EMAIL template system and is unrelated to widget UI.
    expect(src.includes('getActiveTemplateSlug')).toBe(false);
    expect(/templateSlug:\s*await/.test(src)).toBe(false);
    expect(/template_slug/.test(src)).toBe(false);
  });
});
