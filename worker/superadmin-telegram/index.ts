import { loadConfig } from '../../server/config.js';
import {
  callTelegram,
  deleteWebhook,
  sendChatAction,
  sendMessage,
  setMyCommands,
  type BotCredential,
} from '../../channels/providers/telegram/client.js';
import { answerOpsQuestion } from './assistant.js';
import {
  collectOpsSnapshot,
  formatOpsStatus,
  formatRealtimeStatus,
  formatRedisStatus,
} from './opsSnapshot.js';
import {
  InMemoryRateGate,
  isAuthorizedPrivateMessage,
  normalizeQuestion,
  parseAllowedUserIds,
  splitTelegramText,
  type TelegramMessageLike,
} from './utils.js';

type TelegramUpdate = {
  update_id: number;
  message?: TelegramMessageLike;
};

const HELP = [
  'ربات فنی خصوصی سوپرادمین',
  '',
  '/status — وضعیت کلی DB / AI Runtime / Realtime / Redis',
  '/realtime — وضعیت نودهای Centrifugo و connectionها',
  '/redis — وضعیت Redis/Valkey',
  '/privacy — مدل عدم ذخیره‌سازی',
  '/help — راهنما',
  '',
  'یا یک سؤال فنی آزاد بپرس؛ مثال:',
  '«با وضعیت فعلی چه زمانی Node سوم لازم می‌شود؟»',
  '«آیا Redis الان bottleneck است؟»',
  '«برای تست 500k concurrent چه چیزهایی را اندازه بگیریم؟»',
].join('\n');

const PRIVACY = [
  'Privacy / No-log contract',
  '',
  '• متن سؤال و جواب در PostgreSQL/Supabase ذخیره نمی‌شود.',
  '• ai_usage_logs / billing run / conversation row برای این ربات ساخته نمی‌شود.',
  '• history مکالمه در worker نگه‌داری دائمی نمی‌شود؛ هر سؤال مستقل است.',
  '• update offset تلگرام فقط در حافظهٔ process است و در DB نوشته نمی‌شود.',
  '• محتوای سؤال/جواب در console log چاپ نمی‌شود.',
  '• خود Telegram به‌عنوان سرویس انتقال ممکن است پیام‌های چت را طبق سیاست خودش نگه دارد.',
  '• ربات فقط read-only است و هیچ config/restart/drain/SQL write اجرا نمی‌کند.',
].join('\n');

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

async function sendLongText(
  credential: BotCredential,
  chatId: string | number,
  text: string,
  replyToMessageId?: number,
): Promise<void> {
  const chunks = splitTelegramText(text);
  for (let i = 0; i < chunks.length; i += 1) {
    await sendMessage(credential, {
      chatId,
      text: chunks[i],
      replyToMessageId: i === 0 ? replyToMessageId : undefined,
    });
  }
}

function commandOf(text: string): string | null {
  const first = text.trim().split(/\s+/)[0]?.toLowerCase() || '';
  if (!first.startsWith('/')) return null;
  return first.split('@')[0];
}

export async function startSuperadminTelegramWorker(): Promise<void> {
  const botToken = requiredEnv('SUPERADMIN_TELEGRAM_BOT_TOKEN');
  const allowed = parseAllowedUserIds(requiredEnv('SUPERADMIN_TELEGRAM_ALLOWED_USER_IDS'));
  if (!allowed.size) throw new Error('SUPERADMIN_TELEGRAM_ALLOWED_USER_IDS has no valid numeric Telegram user id');

  const credential: BotCredential = botToken;
  const config = loadConfig();
  const limiter = new InMemoryRateGate(
    Number(process.env.SUPERADMIN_TELEGRAM_MAX_REQUESTS_PER_MINUTE || 12) || 12,
    60_000,
  );
  const inFlight = new Set<string>();

  // Long polling owns this dedicated bot. No webhook route, no queue table.
  await deleteWebhook(credential);
  await setMyCommands(credential, [
    { command: 'status', description: 'وضعیت کلی سرویس‌ها' },
    { command: 'realtime', description: 'وضعیت Centrifugo و نودها' },
    { command: 'redis', description: 'وضعیت Redis/Valkey' },
    { command: 'privacy', description: 'قرارداد عدم ذخیره لاگ' },
    { command: 'help', description: 'راهنما' },
  ]).catch(() => undefined);

  let offset = 0;
  for (;;) {
    let updates: TelegramUpdate[] = [];
    try {
      updates = await callTelegram<TelegramUpdate[]>(
        credential,
        'getUpdates',
        {
          offset: offset || undefined,
          timeout: 30,
          allowed_updates: ['message'],
        },
        40_000,
      );
    } catch {
      // Never include Telegram/API error detail in logs; it may contain provider context.
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      continue;
    }

    for (const update of updates) {
      offset = Math.max(offset, update.update_id + 1);
      const message = update.message;
      if (!isAuthorizedPrivateMessage(message, allowed)) continue;

      const text = normalizeQuestion(message?.text);
      if (!text || !message?.chat?.id || !message.from?.id) continue;
      const chatId = message.chat.id;
      const userKey = String(message.from.id);
      const replyTo = typeof message.message_id === 'number' ? message.message_id : undefined;

      if (!limiter.allow(userKey)) {
        await sendLongText(credential, chatId, 'تعداد درخواست‌ها زیاد است؛ یک دقیقه بعد دوباره امتحان کن.', replyTo)
          .catch(() => undefined);
        continue;
      }

      const command = commandOf(text);
      if (command === '/start' || command === '/help') {
        await sendLongText(credential, chatId, HELP, replyTo).catch(() => undefined);
        continue;
      }
      if (command === '/privacy') {
        await sendLongText(credential, chatId, PRIVACY, replyTo).catch(() => undefined);
        continue;
      }

      if (inFlight.has(userKey)) {
        await sendLongText(credential, chatId, 'یک سؤال قبلی هنوز در حال پاسخ است.', replyTo).catch(() => undefined);
        continue;
      }

      inFlight.add(userKey);
      try {
        await sendChatAction(credential, chatId, 'typing').catch(() => undefined);
        const snapshot = await collectOpsSnapshot(config);

        let answer: string;
        if (command === '/status') answer = formatOpsStatus(snapshot);
        else if (command === '/realtime') answer = formatRealtimeStatus(snapshot);
        else if (command === '/redis') answer = formatRedisStatus(snapshot);
        else if (command) answer = HELP;
        else answer = await answerOpsQuestion(config, text, snapshot);

        await sendLongText(credential, chatId, answer, replyTo);
      } catch {
        await sendLongText(credential, chatId, 'در خواندن وضعیت فنی یا تولید پاسخ خطای موقت رخ داد.', replyTo)
          .catch(() => undefined);
      } finally {
        inFlight.delete(userKey);
      }
    }
  }
}
