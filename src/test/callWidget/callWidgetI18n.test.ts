/**
 * The call widget's strings (runtime.js I18N, contract §6): the same keys in
 * Persian, English and Turkish, every key the designs name (new-hooks §5),
 * the same placeholders in every language, no emoji anywhere, and the Iran
 * region's brand written with its zero-width non-joiner («وب‌یار»).
 *
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';

const source = readFileSync(resolve(process.cwd(), 'public/call-widget/runtime.js'), 'utf8');
/** The I18N object, evaluated on its own (it is a plain literal). */
const I18N = vm.runInNewContext(`(${/var I18N = (\{[\s\S]*?\n {2}\});/.exec(source)![1]})`) as Record<'en' | 'fa' | 'tr', Record<string, string>>;
const LOCALES = ['en', 'fa', 'tr'] as const;

/** Every key new-hooks §5.1–5.5 names, plus the contract's (§6); not the board-12-only three. */
const DESIGN_KEYS = [
  'open_widget', 'close', 'launcher_pill', 'launcher_tab', 'queue_place_short', 'queue_next_short', 'restore_call', 'end_call',
  'video_minimized', 'minimize', 'widget_language',
  'channel_voice', 'voice_tile_sub', 'video_tile_sub', 'edit', 'permission_note',
  'you', 'eta_value_minutes', 'eta_value_under_min', 'recording_short', 'quality_good', 'transfer_hold', 'mic_denied_title',
  'mic_denied_body', 'mic_denied_how', 'microphone', 'retry', 'rtc_unsupported',
  'rating', 'error_callback_hint', 'step_of', 'asap_option', 'today', 'tomorrow', 'continue', 'change', 'at_time', 'time', 'copy_code',
  'mute', 'unmute', 'camera_off', 'camera_on', 'phone', 'video', 'schedule', 'urgent', 'recording_progress', 'connected_waiting',
  'ringing_operator', 'operator_joining', 'mute_sound', 'consent_required', 'contact_required_note', 'callback_intro', 'call_duration',
  'connecting', 'live_now', 'secure_line', 'queue_aware', 'fast_handoff', 'queue_position', 'eta', 'request_callback_title',
  'request_callback_instead', 'request_callback', 'callback', 'reach_out', 'back',
  'quality_excellent', 'quality_poor', 'quality_lost', 'summary_phone', 'summary_video', 'no_operator_now', 'copied',
];
const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe('call widget strings', () => {
  it('the three languages have the same keys', () => {
    const en = Object.keys(I18N.en).sort();
    expect(Object.keys(I18N.fa).sort()).toEqual(en);
    expect(Object.keys(I18N.tr).sort()).toEqual(en);
  });

  it('every key the designs name is there, in every language, never empty', () => {
    for (const loc of LOCALES) for (const key of DESIGN_KEYS) expect(I18N[loc][key], `${loc}.${key}`).toMatch(/\S/);
  });

  it('the board-12-only state labels are not added (the screens use action labels)', () => {
    for (const key of ['mic_on', 'muted', 'reconnecting_short']) expect(I18N.en[key]).toBeUndefined();
  });

  it('placeholders are the same in every language', () => {
    for (const key of Object.keys(I18N.en)) {
      expect(placeholders(I18N.fa[key]), `fa.${key}`).toEqual(placeholders(I18N.en[key]));
      expect(placeholders(I18N.tr[key]), `tr.${key}`).toEqual(placeholders(I18N.en[key]));
    }
  });

  it('no emoji or pictograph, and no leading bullets or markers', () => {
    for (const loc of LOCALES) {
      for (const [key, value] of Object.entries(I18N[loc])) {
        expect(value, `${loc}.${key}`).not.toMatch(/\p{Extended_Pictographic}/u);
        expect(value, `${loc}.${key}`).not.toMatch(/^[\s●*]/u);
      }
    }
    expect(I18N.fa.consent_required).not.toContain('(الزامی)');
    expect(I18N.en.consent_required).not.toContain('(required)');
  });

  it('the designs\' words (WebYar\'s Persian, Respok\'s English)', () => {
    expect(I18N.fa.unmute).toBe('صدا');
    expect(I18N.fa.mute_sound).toBe('بی‌صدا کردن زنگ');
    expect(I18N.fa.connected_waiting).toBe('متصل، در انتظار اپراتور');
    expect(I18N.fa.callback_intro).toBe('راه ارتباطی را وارد کنید؛ تیم ما سریع تماس می‌گیرد.');
    expect(I18N.en.ringing_operator).toBe('Ringing an operator');
    expect(I18N.en.connected_waiting).toBe('Connected, waiting');
    expect(I18N.fa.summary_video).toBe('تماس تصویری');
    expect(I18N.en.summary_video).toBe('Video');
    expect(I18N.fa.no_operator_now).toBe('فعلاً اپراتوری در دسترس نیست');
    expect(I18N.en.rtc_unsupported).toBe("Calls can't connect right now");
  });

  it('the Iran region\'s brand keeps its zero-width non-joiner', () => {
    expect(source).toContain("var LOCAL_POWERED_BY_BRAND = { en: 'Web Yar', fa: 'وب‌یار', tr: 'Web Yar' };");
    expect(I18N.fa.mute).toBe('بی‌صدا');
  });
});
