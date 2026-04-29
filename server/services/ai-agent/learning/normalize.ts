/**
 * AI Agent — question normalization for learning candidate dedupe.
 *
 * Lowercases, strips punctuation, collapses whitespace, removes a small set
 * of multilingual stopwords, and joins surviving tokens. Same input that
 * produces "What is the price of plan?" and "what's the plan price?" should
 * collapse to similar normalized forms.
 */

const STOPWORDS = new Set<string>([
  // en
  'the','a','an','is','are','was','were','be','been','of','to','for','in','on','at','and','or','do','does','did','can','could','i','you','we','my','your','our','please','thanks','thank','what','whats','how','when','where','why','which','this','that','these','those',
  // tr
  've','ile','bir','bu','şu','o','ben','sen','biz','siz','onlar','mı','mi','mu','mü','ne','nasıl','niçin','neden','nerede','ki',
  // fa
  'و','در','به','از','که','را','با','برای','این','آن','هست','بود','شد','می','چه','چی','چطور','چگونه','کجا','کی',
]);

export function normalizeQuestion(text: string): string {
  const t = (text || '').toLowerCase().normalize('NFKC');
  // Replace any non letter/digit (Unicode-aware) with space.
  const cleaned = t.replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
  if (!cleaned) return '';
  const tokens = cleaned.split(' ').filter((tok) => tok && !STOPWORDS.has(tok));
  // Sort to make order-independent, but keep duplicates collapsed.
  return Array.from(new Set(tokens)).sort().join(' ');
}