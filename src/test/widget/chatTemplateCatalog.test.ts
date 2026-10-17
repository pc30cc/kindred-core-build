/**
 * The chat widget template catalog (shared/chatTemplateCatalog.ts): the
 * Super Admin's catalog per edition, what a workspace wears, the merged
 * template options, and the validation of a Super Admin save.
 *
 * The rule that matters most: with no catalog (no row, a database from
 * before migration 275) every workspace wears the edition's default, so a
 * deploy changes nothing for any visitor.
 */
import { describe, expect, it } from 'vitest';
import {
  CHAT_TEMPLATE_OPTIONS,
  canonicalChatTemplateId,
  chatTemplatePickerShown,
  cleanChatTemplateCatalogInput,
  cleanTemplateOptionsInput,
  cleanTemplateText,
  enabledChatTemplateIds,
  readTemplateOptions,
  resolveChatTemplateCatalog,
  resolveChatTemplateOptions,
  resolveWorkspaceChatTemplate,
} from '../../../shared/chatTemplateCatalog';
import { resolveEditionWidgetTemplateId } from '../../../server/services/widget/presentationAssets';
import { CHAT_WIDGET_TEMPLATES, EDITION_CHAT_WIDGET_TEMPLATES } from '../../../shared/widgetTemplates';

const iranOn = (extra: Record<string, unknown> = {}) => resolveChatTemplateCatalog('iran', {
  default: 'default',
  items: {
    t1: { enabled: true, order: 1, name: { fa: 'فیروزه' }, options: { navMode: 'both', navStyle: 'zz' } },
    t2: { enabled: true, order: 2 },
    ...extra,
  },
});

describe('resolveChatTemplateCatalog — no catalog is today', () => {
  it.each([null, undefined, {}, [], 'x', { items: [] }])('stored %j: only the edition default, worn by everyone', (stored) => {
    const c = resolveChatTemplateCatalog('iran', stored);
    expect(enabledChatTemplateIds(c)).toEqual(['default']);
    expect(c.defaultId).toBe('default');
    expect(chatTemplatePickerShown(c)).toBe(false);
    for (const requested of ['t1', 't2', 'default', 'web-yar', 'intl', null, '', 'nope']) {
      expect(resolveWorkspaceChatTemplate(c, requested)).toBe('default');
    }
  });

  it('every offered id has an entry, in offered order', () => {
    const c = resolveChatTemplateCatalog('iran', null);
    expect(c.entries.map((e) => e.id)).toEqual(EDITION_CHAT_WIDGET_TEMPLATES.iran.offered);
    expect(c.entries.map((e) => e.enabled)).toEqual([true, false, false]);
  });

  it('an unknown edition is Iran; the International edition wears intl and ignores Iranian ids', () => {
    expect(resolveWorkspaceChatTemplate(resolveChatTemplateCatalog(null, null), 'intl')).toBe('default');
    const intl = resolveChatTemplateCatalog('international', { default: 't1', items: { t1: { enabled: true }, intl: { enabled: false } } });
    expect(enabledChatTemplateIds(intl)).toEqual(['intl']);
    expect(intl.defaultId).toBe('intl');
    expect(resolveWorkspaceChatTemplate(intl, 't1')).toBe('intl');
  });

  it('the server resolver without a catalog keeps the edition default whatever is requested', () => {
    expect(resolveEditionWidgetTemplateId('iran', 't1')).toBe('default');
    expect(resolveEditionWidgetTemplateId('iran', 't2')).toBe('default');
    expect(resolveEditionWidgetTemplateId(null, 't1')).toBe('default');
    expect(resolveEditionWidgetTemplateId('international', 't1')).toBe('intl');
    expect(resolveEditionWidgetTemplateId('iran', 't1', iranOn())).toBe('t1');
  });
});

