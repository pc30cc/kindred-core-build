/**
 * Every native operator app writes every system kind the server writes.
 *
 * The apps cannot be built on this machine, so this reads their localizers'
 * sources: each needs a case for every kind in SYSTEM_MESSAGE_KINDS
 * (shared/systemMessages.ts), or a row of that kind prints its stored
 * English body ("Sara closed the conversation", "Rated 4/5") in a Persian
 * app. They lacked conversation_closed, support_rating and the requester
 * card; windows-native's list printed the body for every kind. Until a
 * release ships these, the server writes `body` in the operator's language
 * (server/services/operatorSystemText.ts).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { SYSTEM_MESSAGE_KINDS } from '../../../shared/systemMessages';

const LOCALIZERS: Record<string, { file: string; strings: string[] }> = {
  ios: {
    file: 'ios/Webyar/Sources/Localization/SystemMessageText.swift',
    strings: ['ios/Webyar/Sources/Localization/Strings.swift'],
  },
  android: {
    file: 'android/app/src/main/kotlin/com/platform/app/i18n/SystemMessageText.kt',
    strings: [
      'android/app/src/main/kotlin/com/platform/app/i18n/Strings.kt',
      'android/app/src/main/kotlin/com/platform/app/i18n/StringsManual.kt',
    ],
  },
  macos: {
    file: 'macos/Webyar/Core/Inbox/NotificationRules.swift',
    // The Mac bundles windows-native's table (macos Strings.swift).
    strings: ['windows-native/src/Webyar.Core/Localization/strings.json'],
  },
  windows: {
    file: 'windows/src/renderer/src/lib/format.ts',
    strings: ['windows/src/renderer/src/i18n/strings.json'],
  },
  windowsNative: {
    file: 'windows-native/src/Webyar.Core/Inbox/SystemText.cs',
    strings: ['windows-native/src/Webyar.Core/Localization/strings.json'],
  },
};

const read = (path: string) => readFileSync(path, 'utf8');

describe('native localizers know every system kind', () => {
  for (const [app, { file }] of Object.entries(LOCALIZERS)) {
    it(`${app}: a case for each of SYSTEM_MESSAGE_KINDS`, () => {
      const src = read(file);
      const missing = SYSTEM_MESSAGE_KINDS.filter((kind) => !src.includes(`"${kind}"`) && !src.includes(`'${kind}'`));
      expect(missing, `${file} has no case for`).toEqual([]);
    });

    it(`${app}: treats 'a colleague' as no name`, () => {
      expect(read(file).toLowerCase(), file).toContain('a colleague');
    });
  }

  it('a thread that draws no requester card prints its stored details (macOS, Electron)', () => {
    // iOS, Android and windows-native draw the card from metadata; these two
    // print the row, and the stored body is the card's full text (requester.ts).
    expect(read('macos/Webyar/Features/Chat/ChatModel.swift')).toMatch(/"platform_support_requester"[\s\S]{0,200}side == \.system && !isRequesterCard \? \(SystemText\.of/);
    expect(read('windows/src/renderer/src/features/chat/ChatPane.tsx')).toMatch(/'platform_support_requester'[\s\S]{0,300}requesterCard \? m\.body : \(systemText\(/);
  });

  it('every app reads the queue line from the operator\'s side', () => {
    for (const [app, { strings }] of Object.entries(LOCALIZERS)) {
      const copy = strings.map(read).join('\n');
      expect(copy, app).toContain('The visitor is waiting in the support queue');
      expect(copy, app).toContain('کاربر در صف پشتیبانی منتظر است');
      expect(copy, app).toContain('Ziyaretçi destek kuyruğunda bekliyor');
      expect(copy, app).not.toContain('You are in the queue');
    }
  });

  it('the new sentences are the dashboard\'s, word for word', () => {
    const PHRASES = [
      'This conversation was transferred to {to}', 'This conversation was transferred', 'This conversation was unassigned',
      '{name} closed the conversation', 'The conversation was closed', 'Rated the conversation {score}/5',
      'این گفتگو به {to} منتقل شد', 'این گفتگو منتقل شد', 'این گفتگو از حالت واگذارشده خارج شد',
      '{name} گفتگو را بست', 'گفتگو بسته شد', 'به این گفتگو {score} از ۵ امتیاز داد',
      'Bu görüşme {to} kişisine aktarıldı', 'Bu görüşme aktarıldı', 'Bu görüşmenin ataması kaldırıldı',
      '{name} sohbeti kapattı', 'Sohbet kapatıldı', 'Görüşmeye 5 üzerinden {score} puan verdi',
    ];
    for (const [app, { strings }] of Object.entries(LOCALIZERS)) {
      const copy = strings.map(read).join('\n');
      const missing = PHRASES.filter((p) => !copy.includes(p));
      expect(missing, app).toEqual([]);
    }
  });
});

describe('windows-native list preview', () => {
  it('writes a system row from its kind before printing the body', () => {
    const display = read('windows-native/src/Webyar.Core/Inbox/Display.cs');
    const preview = display.slice(display.indexOf('public static string Preview('), display.indexOf('public static string AttachmentPreview('));
    expect(preview).toContain('last.SystemKind');
    expect(preview).toContain('SystemText.For(');
    expect(preview.indexOf('SystemText.For(')).toBeLessThan(preview.indexOf('OneLine(last.Body)'));
  });

  it('decodes system_meta on the list row', () => {
    const models = read('windows-native/src/Webyar.Core/Api/Models.cs');
    const record = models.slice(models.indexOf('public sealed record MessagePreview('), models.indexOf('public sealed record Conversation('));
    expect(record).toMatch(/JsonElement\? SystemMeta = null/);
  });
});
