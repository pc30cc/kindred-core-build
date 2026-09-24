/**
 * The assistant may only hand out links it was actually given.
 *
 * A product URL for a Persian-named product is percent-encoded — that is the
 * only form that survives HTTP — and a model asked to repeat one does not
 * copy it, it RETYPES it. On the live store:
 *
 *   given  …/product/%d9%be%d8%a7%d9%88%d8%b1%d8%a8%d8%a7%d9%86%da%a9-%db%b2%db%b0%db%b0%db%b0%db%b0-%d9%85%db%8c%d9%84%db%8c%d8%a2%d9%85%d9%be%d8%b1-…/
 *   sent   …/product/پاوربانک-%d۲%DB%B0%DB%B0%DB%B0%DB%B0-میليياٟمپر-ولتمکس/
 *
 * Half of it was decoded by hand, `%db%b2` became `%d` followed by a Persian
 * ۲, and «میلی‌آمپر» came back as «میليياٟمپر» — different letters plus a
 * stray U+065F. The link 404s, and it looks authoritative while doing so.
 *
 * No amount of prompting fixes this reliably, so the text is repaired instead:
 * a store link in the answer is either byte-identical to one the tools
 * supplied this turn, or it is replaced by the one it was clearly meant to be,
 * or it is removed. Only hosts the tools themselves named are touched — a URL
 * from the knowledge base or from the operator's own text is left alone.
 */

import type { ServerConfig } from '../../../config.js';
import { getServiceClient } from '../../../supabase.js';
import { getActiveConnectionForWorkspace, resolveConversationConnection, type CommerceConnectionRow } from '../../commerce/gateway.js';
import { isDirectProvider } from '../../commerce/providers.js';

const URL_PATTERN = /https?:\/\/[^\s<>"'`)\]]+/gi;
const TRAILING_PUNCTUATION = /[.,;:!?؟،؛"'»]+$/;
/**
 * How much of a catalogue is loaded to check an answer's links. Only reached
 * when an answer carries a store link that is not already canonical.
 */
const CATALOGUE_WINDOW = 500;

/** `https://shop.example` and `https://shop.example/` — the shop itself. */
function isStoreFrontPage(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (parsed.pathname === '' || parsed.pathname === '/') && !parsed.search;
  } catch {
    return false;
  }
}

function withoutTrailingPunctuation(url: string): string {
  const trailing = url.match(TRAILING_PUNCTUATION)?.[0] ?? '';
  return trailing ? url.slice(0, -trailing.length) : url;
}

/**
 * Percent-decoding that survives a broken escape.
 *
 * `decodeURIComponent` is all-or-nothing: one malformed sequence and it
 * throws, leaving the whole path as hex. That is exactly the input here — the
 * model's `%d۲` is a `%d` followed by a Persian ۲, which is not an escape at
 * all — so a mangled URL fingerprinted as hex soup, matched nothing, and was
 * dropped instead of repaired. Each maximal run of VALID escapes is decoded
 * on its own; a broken one stays the literal characters it is.
 */
function decodeLoose(value: string): string {
  return value.replace(/(?:%[0-9a-fA-F]{2})+/g, (sequence) => {
    try { return decodeURIComponent(sequence); } catch { return sequence; }
  });
}

/**
 * The discriminating part of a URL, percent-decoded and stripped to letters
 * and digits, with the spellings a model mixes up folded together.
 *
 * Deliberately the PATH only. The host is already known to match before any
 * of this runs, and every product on one shop also shares its `/product/`
 * prefix — scoring those shared characters made two unrelated products look
 * 60% alike, so an invented URL matched a real product instead of being
 * dropped.
 */
function fingerprint(raw: string): string {
  let path = raw;
  try {
    const parsed = new URL(raw);
    path = parsed.pathname + parsed.search;
  } catch { /* not parseable — fall back to the whole string */ }
  return decodeLoose(path)
    .toLowerCase()
    .normalize('NFKC')
    // Arabic ی/ک and the Persian ones are the same letter to a reader, and a
    // model mixes them freely; combining marks are noise it invents.
    .replace(/[يى]/g, 'ی')
    .replace(/ك/g, 'ک')
    // آ / أ / إ all get typed as a plain ا.
    .replace(/[آأإ]/g, 'ا')
    .replace(/[ً-ٰٟ‌‏‎]/g, '')
    // Persian and Arabic-Indic digits → ASCII, so ۲ and 2 compare equal.
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[^\p{L}\p{N}]/gu, '');
}

