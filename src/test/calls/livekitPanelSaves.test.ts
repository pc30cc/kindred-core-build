import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const PANEL = 'src/components/admin/calls/LiveKitSelfHostedProviderPanel.tsx';
const src = readFileSync(PANEL, 'utf8');

/**
 * The card has no Save button: every text field saves when it loses focus.
 *
 * That only works if the blur handler compares what was typed against what
 * the SERVER last confirmed. Comparing against `cfg` instead cannot ever
 * fire — `onChange` has already written the keystroke there, so the values
 * are equal by construction and the field silently never saves. All eight
 * fields on this card were written that way, and the symptom is the worst
 * kind: the input accepts text, shows no error, and loses it on reload.
 */
describe('the LiveKit card actually saves what is typed into it', () => {
  const blurGuards = src
    .split('\n')
    .map((l, i) => [i + 1, l.trim()] as const)
    .filter(([, l]) => /^if \(v !== \(/.test(l) || /^if \(v !== \(.*\)\) \{$/.test(l));

  it('has a guard on every field that saves on blur', () => {
    // Five top-level fields plus three inside the recording-storage block.
    expect(blurGuards.length).toBe(8);
  });

  it.each(blurGuards.map(([line, l]) => [line, l]))(
    'line %i compares against the persisted value, not the edit in progress',
    (_line, guard) => {
      expect(guard).toContain('saved?.');
      expect(guard).not.toContain('cfg.');
    },
  );

  /**
   * One snapshot, written on load and on every successful save. Four
   * separate `saved*` values existed before and covered only the fields
   * `runTest` cared about, which is why the rest went unnoticed.
   */
  it('keeps one snapshot of the persisted config, refreshed on load and save', () => {
    expect(src).toContain('const [saved, setSaved] = useState<LiveKitConfigPublicView | null>(null)');
    // Once in load(), once in save().
    expect(src.split('setSaved(r.livekit)').length - 1).toBe(2);
  });

  it('still sends turn_domain when the field is cleared', () => {
    expect(src).toContain("save({ turn_domain: v || null })");
  });
});