describe('resolveChatTemplateCatalog — the Super Admin catalog', () => {
  it('enabled templates in order; names cleaned; option values validated', () => {
    const c = iranOn();
    expect(enabledChatTemplateIds(c)).toEqual(['default', 't1', 't2']);
    expect(chatTemplatePickerShown(c)).toBe(true);
    const t1 = c.entries.find((e) => e.id === 't1')!;
    expect(t1.name).toEqual({ fa: 'فیروزه' });
    // An unknown value reads as the code default; topics default to none.
    expect(t1.options).toEqual({ navStyle: 'vb', navMode: 'both', topics: [] });
    expect(c.entries.find((e) => e.id === 't2')!.options).toEqual({ topics: [], askExamples: [] });
    expect(c.entries.find((e) => e.id === 'default')!.options).toEqual({});
  });

  it('order sorts, ties keep the offered order', () => {
    const c = resolveChatTemplateCatalog('iran', { items: { t2: { enabled: true, order: 0 }, default: { order: 5 }, t1: { enabled: true, order: 5 } } });
    expect(c.entries.map((e) => e.id)).toEqual(['t2', 'default', 't1']);
  });

  it('a disabled default is replaced; all disabled force-enables the edition default', () => {
    const moved = resolveChatTemplateCatalog('iran', { default: 't1', items: { default: { enabled: false }, t1: { enabled: true } } });
    expect(moved.defaultId).toBe('t1');
    expect(resolveWorkspaceChatTemplate(moved, null)).toBe('t1');
    expect(resolveWorkspaceChatTemplate(moved, 'default')).toBe('t1');
    const off = resolveChatTemplateCatalog('iran', { default: 't2', items: { default: { enabled: false }, t1: { enabled: false }, t2: { enabled: false } } });
    expect(enabledChatTemplateIds(off)).toEqual(['default']);
    expect(off.defaultId).toBe('default');
    const wrongDefault = resolveChatTemplateCatalog('iran', { default: 't2', items: { t1: { enabled: true } } });
    expect(wrongDefault.defaultId).toBe('default');
  });

  it('a stored default that is not enabled gives way to the edition default, forced on (never another template)', () => {
    // `default` switched off and the stored default disabled (a hand-edited
    // row, or a template no longer offered): the edition default comes back.
    for (const stored of [
      { default: 't2', items: { default: { enabled: false }, t1: { enabled: true }, t2: { enabled: false } } },
      { default: 'gone', items: { default: { enabled: false }, t1: { enabled: true } } },
      { items: { default: { enabled: false }, t1: { enabled: true } } },
    ]) {
      const c = resolveChatTemplateCatalog('iran', stored);
      expect(c.defaultId).toBe('default');
      expect(enabledChatTemplateIds(c)).toEqual(['default', 't1']);
      expect(resolveWorkspaceChatTemplate(c, null)).toBe('default');
      expect(resolveWorkspaceChatTemplate(c, 't1')).toBe('t1');
    }
    // An enabled stored default is kept even with the edition default off.
    const kept = resolveChatTemplateCatalog('iran', { default: 't1', items: { default: { enabled: false }, t1: { enabled: true } } });
    expect(kept.defaultId).toBe('t1');
    expect(enabledChatTemplateIds(kept)).toEqual(['t1']);
  });

  it('a long stored name is cut to 40 characters, bidi controls stripped', () => {
    const c = resolveChatTemplateCatalog('iran', { items: { default: { name: { en: `‮${'x'.repeat(60)}`, tr: '   ' } } } });
    expect(c.entries[0].name).toEqual({ en: 'x'.repeat(40) });
  });
});

describe('resolveWorkspaceChatTemplate', () => {
  it('honours an enabled choice (normalised, legacy-mapped), else the default', () => {
    const c = iranOn();
    expect(resolveWorkspaceChatTemplate(c, ' T1 ')).toBe('t1');
    expect(resolveWorkspaceChatTemplate(c, 'web-yar')).toBe('default');
    expect(resolveWorkspaceChatTemplate(c, null)).toBe('default');
    expect(resolveWorkspaceChatTemplate(c, 'intl')).toBe('default');
  });

  it('a plan without widget_appearance wears the default', () => {
    expect(resolveWorkspaceChatTemplate(iranOn(), 't1', false)).toBe('default');
  });

  it('a disabled choice falls back, and comes back once re-enabled', () => {
    expect(resolveWorkspaceChatTemplate(iranOn({ t1: { enabled: false } }), 't1')).toBe('default');
    expect(resolveWorkspaceChatTemplate(iranOn(), 't1')).toBe('t1');
  });

  it('canonicalChatTemplateId knows only the edition offer', () => {
    expect(canonicalChatTemplateId('iran', 'T2')).toBe('t2');
    expect(canonicalChatTemplateId('iran', 'web-yar')).toBe('default');
    expect(canonicalChatTemplateId('iran', 'intl')).toBeNull();
    expect(canonicalChatTemplateId('international', 't1')).toBeNull();
    expect(canonicalChatTemplateId('iran', 'x'.repeat(40))).toBeNull();
  });
});

