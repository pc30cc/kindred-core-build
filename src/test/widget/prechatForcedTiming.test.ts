/**
 * A field the Super Admin forces on (S-02, DECISIONS #6: force_on = asked
 * and required) is asked whatever timing the workspace chose: "never" used
 * to switch the whole form off on a plan with the form, while a plan
 * without it already got the forced field at the historical moment.
 * shared/prechatPolicy.ts effectivePrechat, pure.
 */
import { describe, expect, it } from 'vitest';
import { effectivePrechat } from '../../../shared/prechatPolicy';

const never = { ask_name: false, ask_email: false, ask_phone: false, prechat_timing: 'never' };

describe('force_on and the workspace\'s timing "never"', () => {
  it('a forced field is still asked, at the historical moment, and required', () => {
    expect(effectivePrechat(never, { name: 'default_on', email: 'force_on', phone: 'default_off' })).toMatchObject({
      ask_email: true, require_email: true, ask_name: false, timing: 'after_handoff',
    });
  });

  it('nothing forced: "never" stays never; another timing is kept as chosen', () => {
    expect(effectivePrechat(never, null).timing).toBe('never');
    expect(effectivePrechat({ ...never, prechat_timing: 'always' }, { name: 'force_on' }).timing).toBe('always');
    // A forced-off field forces nothing on.
    expect(effectivePrechat(never, { name: 'force_off', email: 'force_off', phone: 'force_off' }).timing).toBe('never');
  });
});
