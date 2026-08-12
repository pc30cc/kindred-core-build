/**
 * Turkish ablative suffix ("'dan" / "'den" / "'tan" / "'ten") for city names,
 * so "{city} ziyaretçi" reads as grammatically correct Turkish ("İstanbul'dan
 * ziyaretçi") instead of a bare, ungrammatical concatenation.
 *
 * This is suffix attachment (agglutination), governed by two closed,
 * well-defined Turkish orthography rules — NOT a translation or a guess at
 * the city's name itself:
 *   1. Vowel harmony: the suffix vowel matches the backness of the word's
 *      LAST vowel (a/ı/o/u → back → 'dan; e/i/ö/ü → front → 'den).
 *   2. Consonant devoicing: if the word ends in a voiceless consonant
 *      (ç,f,h,k,p,s,ş,t), the suffix's leading 'd' devoices to 't'.
 * These are the same rules any Turkish speaker applies to an unfamiliar
 * proper noun, so they generalize correctly to city names outside our
 * curated table too.
 */

const BACK_VOWELS = new Set(['a', 'ı', 'o', 'u']);
const FRONT_VOWELS = new Set(['e', 'i', 'ö', 'ü']);
const VOICELESS_FINAL = new Set(['ç', 'f', 'h', 'k', 'p', 's', 'ş', 't']);

/** Fold ASCII look-alikes so a canonical (non-Turkish-spelled) name like "Istanbul" still resolves 'i' as a front vowel, matching the native "İstanbul". */
function foldForHarmony(ch: string): string {
  const lower = ch.toLocaleLowerCase('tr-TR');
  return lower;
}

function lastVowel(word: string): string | null {
  const chars = Array.from(word);
  for (let i = chars.length - 1; i >= 0; i--) {
    const ch = foldForHarmony(chars[i]);
    if (BACK_VOWELS.has(ch) || FRONT_VOWELS.has(ch)) return ch;
  }
  return null;
}

/** "İstanbul" → "İstanbul'dan", "İzmir" → "İzmir'den", "İzmit" → "İzmit'ten". */
export function turkishAblativeForm(city: string): string {
  const trimmed = city.trim();
  if (!trimmed) return trimmed;
  const chars = Array.from(trimmed);
  const lastChar = foldForHarmony(chars[chars.length - 1]);
  const vowel = lastVowel(trimmed);
  const back = vowel ? BACK_VOWELS.has(vowel) : true; // default to back (dan) when no vowel found
  const voiceless = VOICELESS_FINAL.has(lastChar);
  const consonant = voiceless ? 't' : 'd';
  const suffixVowel = back ? 'a' : 'e';
  return `${trimmed}'${consonant}${suffixVowel}n`;
}
