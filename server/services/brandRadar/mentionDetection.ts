/**
 * BRAND RADAR — name-mention detection over free-text AI responses.
 * Pure, dependency-free string matching: word-boundary regex for
 * alphanumeric names (avoids "Loop" matching inside "Cloopik"), falling back
 * to plain substring matching for names containing punctuation/symbols a
 * regex word boundary wouldn't handle cleanly.
 */

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** First character index of `name` in `text` (word-boundary aware), or -1. */
function firstIndexOf(text: string, name: string): number {
  const trimmed = name.trim();
  if (!trimmed) return -1;
  if (/^[a-z0-9\s-]+$/i.test(trimmed)) {
    const re = new RegExp(`\\b${escapeRegExp(trimmed)}\\b`, 'i');
    const match = re.exec(text);
    return match ? match.index : -1;
  }
  return text.toLowerCase().indexOf(trimmed.toLowerCase());
}

export function textMentionsName(text: string, name: string): boolean {
  return firstIndexOf(text, name) !== -1;
}

/**
 * Ordinal position (1-based) at which `brandName` is first mentioned among
 * itself and `competitorNames`, ranked by first-occurrence index in `text`.
 * Returns null when the brand isn't mentioned at all.
 */
export function computeMentionPosition(text: string, brandName: string, competitorNames: string[]): number | null {
  const entries = [brandName, ...competitorNames]
    .map((name) => ({ name, index: firstIndexOf(text, name) }))
    .filter((e) => e.index !== -1)
    .sort((a, b) => a.index - b.index);
  const rank = entries.findIndex((e) => e.name === brandName);
  return rank === -1 ? null : rank + 1;
}

export function mentionedCompetitors(text: string, competitorNames: string[]): string[] {
  return competitorNames.filter((name) => textMentionsName(text, name));
}
