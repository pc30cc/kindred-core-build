/**
 * PROVIDER NETWORK ISOLATION GUARD (AI) — ARCHITECTURE INVARIANT.
 *
 * Deployment topology this protects:
 *
 *   IRAN / restricted network                 EXTERNAL / unrestricted
 *   Core + DB + Frontend        ──────▶       AI Runtime → AI providers
 *
 * The invariant is NOT "provider hostnames are absent from Core".
 * The invariant is:
 *
 *      CORE CANNOT EXECUTE AI PROVIDER NETWORK I/O.
 *
 * So this file guards every plausible way Core could regain that ability:
 * provider SDK dependencies, provider SDK imports, importing the runtime
 * provider executor (directly or re-exported), provider hostnames (whole or
 * split for dynamic construction), and ANY HTTP client inside Core's
 * AI-execution surface — the single allowed exception being the narrow
 * Core→Runtime client, which may only talk to AI_RUNTIME_URL.
 *
 * Core networking in general is NOT banned: KB crawling, billing providers,
 * storage, realtime and internal services legitimately make requests.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();

/** Full provider hostnames. */
const PROVIDER_HOSTS = [
  'api.openai.com',
  'api.anthropic.com',
  'generativelanguage.googleapis.com',
  'api.groq.com',
  'api.together.xyz',
  'api.mistral.ai',
  'api.deepseek.com',
  'api.perplexity.ai',
  'openrouter.ai',
  'api.cohere.ai',
];

/**
 * Registrable domains. Catches a hostname assembled at runtime
 * (`'api.' + 'openai.com'`), which the full-host check would miss.
 */
const PROVIDER_DOMAIN_FRAGMENTS = [
  'openai.com',
  'anthropic.com',
  'googleapis.com',
  'groq.com',
  'together.xyz',
  'mistral.ai',
  'deepseek.com',
  'perplexity.ai',
  'openrouter.ai',
  'cohere.ai',
];

/** Provider SDKs that would give Core provider I/O without any hostname. */
const PROVIDER_SDK_PACKAGES = [
  'openai',
  '@anthropic-ai/sdk',
  '@anthropic-ai/bedrock-sdk',
  '@google/generative-ai',
  '@google/genai',
  '@google-cloud/aiplatform',
  '@azure/openai',
  '@azure-rest/ai-inference',
  '@mistralai/mistralai',
  'groq-sdk',
  'cohere-ai',
  'together-ai',
  'ollama',
  'replicate',
  '@aws-sdk/client-bedrock-runtime',
  'langchain',
  '@langchain/core',
  '@langchain/openai',
  'llamaindex',
  '@ai-sdk/openai',
  '@ai-sdk/anthropic',
  '@ai-sdk/google',
];

/** HTTP clients that are forbidden inside Core's AI execution surface. */
const HTTP_CLIENT_IMPORTS = [
  'axios',
  'node-fetch',
  'undici',
  'got',
  'superagent',
  'request',
  'node:http',
  'node:https',
  'node:http2',
];

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

const rel = (file: string) => relative(ROOT, file);
const coreFiles = walk(join(ROOT, 'server'));

/**
 * Core's AI EXECUTION SURFACE: the files that orchestrate AI calls. Only the
 * runtime client may speak HTTP here, and only to AI_RUNTIME_URL.
 */
const AI_SURFACE_PREFIXES = [
  'server/services/ai/',
  'server/services/ai-agent/',
  'server/routes/ai.ts',
  'server/routes/ai-agent/',
  'server/routes/adminAi',
];

/**
 * Allowed non-provider network inside that surface:
 *  - runtimeClient.ts : the ONE Core→AI Runtime egress point
 *  - crawler/**       : KB crawling of the CUSTOMER's own site (not a provider)
 */
const AI_SURFACE_NETWORK_ALLOWLIST = [
  'server/services/ai/runtimeClient.ts',
  'server/services/ai-agent/crawler/',
];

function inAiSurface(file: string): boolean {
  const r = rel(file);
  return AI_SURFACE_PREFIXES.some((p) => r.startsWith(p));
}

function networkAllowed(file: string): boolean {
  const r = rel(file);
  return AI_SURFACE_NETWORK_ALLOWLIST.some((p) => r.startsWith(p));
}

function importedModules(src: string): string[] {
  const out: string[] = [];
  const patterns = [
    /(?:^|\n)\s*import\s[^;]*?from\s+['"]([^'"]+)['"]/g,
    /(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g,
    /(?:^|\n)\s*export\s[^;]*?from\s+['"]([^'"]+)['"]/g,
    /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) out.push(m[1]);
  }
  return out;
}

