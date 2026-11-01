/**
 * What a visitor gets when the owner left a message empty, in the visitor's
 * language: the placeholders of the message fields and the page's preview.
 * Copies of the server's own texts (server/services/ai-agent/intro.ts
 * FALLBACK_INTRO / UNNAMED_INTRO, and the handoff lines the Name & messages
 * page always showed); they are visitor content, not dashboard copy, so they
 * follow the message's language and never the dashboard's.
 */
import { isDefaultAiAgentName } from '../../../../../shared/systemMessages';

type ContentLocale = 'en' | 'fa' | 'tr';

const NAMED_INTRO: Record<ContentLocale, (name: string) => string> = {
  en: (name) =>
    `Hi! I'm ${name}, an AI assistant. I can answer questions from our help center. If I'm not sure about something, I'll connect you with a human agent.`,
  fa: (name) =>
    `سلام! من ${name} هستم، یک دستیار هوشمند. می‌توانم به سوالات شما با کمک پایگاه دانش پاسخ بدهم. اگر مطمئن نباشم، شما را به یک کارشناس انسانی وصل می‌کنم.`,
  tr: (name) =>
    `Merhaba! Ben ${name}, bir yapay zeka asistanıyım. Yardım merkezimizden sorularınızı yanıtlayabilirim. Emin olmadığım konularda sizi bir temsilciye bağlarım.`,
};

const UNNAMED_INTRO: Record<ContentLocale, string> = {
  en: "Hi! I'm an AI assistant. I can answer questions from our help center. If I'm not sure about something, I'll connect you with a human agent.",
  fa: 'سلام! من یک دستیار هوش مصنوعی هستم. می‌توانم به سوالات شما با کمک پایگاه دانش پاسخ بدهم. اگر مطمئن نباشم، شما را به یک کارشناس انسانی وصل می‌کنم.',
  tr: 'Merhaba! Ben bir yapay zekâ asistanıyım. Yardım merkezimizden sorularınızı yanıtlayabilirim. Emin olmadığım konularda sizi bir temsilciye bağlarım.',
};

const HANDOFF: Record<ContentLocale, string> = {
  en: "Sure — I'll connect you with a human agent.",
  fa: 'باشه — همین الان شما را به یک کارشناس انسانی وصل می‌کنم.',
  tr: 'Tamam — sizi bir temsilciye bağlıyorum.',
};

const HANDOFF_PRECHAT: Record<ContentLocale, string> = {
  en: 'So our team can help you faster, please complete your info below.',
  fa: 'برای اینکه اپراتورهای ما بتوانند بهتر به شما پاسخگو باشند لطفا اطلاعات خودتان را تکمیل کنید.',
  tr: 'Ekibimizin size daha iyi yardımcı olabilmesi için lütfen bilgilerinizi tamamlayın.',
};


function contentLocale(code: string): ContentLocale {
  const base = (code || '').toLowerCase().split('-')[0];
  return base === 'fa' || base === 'tr' ? base : 'en';
}

/** The greeting the server sends when the welcome message is empty in `code`. */
export function defaultIntro(code: string, agentName: string): string {
  const loc = contentLocale(code);
  const own = (agentName || '').trim();
  return own && !isDefaultAiAgentName(own) ? NAMED_INTRO[loc](own) : UNNAMED_INTRO[loc];
}

export function defaultHandoffMessage(code: string): string {
  return HANDOFF[contentLocale(code)];
}

export function defaultHandoffPrechatMessage(code: string): string {
  return HANDOFF_PRECHAT[contentLocale(code)];
}

const RTL_LOCALES = new Set(['fa', 'ar', 'he', 'ur']);

export function localeDir(code: string): 'rtl' | 'ltr' {
  return RTL_LOCALES.has((code || '').toLowerCase().split('-')[0]) ? 'rtl' : 'ltr';
}
