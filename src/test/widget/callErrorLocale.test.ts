/**
 * A call that fails in the chat widget's call surface says so in the
 * visitor's language (Core runtime.js callErrorMessage).
 *
 * A failure code with no sentence of its own (LiveKit's numeric codes, a
 * newer engine's code) printed the engine's English `message` ("could not
 * establish pc connection") in a Persian or Turkish widget; it now reads
 * the widget's own "something went wrong" sentence. The mapped codes keep
 * theirs. The function as shipped, with the closure's `t` handed in.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const src = readFileSync('public/widget/runtime.js', 'utf8');
const start = src.indexOf('function callErrorMessage(err) {');
const end = src.indexOf('\n    }\n', start) + 6;

const STRINGS: Record<string, string> = {
  csErrUnknown: 'مشکلی پیش آمد. لطفاً دوباره تلاش کنید.',
  csErrConnect: 'اتصال به تماس ممکن نشد. لطفاً دوباره تلاش کنید.',
};
const callErrorMessage = new Function('t', `${src.slice(start, end)}\nreturn callErrorMessage;`)(
  (key: string) => STRINGS[key] || '',
) as (err: { code?: unknown; message?: string } | null) => string;

describe('the call surface\'s failure line', () => {
  it('a code with no sentence of its own: the widget\'s, never the engine\'s English', () => {
    expect(start).toBeGreaterThan(0);
    expect(callErrorMessage({ code: 12, message: 'could not establish pc connection' })).toBe(STRINGS.csErrUnknown);
    expect(callErrorMessage({ code: 'something_new', message: 'Something new failed' })).toBe(STRINGS.csErrUnknown);
  });

  it('a mapped code keeps its sentence', () => {
    expect(callErrorMessage({ code: 'livekit_connect_failed', message: 'Call failed.' })).toBe(STRINGS.csErrConnect);
  });

  it('no error at all: the generic sentence', () => {
    expect(callErrorMessage(null)).toBe(STRINGS.csErrUnknown);
  });
});