describe('AI provider network isolation — Core cannot execute provider I/O', () => {
  it('no Core file names an AI provider host', () => {
    const offenders: string[] = [];
    for (const file of coreFiles) {
      const src = readFileSync(file, 'utf8');
      for (const host of PROVIDER_HOSTS) {
        if (src.includes(host)) offenders.push(`${rel(file)} → ${host}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no Core file embeds a provider domain fragment (blocks dynamically built endpoints)', () => {
    const offenders: string[] = [];
    for (const file of coreFiles) {
      const src = readFileSync(file, 'utf8');
      for (const fragment of PROVIDER_DOMAIN_FRAGMENTS) {
        if (src.includes(fragment)) offenders.push(`${rel(file)} → ${fragment}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no provider SDK is a dependency of this project', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    const declared = new Set([
      ...Object.keys(pkg.dependencies || {}),
      ...Object.keys(pkg.devDependencies || {}),
      ...Object.keys(pkg.optionalDependencies || {}),
    ]);
    const offenders = PROVIDER_SDK_PACKAGES.filter((name) => declared.has(name));
    expect(offenders).toEqual([]);
  });

  it('no Core file imports a provider SDK', () => {
    const offenders: string[] = [];
    for (const file of coreFiles) {
      for (const mod of importedModules(readFileSync(file, 'utf8'))) {
        const base = mod.startsWith('@') ? mod.split('/').slice(0, 2).join('/') : mod.split('/')[0];
        if (PROVIDER_SDK_PACKAGES.includes(base)) offenders.push(`${rel(file)} → ${mod}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no Core file imports ANY runtime module (executor, catalog, embeddings, transport)', () => {
    const offenders: string[] = [];
    for (const file of coreFiles) {
      for (const mod of importedModules(readFileSync(file, 'utf8'))) {
        if (/(^|\/)runtime\/ai\//.test(mod) || /\.\.\/runtime\//.test(mod)) {
          offenders.push(`${rel(file)} → ${mod}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('dependency direction: nothing under server/** reaches the provider execution modules, even re-exported', () => {
    // Build the set of modules that (transitively) re-export provider I/O.
    const providerModules = new Set(
      walk(join(ROOT, 'runtime')).map((f) => rel(f).replace(/\.ts$/, '')),
    );
    const offenders: string[] = [];
    for (const file of coreFiles) {
      const src = readFileSync(file, 'utf8');
      for (const mod of importedModules(src)) {
        if (!mod.startsWith('.')) continue;
        const resolved = rel(join(file, '..', mod)).replace(/\.js$/, '').replace(/\.ts$/, '');
        if (providerModules.has(resolved)) offenders.push(`${rel(file)} → ${mod}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("Core's AI execution surface uses no HTTP client except the runtime client", () => {
    const offenders: string[] = [];
    for (const file of coreFiles) {
      if (!inAiSurface(file) || networkAllowed(file)) continue;
      const src = readFileSync(file, 'utf8');
      if (/\bfetch\s*\(/.test(src)) offenders.push(`${rel(file)} → fetch(`);
      for (const mod of importedModules(src)) {
        const base = mod.startsWith('@') ? mod.split('/').slice(0, 2).join('/') : mod;
        if (HTTP_CLIENT_IMPORTS.includes(base) || HTTP_CLIENT_IMPORTS.includes(mod)) {
          offenders.push(`${rel(file)} → ${mod}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the runtime client targets AI_RUNTIME_URL only — no literal external endpoint', () => {
    const client = readFileSync(join(ROOT, 'server/services/ai/runtimeClient.ts'), 'utf8');
    expect(client).toContain('AI_RUNTIME_ROUTES');
    expect(client).toContain('config.aiRuntimeBaseUrl');
    // Exactly one fetch call, and no hardcoded absolute URL to build it from.
    expect(client.match(/\bfetch\s*\(/g)?.length).toBe(1);
    expect(client).not.toMatch(/https?:\/\/[a-z0-9.-]+/i);
  });

  it('Core reaches AI only through the AI Runtime client', () => {
    const service = readFileSync(join(ROOT, 'server/services/ai/index.ts'), 'utf8');
    expect(service).toContain('runtimeComplete');
    expect(service).not.toMatch(/\bfetch\s*\(/);
  });

  it('the AI Runtime deployable refuses database and platform credentials', () => {
    const server = readFileSync(join(ROOT, 'ai-runtime/server.ts'), 'utf8');
    for (const forbidden of ['SUPABASE_SERVICE_ROLE_KEY', 'PLUGIN_SECRETS_MASTER_KEY', 'SESSION_SECRET']) {
      expect(server).toContain(forbidden);
    }
    expect(server).toContain('process.exit(1)');
  });
});

describe('AI Runtime deployable boundary — the image ships no server/ code', () => {
  const runtimeFiles = [...walk(join(ROOT, 'runtime')), ...walk(join(ROOT, 'ai-runtime'))];

  it('no runtime/** or ai-runtime/** file imports server/**', () => {
    const offenders: string[] = [];
    for (const file of runtimeFiles) {
      for (const mod of importedModules(readFileSync(file, 'utf8'))) {
        if (/(^|\/)server\//.test(mod)) offenders.push(`${rel(file)} → ${mod}`);
      }
    }
    // A single one of these is an ERR_MODULE_NOT_FOUND at container start:
    // Dockerfile.ai copies ai-runtime/, runtime/ and shared/ only.
    expect(offenders).toEqual([]);
  });

  it('Dockerfile.ai copies exactly the directories the runtime may import', () => {
    const dockerfile = readFileSync(join(ROOT, 'Dockerfile.ai'), 'utf8');
    expect(dockerfile).toMatch(/COPY ai-runtime/);
    expect(dockerfile).toMatch(/COPY runtime/);
    expect(dockerfile).toMatch(/COPY shared/);
    expect(dockerfile).not.toMatch(/^COPY server/m);
  });

  it('the runtime only imports runtime/**, shared/** or real npm packages', () => {
    const offenders: string[] = [];
    for (const file of runtimeFiles) {
      for (const mod of importedModules(readFileSync(file, 'utf8'))) {
        if (!mod.startsWith('.')) continue;
        const resolved = rel(join(file, '..', mod));
        if (!/^(runtime|ai-runtime|shared)\//.test(resolved)) offenders.push(`${rel(file)} → ${mod}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