describe('template options', () => {
  it('every template has an option list and every offered template a descriptor', () => {
    for (const id of Object.keys(CHAT_WIDGET_TEMPLATES)) expect(CHAT_TEMPLATE_OPTIONS).toHaveProperty(id);
  });

  it('merge: code defaults → Super Admin → workspace, only the keys the template reads', () => {
    const c = iranOn({
      t1: { enabled: true, options: { navStyle: 'vc', topics: [{ label: 'ارسال', icon: 'truck' }] } },
    });
    expect(resolveChatTemplateOptions(c, 't1', {})).toEqual({ navStyle: 'vc', navMode: 'active', topics: [{ label: 'ارسال', icon: 'truck' }] });
    expect(resolveChatTemplateOptions(c, 't1', { navMode: 'none', askExamples: ['x'], extra: 1 }))
      .toEqual({ navStyle: 'vc', navMode: 'none', topics: [{ label: 'ارسال', icon: 'truck' }] });
    // An explicit empty list is the workspace's own choice: no topics.
    expect(resolveChatTemplateOptions(c, 't1', { topics: [] }).topics).toEqual([]);
    // An invalid workspace value falls through to the Super Admin's.
    expect(resolveChatTemplateOptions(c, 't1', { navStyle: 'zz' }).navStyle).toBe('vc');
    expect(resolveChatTemplateOptions(c, 't2', { askExamples: ['سفارشم کی می‌رسد؟'], navMode: 'none' }))
      .toEqual({ topics: [], askExamples: ['سفارشم کی می‌رسد؟'] });
    expect(resolveChatTemplateOptions(c, 'default', { navMode: 'none' })).toEqual({});
  });

  it('strict input: unknown keys dropped, bad values refused with their key', () => {
    expect(cleanTemplateOptionsInput({ navStyle: 'va', other: 'x' })).toEqual({ ok: true, value: { navStyle: 'va' } });
    expect(cleanTemplateOptionsInput({ navMode: 'sideways' })).toMatchObject({ ok: false, key: 'navMode' });
    expect(cleanTemplateOptionsInput({ topics: Array.from({ length: 5 }, () => ({ label: 'a', icon: 'box' })) })).toMatchObject({ ok: false, key: 'topics' });
    expect(cleanTemplateOptionsInput({ topics: [{ label: 'a', icon: 'rocket' }] })).toMatchObject({ ok: false, key: 'topics' });
    expect(cleanTemplateOptionsInput({ topics: [{ label: 'x'.repeat(25), icon: 'box' }] })).toMatchObject({ ok: false, key: 'topics' });
    expect(cleanTemplateOptionsInput({ askExamples: ['a', 'b', 'c'] })).toMatchObject({ ok: false, key: 'askExamples' });
    expect(cleanTemplateOptionsInput({ askExamples: ['y'.repeat(61)] })).toMatchObject({ ok: false, key: 'askExamples' });
    expect(cleanTemplateOptionsInput([])).toMatchObject({ ok: false, key: null });
    expect(cleanTemplateOptionsInput(null)).toEqual({ ok: true, value: {} });
  });

  it('empty rows (still being typed) are dropped; text is cleaned', () => {
    expect(cleanTemplateOptionsInput({
      topics: [{ label: '  ', icon: 'box' }, { label: ' مرجوعی‮  کالا ', icon: 'return' }],
      askExamples: ['', '  سفارشم   کی می‌رسد؟ '],
    })).toEqual({
      ok: true,
      value: { topics: [{ label: 'مرجوعی کالا', icon: 'return' }], askExamples: ['سفارشم کی می‌رسد؟'] },
    });
  });

  it('lenient read keeps only valid keys', () => {
    expect(readTemplateOptions({ navStyle: 'vd', navMode: 'nope', topics: 'x', askExamples: ['ok'] }))
      .toEqual({ navStyle: 'vd', askExamples: ['ok'] });
    expect(readTemplateOptions('nope')).toEqual({});
  });

  it('cleanTemplateText keeps the zero-width non-joiner and drops controls', () => {
    expect(cleanTemplateText('قالب‌ها\u0000⁦x⁩')).toBe('قالب‌ها x');
    expect(cleanTemplateText(12)).toBe('');
  });
});

