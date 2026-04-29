/**
 * AI Agent — deterministic multilingual topic detector (v1).
 *
 * Self-host. Pure JS, no LLM call by default. An optional LLM classifier
 * can be added later behind AI_AGENT_TOPIC_LLM=1 without changing the
 * public surface of detectTopics().
 *
 * Strategy:
 *  - Normalize message (lower, strip diacritics for fa/ar where safe).
 *  - Score each enabled topic via:
 *      keyword hits (token-boundary aware for latin, substring for fa/tr)
 *      example phrase contains
 *  - Confidence = clamp((kw_score * 0.65) + (example_score * 0.35), 0, 1)
 *  - Return topics whose confidence >= topic.confidence_threshold,
 *    sorted by confidence desc.
 */
import type { TopicRecord, DetectedTopic, DetectionResult } from './types.js';

function detectScript(text: string): 'fa' | 'tr' | 'en' | 'other' {
  if (/[\u0600-\u06FF]/.test(text)) return 'fa';
  if (/[çğıöşüÇĞİÖŞÜ]/.test(text)) return 'tr';
  if (/[a-zA-Z]/.test(text)) return 'en';
  return 'other';
}

function normalize(text: string): string {
  return (text || '')
    .toLowerCase()
    .replace(/\u200c/g, ' ') // Persian ZWNJ -> space
    .replace(/[\u064B-\u0652]/g, '') // Arabic diacritics
    .replace(/ي/g, 'ی')
    .replace(/ك/g, 'ک')
    .replace(/\s+/g, ' ')
    .trim();
}

function isLatinToken(s: string): boolean {
  return /^[a-z0-9'’\-]+$/i.test(s);
}

function keywordHit(textNorm: string, kwNorm: string): boolean {
  if (!kwNorm) return false;
  if (isLatinToken(kwNorm)) {
    // word-boundary match for short latin tokens
    const re = new RegExp(`(^|[^a-z0-9])${kwNorm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`, 'i');
    return re.test(textNorm);
  }
  // Persian/Turkish/multi-word: substring match (already normalized)
  return textNorm.includes(kwNorm);
}

export function detectTopics(message: string, topics: TopicRecord[]): DetectionResult {
  const language = detectScript(message);
  const textNorm = normalize(message);
  const out: DetectedTopic[] = [];

  for (const t of topics) {
    if (!t.enabled) continue;
    const matchedKeywords: string[] = [];
    const matchedExamples: string[] = [];

    let kwHits = 0;
    for (const kw of t.keywords || []) {
      const kn = normalize(kw);
      if (keywordHit(textNorm, kn)) {
        kwHits += 1;
        matchedKeywords.push(kw);
      }
    }

    let exHits = 0;
    for (const ex of t.examples || []) {
      const en = normalize(ex);
      if (en.length >= 3 && (textNorm.includes(en) || en.includes(textNorm))) {
        exHits += 1;
        matchedExamples.push(ex);
      }
    }

    if (kwHits === 0 && exHits === 0) continue;

    const kwScore = Math.min(1, kwHits / 2);     // 1 hit ≈ 0.5, 2+ ≈ 1
    const exScore = Math.min(1, exHits);         // any phrase hit is strong
    const confidence = Math.max(0, Math.min(1, kwScore * 0.65 + exScore * 0.35));

    if (confidence >= (t.confidence_threshold ?? 0.65) ||
        (kwHits === 0 && exHits >= 1) ||
        (kwHits >= 2)) {
      out.push({
        id: t.id,
        name: t.name,
        slug: t.slug,
        confidence: Math.round(confidence * 100) / 100,
        matchedKeywords,
        matchedExamples,
        action: t.action,
        actionJson: t.action_json || {},
      });
    }
  }

  out.sort((a, b) => b.confidence - a.confidence);

  const explanation = out.length === 0
    ? 'No topic matched the visitor message above its confidence threshold.'
    : `Matched ${out.length} topic(s) deterministically using keyword + example signals (no LLM).`;

  return { detectedTopics: out, language, explanation };
}