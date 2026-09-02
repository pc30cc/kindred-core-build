/**
 * WORKSPACE INVITATIONS v5.1 — Section H source-level CI guards.
 *
 * These run with NO database: they are static guards over the repository, so
 * they can never silently skip. Database-side guards live in
 * `scripts/ci/advisor-fingerprints.sql` + `scripts/ci/advisor-baseline-check.mjs`.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');

function walk(dir: string, exts: string[]): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) continue;
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walk(full, exts));
    else if (exts.some((e) => entry.endsWith(e))) out.push(full);
  }
  return out;
}

const frontendFiles = walk(path.join(ROOT, 'src'), ['.ts', '.tsx']);
const serverFiles = walk(path.join(ROOT, 'server'), ['.ts']);

describe('Section H — service_role never reaches browser code', () => {
  it('no frontend source references a service-role key', () => {
    const offenders = frontendFiles.filter((file) => {
      if (file.includes(`${path.sep}test${path.sep}`)) return false;
      const source = readFileSync(file, 'utf8');
      // A field-name string in a provider config schema is not a key; an env
      // read or a client constructed with one is.
      return /import\.meta\.env[^\n;]*SERVICE_ROLE|process\.env[^\n;]*SERVICE_ROLE|createClient\([^)]*service[_A-Za-z]*[Rr]ole/.test(source);
    });
    expect(offenders.map((f) => path.relative(ROOT, f))).toEqual([]);
  });
});

describe('Section H — no secret material is ever logged', () => {
  const FORBIDDEN = [
    /console\.[a-z]+\([^)]*\b(rawToken|raw_token|otpCode|otp_code|plainToken)\b/,
    /console\.[a-z]+\([^)]*\b(password|passwordHash|pepper|proofSecret|proof_secret)\b/,
  ];

  it('server invitation code logs no raw token, OTP, password, proof or pepper', () => {
    const invitationFiles = serverFiles.filter((f) => f.includes(`${path.sep}invitations${path.sep}`));
    expect(invitationFiles.length).toBeGreaterThan(0);
    const offenders: string[] = [];
    for (const file of invitationFiles) {
      const source = readFileSync(file, 'utf8');
      if (FORBIDDEN.some((re) => re.test(source))) offenders.push(path.relative(ROOT, file));
    }
    expect(offenders).toEqual([]);
  });
});

describe('Section H — site default language is authoritative', () => {
  const i18n = readFileSync(path.join(ROOT, 'src/i18n/index.tsx'), 'utf8');

  it('the resolver reads the runtime site default and never the browser language', () => {
    expect(i18n).toContain('getSiteDefaultLocale');
    expect(i18n).toMatch(/__APP_RUNTIME_CONFIG__/);
    expect(i18n).not.toMatch(/navigator\.(language|languages)/);
  });

  it('runtime-config exposes a configurable defaultLocale', () => {
    const runtimeConfig = readFileSync(path.join(ROOT, 'public/runtime-config.js'), 'utf8');
    expect(runtimeConfig).toMatch(/defaultLocale\s*:/);
  });

  it('Persian is RTL while Turkish and English are LTR', () => {
    const config = readFileSync(path.join(ROOT, 'src/i18n/config.ts'), 'utf8');
    expect(config).toMatch(/fa:[^\n]*dir:\s*'rtl'/);
    expect(config).toMatch(/tr:[^\n]*dir:\s*'ltr'/);
    expect(config).toMatch(/en:[^\n]*dir:\s*'ltr'/);
    // The provider must apply the resolved direction, not a hardcoded one.
    expect(i18n).toContain('document.documentElement.dir = dir');
  });
});

describe('Section H — invitation UI has no hardcoded user-facing English', () => {
  const files = [
    'src/features/invitations/InvitationManagement.tsx',
    'src/pages/auth/InvitePage.tsx',
  ].filter((rel) => existsSync(path.join(ROOT, rel)));

  it('inspects the real invitation surfaces', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const rel of files) {
    it(`${rel} renders text only through the i18n helper`, () => {
      const source = readFileSync(path.join(ROOT, rel), 'utf8');
      // JSX text nodes containing two or more Latin words are a hardcoded string.
      const jsxText = [...source.matchAll(/>\s*([A-Z][A-Za-z]+(?:\s+[a-zA-Z]+){1,})\s*</g)].map((m) => m[1]);
      // `t("key", "English fallback")` style fallbacks are equally forbidden.
      const fallbacks = [...source.matchAll(/\bt\(\s*['"][^'"]+['"]\s*,\s*['"][A-Za-z][^'"]*['"]/g)].map((m) => m[0]);
      expect({ jsxText, fallbacks }).toEqual({ jsxText: [], fallbacks: [] });
    });
  }
});

describe('Section H — advisor baseline integrity', () => {
  const baseline = JSON.parse(readFileSync(path.join(ROOT, 'security/advisor-baseline.json'), 'utf8'));

  it('every finding carries a full inventory record', () => {
    expect(Array.isArray(baseline.findings)).toBe(true);
    expect(baseline.findings.length).toBeGreaterThan(0);
    for (const finding of baseline.findings) {
      for (const field of ['fingerprint', 'category', 'object', 'severity', 'reason', 'exposure', 'decision', 'justification', 'owner', 'follow_up']) {
        expect(typeof finding[field], `${finding.fingerprint} is missing ${field}`).toBe('string');
        expect(String(finding[field]).length, `${finding.fingerprint}.${field} is empty`).toBeGreaterThan(0);
      }
      expect(typeof finding.intentional).toBe('boolean');
    }
  });

  it('fingerprints are unique', () => {
    const seen = new Set(baseline.findings.map((f: { fingerprint: string }) => f.fingerprint));
    expect(seen.size).toBe(baseline.findings.length);
  });

  it('no finding is dismissed as a bare baseline', () => {
    const lazy = baseline.findings.filter(
      (f: { justification: string }) => /^baseline\.?$/i.test(f.justification.trim()),
    );
    expect(lazy).toEqual([]);
  });

  it('the human inventory document exists', () => {
    expect(existsSync(path.join(ROOT, 'docs/WORKSPACE_INVITATIONS_ADVISOR_INVENTORY.md'))).toBe(true);
  });
});

describe('Section H — migration chain and mirror drift', () => {
  it('self-host migrations are numbered without gaps or duplicates', () => {
    const dir = path.join(ROOT, 'database/migrations');
    const numbers = readdirSync(dir)
      .filter((f) => /^\d{3}_.*\.sql$/.test(f))
      .map((f) => Number(f.slice(0, 3)))
      .sort((a, b) => a - b);
    expect(numbers.length).toBeGreaterThan(0);
    const duplicates = numbers.filter((n, i) => i > 0 && numbers[i - 1] === n);
    expect(duplicates).toEqual([]);
  });
});