describe('cleanChatTemplateCatalogInput — a Super Admin save', () => {
  const base = { defaultId: 'default', templates: [{ id: 'default', enabled: true }, { id: 't1', enabled: true }] };

  it('builds the row; ids left out keep their stored item; other editions\' ids are dropped', () => {
    const previous = { default: 'default', items: { t2: { enabled: true, order: 7, name: { fa: 'نسیم' } }, intl: { enabled: true } } };
    const r = cleanChatTemplateCatalogInput('iran', {
      defaultId: 't1',
      templates: [
        { id: 'default', enabled: true, order: 0, name: { fa: '  آشنا ', en: null, tr: '' } },
        { id: 't1', enabled: true, order: 1, options: { navStyle: 'va', unknown: true } },
      ],
    }, previous);
    expect(r).toEqual({
      ok: true,
      value: {
        default: 't1',
        items: {
          default: { enabled: true, order: 0, name: { fa: 'آشنا' } },
          t1: { enabled: true, order: 1, options: { navStyle: 'va' } },
          t2: { enabled: true, order: 7, name: { fa: 'نسیم' } },
        },
      },
    });
  });

  it.each([
    [{ ...base, templates: [{ id: 'intl', enabled: true }] }, 'template_not_offered'],
    [{ ...base, templates: [{ id: 'web-yar', enabled: true }] }, 'template_not_offered'],
    [{ ...base, templates: [{ id: 't1', enabled: true }, { id: 'T1', enabled: false }] }, 'duplicate_template'],
    [{ ...base, templates: [{ id: 't1', enabled: true }, { id: 't1', enabled: false }] }, 'duplicate_template'],
    [{ defaultId: 'default', templates: [{ id: 'default', enabled: false }] }, 'no_template_enabled'],
    [{ defaultId: 't2', templates: base.templates }, 'default_not_enabled'],
    [{ defaultId: 'nope', templates: base.templates }, 'default_not_enabled'],
    [{ ...base, templates: [{ id: 't1', enabled: true, name: { fa: 'ن'.repeat(41) } }] }, 'name_too_long'],
    [{ ...base, templates: [{ id: 't1', enabled: true, options: { navMode: 'x' } }] }, 'invalid_template_options'],
    [{ ...base, templates: [{ id: 't1', enabled: true, order: 100 }] }, 'invalid_order'],
  ])('refuses %j with %s', (input, problem) => {
    const r = cleanChatTemplateCatalogInput('iran', input, null);
    expect(r).toMatchObject({ ok: false, problem });
  });

  it('a template never saved counts as disabled when deciding the default (only `default` is on)', () => {
    expect(cleanChatTemplateCatalogInput('iran', { defaultId: 't2', templates: [{ id: 't1', enabled: true }] }, null))
      .toMatchObject({ ok: false, problem: 'default_not_enabled' });
    expect(cleanChatTemplateCatalogInput('iran', { defaultId: 'default', templates: [{ id: 't1', enabled: true }] }, null))
      .toMatchObject({ ok: true });
  });

  it('the International edition accepts only intl', () => {
    expect(cleanChatTemplateCatalogInput('international', { defaultId: 'intl', templates: [{ id: 'intl', enabled: true }] }, null))
      .toEqual({ ok: true, value: { default: 'intl', items: { intl: { enabled: true } } } });
    expect(cleanChatTemplateCatalogInput('international', { defaultId: 'intl', templates: [{ id: 't1', enabled: true }] }, null))
      .toMatchObject({ ok: false, problem: 'template_not_offered' });
  });

  it('what is saved reads back as the same catalog', () => {
    const r = cleanChatTemplateCatalogInput('iran', {
      defaultId: 't2',
      templates: [
        { id: 'default', enabled: false, order: 2 },
        { id: 't1', enabled: true, order: 1, options: { navMode: 'icon' } },
        { id: 't2', enabled: true, order: 0, options: { askExamples: ['کی می‌رسد؟'] } },
      ],
    }, null);
    if (!r.ok) throw new Error('save refused');
    const c = resolveChatTemplateCatalog('iran', r.value);
    expect(c.defaultId).toBe('t2');
    expect(enabledChatTemplateIds(c)).toEqual(['t2', 't1']);
    expect(resolveChatTemplateOptions(c, 't2', {})).toEqual({ topics: [], askExamples: ['کی می‌رسد؟'] });
    expect(resolveWorkspaceChatTemplate(c, 'default')).toBe('t2');
  });
});
