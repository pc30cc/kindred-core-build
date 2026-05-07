/**
 * Tiny robots.txt fetcher + path matcher. We follow the documented user-agent
 * scoping but keep things deliberately minimal; bypass via AI_KB_IGNORE_ROBOTS=1
 * (self-host operator override).
 */

const cache = new Map<string, { rules: { allow: string[]; disallow: string[] }; expires: number }>();

export async function getRobotsRules(rootUrl: string, userAgent: string): Promise<{ allow: string[]; disallow: string[] }> {
  if (process.env.AI_KB_IGNORE_ROBOTS === '1') return { allow: [], disallow: [] };
  const u = new URL(rootUrl);
  const key = `${u.origin}|${userAgent.toLowerCase()}`;
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.rules;

  const robotsUrl = `${u.origin}/robots.txt`;
  let body = '';
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5000);
    const r = await fetch(robotsUrl, { signal: ctrl.signal, headers: { 'user-agent': userAgent } });
    clearTimeout(t);
    if (r.ok) body = (await r.text()).slice(0, 100_000);
  } catch { /* tolerate missing robots.txt */ }

  const rules = parseRobots(body, userAgent);
  cache.set(key, { rules, expires: Date.now() + 30 * 60_000 });
  return rules;
}

function parseRobots(body: string, userAgent: string): { allow: string[]; disallow: string[] } {
  if (!body) return { allow: [], disallow: [] };
  const ua = userAgent.toLowerCase();
  const lines = body.split(/\r?\n/);
  const groups: { agents: string[]; allow: string[]; disallow: string[] }[] = [];
  let cur: { agents: string[]; allow: string[]; disallow: string[] } | null = null;
  for (const raw of lines) {
    const line = raw.replace(/#.*/, '').trim();
    if (!line) { cur = null; continue; }
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const k = line.slice(0, idx).trim().toLowerCase();
    const v = line.slice(idx + 1).trim();
    if (k === 'user-agent') {
      if (!cur) { cur = { agents: [], allow: [], disallow: [] }; groups.push(cur); }
      cur.agents.push(v.toLowerCase());
    } else if (cur && k === 'allow') {
      cur.allow.push(v);
    } else if (cur && k === 'disallow') {
      cur.disallow.push(v);
    } else { cur = null; }
  }
  // Pick the matching group (UA-specific wins, else *).
  const specific = groups.find((g) => g.agents.some((a) => a !== '*' && ua.includes(a)));
  const wildcard = groups.find((g) => g.agents.includes('*'));
  const pick = specific || wildcard;
  return pick ? { allow: pick.allow, disallow: pick.disallow } : { allow: [], disallow: [] };
}

export function isPathAllowedByRobots(path: string, rules: { allow: string[]; disallow: string[] }): boolean {
  // Longest match wins (allow > disallow on ties).
  let bestAllow = -1; let bestDisallow = -1;
  for (const a of rules.allow) if (a && path.startsWith(a) && a.length > bestAllow) bestAllow = a.length;
  for (const d of rules.disallow) if (d && path.startsWith(d) && d.length > bestDisallow) bestDisallow = d.length;
  if (bestDisallow < 0) return true;
  return bestAllow >= bestDisallow;
}