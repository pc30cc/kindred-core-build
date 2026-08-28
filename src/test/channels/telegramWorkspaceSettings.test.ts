/**
 * Workspace-level Telegram settings: parsing, entitlement gating, locale
 * fallback and slash-command recognition.
 *
 * Entitlement checks are mocked at the billing boundary only — everything
 * else is the real production code.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const moduleAccess = vi.fn(async () => ({ allowed: true }) as any);

vi.mock('../../../server/middleware/featureGating.js', async (importOriginal) => {
  const actual = await importOriginal<any>().catch(() => ({}));
  return { ...actual, checkModuleAccess: (...args: any[]) => moduleAccess(...(args as [])) };
});

// The Super Admin master switch lives on the plugin platform state; stub it
// so entitlement gating can be tested without a database.
const platformPolicy = vi.fn(async () => ({ policy: {} }) as any);
vi.mock('../../../server/services/plugins/state.js', async (importOriginal) => {
  const actual = await importOriginal<any>().catch(() => ({}));
  return { ...actual, getPlatformState: (...args: any[]) => platformPolicy(...(args as [])) };
});

const settings = await import('../../../server/services/channels/telegram/settings.js');
const {
  defaultTelegramSettings,
  parseTelegramSettings,
  resolveTelegramHandlingMode,
  sanitizeTelegramSettingsForSave,
  resolveLocalizedMessage,
  normalizeLocale,
  commandKeyFromText,
  buildTelegramCommandList,
  messageKeyForCommand,
} = settings;

const config: any = { supabaseUrl: 'https://x.supabase.co', supabaseServiceRoleKey: 'service' };

beforeEach(() => {
  moduleAccess.mockReset();
  moduleAccess.mockResolvedValue({ allowed: true } as any);
  platformPolicy.mockReset();
  platformPolicy.mockResolvedValue({ policy: {} } as any);
});

describe('settings parsing', () => {
  it('produces a complete, safe object from empty input', () => {
    const parsed = parseTelegramSettings(undefined);
    expect(parsed.handlingMode).toBe('human_only');
    for (const locale of settings.TELEGRAM_LOCALES) {
      for (const key of settings.TELEGRAM_MESSAGE_KEYS) {
        expect(parsed.locales[locale][key].trim()).not.toBe('');
      }
    }
    for (const key of settings.TELEGRAM_COMMAND_KEYS) {
      expect(parsed.commands[key].trim()).not.toBe('');
    }
  });

  it('keeps stored values and ignores unknown junk', () => {
    const parsed = parseTelegramSettings({
      handlingMode: 'ai_first',
      profile: { name: 'Support' },
      locales: { fa: { welcome: 'سلام' } },
      commands: { start: 'شروع' },
      somethingElse: { nested: true },
    });
    expect(parsed.handlingMode).toBe('ai_first');
    expect(parsed.profile.name).toBe('Support');
    expect(parsed.locales.fa.welcome).toBe('سلام');
    expect(parsed.commands.start).toBe('شروع');
    expect((parsed as any).somethingElse).toBeUndefined();
  });

  it('rejects an invalid handling mode', () => {
    expect(parseTelegramSettings({ handlingMode: 'skynet' }).handlingMode).toBe('human_only');
  });
});

describe('AI entitlement gating', () => {
  it('honors ai_first when the plan allows the AI assistant', async () => {
    const res = await resolveTelegramHandlingMode(config, 'ws1', 'ai_first');
    expect(res).toEqual({ mode: 'ai_first', aiAvailable: true });
  });

  it('downgrades ai_first to human_only when the Super Admin switch is off', async () => {
    platformPolicy.mockResolvedValue({ policy: { aiEnabled: false } } as any);
    const res = await resolveTelegramHandlingMode(config, 'ws1', 'ai_first');
    expect(res).toEqual({ mode: 'human_only', aiAvailable: false });
  });

  it('downgrades ai_first to human_only when the plan does not include AI', async () => {
    moduleAccess.mockResolvedValue({ allowed: false } as any);
    const res = await resolveTelegramHandlingMode(config, 'ws1', 'ai_first');
    expect(res).toEqual({ mode: 'human_only', aiAvailable: false });
  });

  it('fails closed when the entitlement lookup throws', async () => {
    moduleAccess.mockRejectedValue(new Error('billing down'));
    const res = await resolveTelegramHandlingMode(config, 'ws1', 'ai_first');
    expect(res.mode).toBe('human_only');
  });

  it('persists only the downgraded value', async () => {
    moduleAccess.mockResolvedValue({ allowed: false } as any);
    const saved = await sanitizeTelegramSettingsForSave(config, 'ws1', {
      ...defaultTelegramSettings(),
      handlingMode: 'ai_first',
    });
    expect(saved.handlingMode).toBe('human_only');
  });
});

describe('locale fallback chain', () => {
  it('prefers the visitor locale, then English, then the built-in default', () => {
    const s = defaultTelegramSettings();
    s.locales.fa.welcome = 'سلام';
    s.locales.tr.welcome = '';
    s.locales.en.welcome = 'Hello';

    expect(resolveLocalizedMessage(s, 'fa', 'welcome')).toBe('سلام');
    expect(resolveLocalizedMessage(s, 'tr', 'welcome')).toBe('Hello');
    expect(resolveLocalizedMessage(s, 'de', 'welcome')).toBe('Hello');
    expect(resolveLocalizedMessage(s, null, 'welcome')).toBe('Hello');
  });

  it('never returns an empty string even when everything is blank', () => {
    const s = defaultTelegramSettings();
    for (const l of settings.TELEGRAM_LOCALES) s.locales[l].help = '';
    expect(resolveLocalizedMessage(s, 'fa', 'help').trim()).not.toBe('');
  });

  it('normalizes Telegram language codes', () => {
    expect(normalizeLocale('fa-IR')).toBe('fa');
    expect(normalizeLocale('EN')).toBe('en');
    expect(normalizeLocale('tr')).toBe('tr');
    expect(normalizeLocale('ru')).toBeNull();
    expect(normalizeLocale(undefined)).toBeNull();
  });
});

describe('commands', () => {
  it('recognizes commands with and without the bot suffix', () => {
    expect(commandKeyFromText('/start')).toBe('start');
    expect(commandKeyFromText('  /Help@MySupportBot ')).toBe('help');
    expect(commandKeyFromText('/human please')).toBe('human');
    expect(commandKeyFromText('/new')).toBe('new');
  });

  it('does not treat ordinary text as a command', () => {
    expect(commandKeyFromText('start')).toBeNull();
    expect(commandKeyFromText('I need /help with my order')).toBeNull();
    expect(commandKeyFromText('/unknown')).toBeNull();
  });

  it('builds a complete setMyCommands payload', () => {
    const list = buildTelegramCommandList(defaultTelegramSettings());
    expect(list.map((c) => c.command)).toEqual(['start', 'help', 'human', 'new', 'faq', 'guides']);
    expect(list.every((c) => c.description.trim().length > 0)).toBe(true);
  });

  it('maps commands to the right localized reply', () => {
    expect(messageKeyForCommand('start')).toBe('welcome');
    expect(messageKeyForCommand('help')).toBe('help');
    expect(messageKeyForCommand('human')).toBe('handoff');
  });
});
