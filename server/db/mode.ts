/**
 * Which external services this process may use for its data — decided once,
 * from the environment, and never revised at runtime.
 *
 *   postgres-only            DATABASE_URL, and nothing from Supabase: no REST,
 *                            no Realtime, no Auth, no Storage, no Edge
 *                            Functions. SUPABASE_URL / SUPABASE_*_KEY are
 *                            ignored even when still set (reported once at
 *                            boot), so a leftover variable cannot quietly bring
 *                            a Supabase service back. The default whenever
 *                            DATABASE_URL is set.
 *   postgres+supabase-services
 *                            DATABASE_URL for all data, plus the optional
 *                            Supabase services (the Supabase Realtime
 *                            transport, legacy auth.users cleanup). Opt-in.
 *   supabase-rest            The legacy driver: Supabase's REST API with
 *                            SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY. The
 *                            default when DATABASE_URL is unset, so an install
 *                            that has not moved yet keeps running unchanged.
 *
 * DATABASE_MODE names one of them explicitly; a combination that contradicts
 * the other variables is refused at boot rather than guessed at. There is no
 * fallback between modes: when the direct connection fails, the process waits
 * for it and then exits — it never switches to Supabase's REST API.
 */
export type DatabaseMode = 'postgres-only' | 'postgres+supabase-services' | 'supabase-rest';

const MODES: readonly DatabaseMode[] = ['postgres-only', 'postgres+supabase-services', 'supabase-rest'];

/** The legacy variables postgres-only ignores. */
export const LEGACY_SUPABASE_VARS = ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY'] as const;

const set = (v: string | undefined) => !!v && v.trim() !== '';

export function databaseMode(env: NodeJS.ProcessEnv = process.env): DatabaseMode {
  const raw = env.DATABASE_MODE?.trim();
  const hasUrl = set(env.DATABASE_URL);
  if (!raw) return hasUrl ? 'postgres-only' : 'supabase-rest';
  if (!MODES.includes(raw as DatabaseMode)) {
    throw new Error(`DATABASE_MODE must be one of ${MODES.join(', ')} (got "${raw}")`);
  }
  const mode = raw as DatabaseMode;
  if (mode !== 'supabase-rest' && !hasUrl) {
    throw new Error(`DATABASE_MODE=${mode} requires DATABASE_URL`);
  }
  if (mode === 'supabase-rest' && hasUrl) {
    throw new Error('DATABASE_MODE=supabase-rest does not use DATABASE_URL — unset one of them');
  }
  if (mode === 'postgres+supabase-services' && !(set(env.SUPABASE_URL) && set(env.SUPABASE_SERVICE_ROLE_KEY))) {
    throw new Error('DATABASE_MODE=postgres+supabase-services requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY');
  }
  return mode;
}

/** Legacy Supabase variables that are set but have no effect in this mode. */
export function ignoredSupabaseVars(env: NodeJS.ProcessEnv = process.env): string[] {
  if (databaseMode(env) !== 'postgres-only') return [];
  return LEGACY_SUPABASE_VARS.filter((name) => set(env[name]));
}