/** Longest common subsequence length — tolerant of the letters a model drops or invents. */
function similarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  // Bounded so a pathological pair cannot cost more than a fixed amount of
  // work; real paths are far shorter than this.
  const x = a.slice(0, 200);
  const y = b.slice(0, 200);
  let previous = new Array<number>(y.length + 1).fill(0);
  for (let i = 1; i <= x.length; i += 1) {
    const current = new Array<number>(y.length + 1).fill(0);
    for (let j = 1; j <= y.length; j += 1) {
      current[j] = x[i - 1] === y[j - 1] ? previous[j - 1] + 1 : Math.max(previous[j], current[j - 1]);
    }
    previous = current;
  }
  return previous[y.length] / Math.max(x.length, y.length);
}

function hostOf(url: string): string | null {
  try { return new URL(url).host.toLowerCase(); } catch { return null; }
}

/**
 * A retyped link has to be recognisably the same product, not merely a link
 * to the same shop — below this the answer loses the link rather than
 * pointing the visitor at the wrong page.
 */
const MIN_SIMILARITY = 0.6;

export function repairCommerceLinks(text: string, allowedUrls: readonly string[]): string {
  const source = String(text ?? '');
  if (!source || !allowedUrls.length) return source;

  const allowed = [...new Set(allowedUrls.filter(Boolean))];
  const allowedSet = new Set(allowed);
  const allowedHosts = new Set(allowed.map(hostOf).filter((h): h is string => !!h));
  const candidates = allowed.map((url) => ({ url, print: fingerprint(url) }));

  return source.replace(URL_PATTERN, (match) => {
    // Sentence punctuation is not part of the address.
    const trailing = match.match(TRAILING_PUNCTUATION)?.[0] ?? '';
    const url = trailing ? match.slice(0, -trailing.length) : match;

    if (allowedSet.has(url)) return match;
    const host = hostOf(url);
    // Not a store host: someone else's link, and none of this code's business.
    if (!host || !allowedHosts.has(host)) return match;

    const print = fingerprint(url);
    let best: { url: string; score: number } | null = null;
    for (const candidate of candidates) {
      const score = similarity(print, candidate.print);
      if (!best || score > best.score) best = { url: candidate.url, score };
    }
    if (best && best.score >= MIN_SIMILARITY) return best.url + trailing;
    // Nothing it plausibly meant. A link that 404s is worse than no link, and
    // the sentence around it still answers the question.
    return trailing;
  });
}

/**
 * Every store link in an answer is a real product page, or it is not there.
 *
 * `repairCommerceLinks` can only check the links the tools produced THIS
 * turn, and that is not enough: «لینکشو بده» carries no commerce intent at
 * all, so no tool ran, nothing was in the allowed set — and the model,
 * asked for a link to a product it had described a turn earlier, answered
 * with `https://p.webyar.ai/product/nova-12`. An invented English slug for
 * a Persian-named product. It answers 404.
 *
 * So the catalogue itself is the authority, not the turn. Any URL on the
 * store's own host has to BE a product in the index, and what the visitor
 * gets is always the canonical permalink — including when the model was
 * handed the `?p=<id>` form, which is resolved back here.
 *
 * Costs nothing on the common path: an answer with no link returns before
 * any query, and an answer whose links are already canonical is settled by
 * one indexed lookup.
 */
