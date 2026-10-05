/** The slice of a node-postgres Pool / Client the engine uses. */
export interface Queryable {
  query<R = Record<string, unknown>>(text: string, values?: unknown[]): Promise<{ rows: R[]; rowCount: number | null }>;
}

/** One PostgREST request, as supabase-js put it on the wire. */
export interface EngineRequest {
  method: string;
  /** Path below the REST root: `/conversations` or `/rpc/claim_job`. */
  path: string;
  query: URLSearchParams;
  headers: Headers;
  /** The raw JSON text supabase-js sent (JSON.stringify of the payload). */
  body: string | null;
}

export interface EngineResponse {
  status: number;
  headers: Record<string, string>;
  /** JSON text, or '' for no body. */
  body: string;
}
