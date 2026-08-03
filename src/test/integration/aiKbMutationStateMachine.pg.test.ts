/**
 * Phase 6-S5-R7.2 — REAL database proof for the generated-article state
 * machine, slug-seed contract, mutation concurrency and RPC privilege
 * lockdown.
 *
 * These properties are unprovable in unit tests: they depend on row locks,
 * two genuinely concurrent transactions and PostgreSQL's own ACL evaluation.
 *
 * Enabled by TEST_DATABASE_URL. Skipped — never silently green — without one.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { installMigrationChain } from './pgMigrationChain';

const DSN = process.env.TEST_DATABASE_URL;
const suite = DSN ? describe : describe.skip;

const MIGRATIONS = [
  'database/migrations/009_fanout_cursor_generation_and_ai_kb_tx.sql',
  'database/migrations/010_fanout_rpc_security_and_kb_state_machine.sql',
];

const WS = '0000eeee-0000-4000-8000-000000000001';
const OTHER_WS = '0000eeee-0000-4000-8000-000000000002';
const REVIEWER = '0000eeee-0000-4000-8000-0000000000ff';

suite('AI-KB generated-article mutations (PostgreSQL)', () => {
  let db: any;
  let Client: any;
  let seq = 0;

  const newClient = async () => {
    const c = new Client({ connectionString: DSN });
    await c.connect();
    return c;
  };

  beforeAll(async () => {
    ({ Client } = await import('pg'));
    db = await newClient();
    await db.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
    await db.query('DROP TABLE IF EXISTS public.ai_kb_generated_articles CASCADE');
    await db.query('DROP TABLE IF EXISTS public.knowledge_base_articles CASCADE');
    await db.query('DROP TABLE IF EXISTS public.entitlement_fanout_jobs CASCADE');
    await db.query(`
      CREATE TABLE public.knowledge_base_articles (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        workspace_id uuid NOT NULL,
        slug text NOT NULL,
        locale text NOT NULL,
        title text NOT NULL,
        content text,
        excerpt text,
        status text NOT NULL DEFAULT 'draft',
        UNIQUE (workspace_id, locale, slug)
      );
      CREATE TABLE public.ai_kb_generated_articles (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        job_id uuid,
        workspace_id uuid NOT NULL,
        title text NOT NULL,
        slug text,
        excerpt text,
        content_md text,
        locale text NOT NULL DEFAULT 'en',
        status text NOT NULL DEFAULT 'pending',
        kb_article_id uuid,
        reviewed_by uuid,
        reviewed_at timestamptz
      );
    `);
    // 010 locks down the fan-out RPCs too, so the whole chain is installed.
    await installMigrationChain(db);
  }, 180_000);

  afterAll(async () => { if (db) await db.end(); });

  const seed = async (over: Record<string, any> = {}) => {
    seq += 1;
    const r = await db.query(
      `INSERT INTO public.ai_kb_generated_articles
         (workspace_id, title, slug, excerpt, content_md, locale)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [
        over.workspace_id ?? WS,
        over.title ?? 'How to reset a password',
        'slug' in over ? over.slug : `sm-${seq}`,
        'summary', '<p>body</p>', over.locale ?? 'en',
      ],
    );
    return r.rows[0];
  };

  const call = async (fn: string, args: any[], on: any = db) => {
    const ph = args.map((_, i) => `$${i + 1}`).join(',');
    return (await on.query(`SELECT public.${fn}(${ph}) AS r`, args)).rows[0].r;
  };
  const accept = (id: string, ws = WS, content = '<p>x</p>', seed?: string) =>
    call('accept_ai_kb_generated_article', [id, ws, REVIEWER, content, seed ?? null]);
  const publish = (id: string, ws = WS, content = '<p>x</p>', seed?: string) =>
    call('publish_ai_kb_generated_article', [id, ws, REVIEWER, content, seed ?? null]);
  const reject = (id: string, ws = WS) =>
    call('reject_ai_kb_generated_article', [id, ws, REVIEWER]);

  const statusOf = async (id: string) =>
    (await db.query('SELECT status FROM public.ai_kb_generated_articles WHERE id=$1', [id]))
      .rows[0].status;

  // ── State machine ────────────────────────────────────────────
  describe('state machine', () => {
    it('refuses to reject a draft that was already published', async () => {
      const g = await seed();
      expect((await publish(g.id)).ok).toBe(true);
      const out = await reject(g.id);
      expect(out.ok).toBe(false);
      expect(out.error).toBe('invalid_state');
      expect(out.current_status).toBe('published');
      // The refusal must not have downgraded the row.
      expect(await statusOf(g.id)).toBe('published');
    });

    it('refuses to accept (downgrade) a published draft', async () => {
      const g = await seed();
      await publish(g.id);
      const out = await accept(g.id);
      expect(out.error).toBe('invalid_state');
      expect(await statusOf(g.id)).toBe('published');
    });

    it('refuses to publish or accept a rejected draft', async () => {
      const g = await seed();
      expect((await reject(g.id)).ok).toBe(true);
      expect((await publish(g.id)).error).toBe('invalid_state');
      expect((await accept(g.id)).error).toBe('invalid_state');
      expect(await statusOf(g.id)).toBe('rejected');
      // A rejected draft must never own a KB article.
      const linked = (await db.query(
        'SELECT kb_article_id FROM public.ai_kb_generated_articles WHERE id=$1', [g.id],
      )).rows[0].kb_article_id;
      expect(linked).toBeNull();
    });

    it('refuses to reject a draft that was accepted (it owns an article)', async () => {
      const g = await seed();
      expect((await accept(g.id)).ok).toBe(true);
      expect((await reject(g.id)).error).toBe('invalid_state');
      expect(await statusOf(g.id)).toBe('accepted');
    });

    it('allows the legal forward path pending → accepted → published', async () => {
      const g = await seed();
      const a = await accept(g.id);
      expect(a.status).toBe('draft');
      const p = await publish(g.id);
      expect(p.ok).toBe(true);
      // Promotion reuses the SAME article: no duplicate in the Help Center.
      expect(p.kb_article_id).toBe(a.kb_article_id);
      expect(p.status).toBe('published');
    });

    it('is idempotent for repeated identical transitions', async () => {
      const g = await seed();
      const first = await publish(g.id);
      const again = await publish(g.id);
      expect(again.ok).toBe(true);
      expect(again.kb_article_id).toBe(first.kb_article_id);
      const rejected = await seed();
      expect((await reject(rejected.id)).ok).toBe(true);
      expect((await reject(rejected.id)).ok).toBe(true);
    });

    it('still refuses cross-workspace mutations without leaking existence', async () => {
      const g = await seed();
      const out = await publish(g.id, OTHER_WS);
      expect(out.error).toBe('not_found');
      expect(await statusOf(g.id)).toBe('pending');
    });
  });

  // ── Slug seed contract ───────────────────────────────────────
  describe('slug allocation', () => {
    it('uses the server-provided seed when the draft has no stored slug', async () => {
      const g = await seed({ slug: null });
      const out = await accept(g.id, WS, '<p>x</p>', 'how-to-reset-a-password');
      expect(out.slug).toBe('how-to-reset-a-password');
    });

    it('prefers the stored slug over the seed', async () => {
      const g = await seed({ slug: 'stored-slug' });
      const out = await accept(g.id, WS, '<p>x</p>', 'ignored-seed');
      expect(out.slug).toBe('stored-slug');
    });

    it('falls back to a deterministic id slug with neither slug nor seed', async () => {
      const g = await seed({ slug: '' });
      const out = await accept(g.id);
      expect(out.slug).toBe(`article-${g.id.slice(0, 8)}`);
    });

    it('de-duplicates against an existing article', async () => {
      await db.query(
        `INSERT INTO public.knowledge_base_articles (workspace_id, slug, locale, title)
         VALUES ($1,'dup','en','existing')`, [WS]);
      const g = await seed({ slug: 'dup' });
      expect((await accept(g.id)).slug).toBe('dup-2');
    });
  });

  // ── Concurrency ──────────────────────────────────────────────
  describe('concurrent mutations', () => {
    it('publish vs reject: exactly one wins and the row stays consistent', async () => {
      const g = await seed();
      const [a, b] = await Promise.all([newClient(), newClient()]);
      try {
        const [p, r] = await Promise.all([
          call('publish_ai_kb_generated_article', [g.id, WS, REVIEWER, '<p>x</p>', null], a),
          call('reject_ai_kb_generated_article', [g.id, WS, REVIEWER], b),
        ]);
        const winners = [p, r].filter((x) => x.ok === true);
        const losers = [p, r].filter((x) => x.ok !== true);
        expect(winners).toHaveLength(1);
        expect(losers[0].error).toBe('invalid_state');

        const row = (await db.query(
          'SELECT status, kb_article_id FROM public.ai_kb_generated_articles WHERE id=$1', [g.id],
        )).rows[0];
        // The invariant: published ⇒ linked article, rejected ⇒ no article.
        if (row.status === 'published') expect(row.kb_article_id).not.toBeNull();
        else {
          expect(row.status).toBe('rejected');
          expect(row.kb_article_id).toBeNull();
        }
      } finally {
        await a.end(); await b.end();
      }
    });

    it('accept vs publish: never produces two articles for one draft', async () => {
      const g = await seed();
      const [a, b] = await Promise.all([newClient(), newClient()]);
      try {
        const [x, y] = await Promise.all([
          call('accept_ai_kb_generated_article', [g.id, WS, REVIEWER, '<p>a</p>', null], a),
          call('publish_ai_kb_generated_article', [g.id, WS, REVIEWER, '<p>b</p>', null], b),
        ]);
        // Both calls may converge on the same article, or one may serialise
        // behind the other and correctly report the terminal state. Runtime
        // behaviour is unchanged; only the outcome set is stated honestly.
        const winners = [x, y].filter((r) => r.ok === true);
        expect(winners.length).toBeGreaterThanOrEqual(1);
        for (const w of winners) expect(w.kb_article_id).toBeTruthy();
        if (winners.length === 2) {
          expect(x.kb_article_id).toBe(y.kb_article_id);
        } else {
          const loser = [x, y].find((r) => r.ok !== true);
          expect(loser.error).toBe('invalid_state');
          expect(loser.current_status).toBe('published');
        }
      } finally {
        await a.end(); await b.end();
      }
      const n = (await db.query(
        'SELECT count(*)::int AS n FROM public.knowledge_base_articles WHERE slug=$1', [g.slug],
      )).rows[0].n;
      expect(n).toBe(1);
    });

    it('two concurrent applies of DIFFERENT drafts never collide on one slug', async () => {
      const g1 = await seed({ slug: 'shared-title' });
      const g2 = await seed({ slug: 'shared-title' });
      const [a, b] = await Promise.all([newClient(), newClient()]);
      try {
        const [x, y] = await Promise.all([
          call('accept_ai_kb_generated_article', [g1.id, WS, REVIEWER, '<p>a</p>', null], a),
          call('accept_ai_kb_generated_article', [g2.id, WS, REVIEWER, '<p>b</p>', null], b),
        ]);
        if (!x.ok || !y.ok) console.log("DBG", JSON.stringify([x,y]));
        expect(x.ok).toBe(true);
        expect(y.ok).toBe(true);
        // Distinct drafts ⇒ distinct articles ⇒ distinct slugs.
        expect(x.kb_article_id).not.toBe(y.kb_article_id);
        expect(new Set([x.slug, y.slug]).size).toBe(2);
      } finally {
        await a.end(); await b.end();
      }
    });
  });

  // ── Privilege lockdown ───────────────────────────────────────
  describe('RPC privilege lockdown', () => {
    const SECDEF = [
      'enqueue_entitlement_fanout',
      'claim_entitlement_fanout_jobs',
      'advance_entitlement_fanout',
      'complete_entitlement_fanout',
      'fail_entitlement_fanout',
      '_ai_kb_apply_generated',
      'accept_ai_kb_generated_article',
      'publish_ai_kb_generated_article',
      'reject_ai_kb_generated_article',
    ];

    it('every SECURITY DEFINER RPC has PUBLIC execute revoked', async () => {
      const rows = (await db.query(
        `SELECT proname, prosecdef, proacl::text AS acl
         FROM pg_proc
         WHERE pronamespace='public'::regnamespace AND proname = ANY($1)`, [SECDEF],
      )).rows;
      expect(rows.length).toBe(SECDEF.length);
      for (const r of rows) {
        expect(r.prosecdef, r.proname).toBe(true);
        // A NULL ACL means "default", i.e. EXECUTE granted to PUBLIC.
        expect(r.acl, `${r.proname} has a default (PUBLIC-executable) ACL`).not.toBeNull();
        expect(r.acl, `${r.proname} grants PUBLIC`).not.toMatch(/(^|,)=X/);
      }
    });

    it('a non-superuser role cannot execute the mutation RPCs', async () => {
      await db.query(`
        DO $$ BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='kb_probe') THEN
            CREATE ROLE kb_probe LOGIN;
          END IF;
        END $$;
      `);
      await db.query('GRANT USAGE ON SCHEMA public TO kb_probe');
      // Re-assert least privilege after the role now exists.
      await db.query(readFileSync(resolve(process.cwd(), MIGRATIONS[1]), 'utf8'));

      const g = await seed();
      // SET LOCAL ROLE only takes effect inside a transaction; outside one it
      // is a silent no-op that would make this assertion pass vacuously.
      await db.query('BEGIN');
      await db.query('SET LOCAL ROLE kb_probe');
      await expect(db.query(
        'SELECT public.publish_ai_kb_generated_article($1,$2,$3,$4,$5)',
        [g.id, WS, REVIEWER, '<p>x</p>', null],
      )).rejects.toThrow(/permission denied/i);
      await db.query('ROLLBACK');

      // The very same call succeeds as the owning role: the refusal above is
      // the ACL, not a broken statement.
      expect((await publish(g.id)).ok).toBe(true);
    });

    it('the fan-out queue table is not readable by anon/authenticated', async () => {
      const acl = (await db.query(
        `SELECT relacl::text AS acl, relrowsecurity
         FROM pg_class WHERE oid='public.entitlement_fanout_jobs'::regclass`,
      )).rows[0];
      expect(acl.relrowsecurity).toBe(true);
      expect(acl.acl ?? '').not.toMatch(/\banon=/);
      expect(acl.acl ?? '').not.toMatch(/\bauthenticated=/);
    });
  });
});