export async function verifyStoreLinks(
  config: ServerConfig,
  workspaceId: string,
  text: string,
  opts: { conversationId?: string | null; pageUrl?: string | null; allowedUrls?: readonly string[] } = {},
): Promise<string> {
  const source = String(text ?? '');
  if (!source || source.indexOf('http') === -1) return source;

  const connection = opts.conversationId || opts.pageUrl
    ? await resolveConversationConnection(config, workspaceId, { conversationId: opts.conversationId ?? null, pageUrl: opts.pageUrl ?? null }).catch(() => null)
    : await getActiveConnectionForWorkspace(config, workspaceId).catch(() => null);
  if (!connection) return source;
  const storeHost = hostOf(String(connection.store_id || ''));
  if (!storeHost) return source;

  if (isDirectProvider(connection.provider_type)) {
    return verifyDirectStoreLinks(config, workspaceId, source, connection, storeHost, opts);
  }

  const found = source.match(URL_PATTERN) ?? [];
  // The shop's own front page is always a real page — it needs no product to
  // vouch for it, and it has no path to match one with. Without this it was
  // dropped like an invented link, and «لینک صفحه فروشگاه همینه:» reached a
  // visitor with nothing after the colon.
  const onStore = [...new Set(
    found
      .map(withoutTrailingPunctuation)
      .filter((u) => hostOf(u) === storeHost && !isStoreFrontPage(u)),
  )];
  if (!onStore.length) return source;

  const sb = getServiceClient(config);
  // Fast path: the links are already the canonical ones the index holds.
  const { data: exact } = await sb
    .from('commerce_products')
    .select('canonical_url')
    .eq('connection_id', connection.id)
    .in('canonical_url', onStore);
  const verified = new Set((exact ?? []).map((r: { canonical_url: string }) => r.canonical_url));
  if (onStore.every((u) => verified.has(u))) return source;

  // Something needs resolving or repairing, so the catalogue comes out. The
  // row window is bounded: a shop with more products than this still gets
  // its links checked, just against the most recently updated slice.
  const { data: rows } = await sb
    .from('commerce_products')
    .select('external_id, canonical_url')
    .eq('connection_id', connection.id)
    .not('canonical_url', 'is', null)
    .order('updated_at', { ascending: false })
    .limit(CATALOGUE_WINDOW);

  const catalogue = (rows ?? []) as Array<{ external_id: string; canonical_url: string }>;
  if (!catalogue.length) return source;

  // `?p=<id>` is the form the model was given to copy; map it straight back
  // to the permalink rather than making the matcher guess at it.
  const byExternalId = new Map(catalogue.map((r) => [String(r.external_id), r.canonical_url]));
  const store = String(connection.store_id || '').replace(/\/+$/, '');
  const resolved = source.replace(URL_PATTERN, (match) => {
    const trailing = match.match(TRAILING_PUNCTUATION)?.[0] ?? '';
    const url = trailing ? match.slice(0, -trailing.length) : match;
    if (hostOf(url) !== storeHost) return match;
    let id: string | null = null;
    try { id = new URL(url).searchParams.get('p'); } catch { /* not parseable */ }
    const canonical = id ? byExternalId.get(id) : undefined;
    return canonical ? canonical + trailing : match;
  });

  // Both spellings of the front page are named, so neither is mistaken for a
  // product link that failed to match.
  return repairCommerceLinks(resolved, [...byExternalId.values(), store, `${store}/`]);
}

/**
 * Direct connectors keep no catalogue to check a link against, so the
 * authority is what the store itself handed out: this turn's tool results
 * plus the store links already given earlier in the conversation (kept in
 * conversation metadata by the direct stage). Anything else on the store's
 * host — an invented slug, a retyped Persian URL — is repaired to the link
 * it was meant to be, or removed. One indexed read, and only when the answer
 * actually contains a store link.
 */
async function verifyDirectStoreLinks(
  config: ServerConfig,
  workspaceId: string,
  source: string,
  connection: CommerceConnectionRow,
  storeHost: string,
  opts: { conversationId?: string | null; allowedUrls?: readonly string[] },
): Promise<string> {
  const onStore = (source.match(URL_PATTERN) ?? []).map(withoutTrailingPunctuation).filter((u) => hostOf(u) === storeHost && !isStoreFrontPage(u));
  if (!onStore.length) return source;
  const allowed = new Set<string>(opts.allowedUrls ?? []);
  if (onStore.some((u) => !allowed.has(u)) && opts.conversationId) {
    const sb = getServiceClient(config);
    const { data } = await sb.from('conversations').select('metadata').eq('id', opts.conversationId).eq('workspace_id', workspaceId).maybeSingle();
    const refs = (data as any)?.metadata?.commerce_refs;
    if (refs?.connection_id === connection.id && Array.isArray(refs.urls)) for (const u of refs.urls) if (typeof u === 'string') allowed.add(u);
  }
  const store = String(connection.store_id || '').replace(/\/+$/, '');
  return repairCommerceLinks(source, [...allowed, store, `${store}/`]);
}

/** Every URL this turn's commerce tools put in front of the model. */
export function urlsFromToolResults(results: readonly { data?: unknown }[]): string[] {
  const out: string[] = [];
  for (const result of results) {
    const data = result?.data;
    if (!data || typeof data !== 'object') continue;
    for (const key of ['url', 'view_url'] as const) {
      const url = (data as Record<string, unknown>)[key];
      if (typeof url === 'string' && /^https?:\/\//i.test(url)) out.push(url);
    }
  }
  return out;
}
