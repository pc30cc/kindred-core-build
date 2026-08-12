/**
 * src/lib/geo/turkishGrammar.ts — Turkish ablative suffix ("'dan"/"'den"/
 * "'tan"/"'ten") attachment for city names. Vowel harmony + consonant
 * devoicing, not a translation or a guess.
 */
import { describe, it, expect } from 'vitest';
import { turkishAblativeForm } from '../../lib/geo/turkishGrammar';

describe('turkishAblativeForm', () => {
  it('back-vowel words take \'dan', () => {
    expect(turkishAblativeForm('İstanbul')).toBe("İstanbul'dan");
    expect(turkishAblativeForm('Ankara')).toBe("Ankara'dan");
    expect(turkishAblativeForm('Konya')).toBe("Konya'dan");
    expect(turkishAblativeForm('Bursa')).toBe("Bursa'dan");
  });

  it('front-vowel words take \'den', () => {
    expect(turkishAblativeForm('İzmir')).toBe("İzmir'den");
    expect(turkishAblativeForm('Kayseri')).toBe("Kayseri'den");
  });

  it('a voiceless final consonant devoices \'dan/\'den to \'tan/\'ten', () => {
    expect(turkishAblativeForm('İzmit')).toBe("İzmit'ten");
  });

  it('handles the ASCII (non-Turkish-spelled) canonical form the same as the native spelling', () => {
    expect(turkishAblativeForm('Istanbul')).toBe("Istanbul'dan");
  });

  it('is idempotent-safe on empty input', () => {
    expect(turkishAblativeForm('')).toBe('');
    expect(turkishAblativeForm('   ')).toBe('');
  });
});
