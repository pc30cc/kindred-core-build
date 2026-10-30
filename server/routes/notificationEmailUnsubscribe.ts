/**
 * THE UNSUBSCRIBE LINK OF THE OPERATOR NOTIFICATION EMAILS.
 *
 * Public, no session: the link in the mail is the whole credential, a token
 * that names one person and one type and ends after a while
 * (services/notificationEmail/unsubscribe.ts). Mounted in server/index.ts
 * ahead of the signed-in `/api/notifications/email`.
 *
 *   POST /api/notifications/email/unsubscribe/:token
 *     RFC 8058 one-click: the mailbox's own "Unsubscribe" button posts here
 *     (List-Unsubscribe-Post: List-Unsubscribe=One-Click) with no cookie and
 *     no context, and that type is off for that person. The page below posts
 *     here too. Answers with the page that says so.
 *
 *   GET /api/notifications/email/unsubscribe/:token
 *     The page the visible line in the mail opens: it asks first, with one
 *     button that posts above. A GET changes nothing, so a link scanner or a
 *     mail preview that follows every link unsubscribes nobody.
 *
 * Turning a type off is the operator's own switch
 * (user_email_notification_prefs, the same row Settings → Notifications
 * writes), so it is undone there. The offline-message notice's switch is
 * one of them (migration 289g); before that column exists its link answers
 * that it did not work, to try again in a few minutes.
 */
import { Router, type Request, type Response } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import type { ServerConfig } from '../config.js';
import { getServiceClient } from '../supabase.js';
import { resolveWorkspaceAppUrl } from '../services/auth-email.js';
import { operatorLocaleFrom, type OperatorLocale } from '../services/operatorLocale.js';
import { escapeHtml, unsubscribeText, verifyUnsubscribeToken } from '../services/notificationEmail/unsubscribe.js';
import type { EmailPreferenceType } from '../services/notificationEmail/types.js';

export const notificationEmailUnsubscribeRouter = Router();

function serverConfigOf(req: Request): ServerConfig {
  return (req as unknown as Request & { serverConfig: ServerConfig }).serverConfig;
}

notificationEmailUnsubscribeRouter.use(rateLimit({
  windowMs: 60_000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req.ip ? ipKeyGenerator(req.ip) : 'unknown'),
}));

/** The person's language for the page, else the platform's. */
async function pageLocale(config: ServerConfig, userId: string | null): Promise<OperatorLocale> {
  let preferred: unknown = null;
  if (userId) {
    const { data } = await getServiceClient(config).from('profiles').select('preferred_locale').eq('id', userId).maybeSingle();
    preferred = (data as { preferred_locale?: unknown } | null)?.preferred_locale ?? null;
  }
  return operatorLocaleFrom(config, preferred);
}

/** A whole page, in `locale`: one message, and a button or a link. */
function page(locale: OperatorLocale, message: string, action: { kind: 'form'; label: string } | { kind: 'link'; label: string; href: string } | null): string {
  const dir = locale === 'fa' ? 'rtl' : 'ltr';
  const title = escapeHtml(unsubscribeText(locale, 'emailUnsubscribeTitle'));
  const button = !action
    ? ''
    : action.kind === 'form'
      ? `<form method="post"><button type="submit">${escapeHtml(action.label)}</button></form>`
      : `<p><a href="${escapeHtml(action.href)}">${escapeHtml(action.label)}</a></p>`;
  return `<!doctype html>
<html lang="${locale}" dir="${dir}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${title}</title>
<style>
body{margin:0;background:#f8fafc;color:#0f172a;font:16px/1.6 system-ui,-apple-system,"Segoe UI",Tahoma,sans-serif}
main{max-width:480px;margin:12vh auto;padding:32px 24px;background:#fff;border:1px solid #e2e8f0;border-radius:12px}
h1{margin:0 0 12px;font-size:20px}
p{margin:0 0 20px}
button{font:inherit;padding:10px 20px;border:0;border-radius:8px;background:#0f172a;color:#fff;cursor:pointer}
a{color:#0f172a}
</style>
</head>
<body><main><h1>${title}</h1><p>${escapeHtml(message)}</p>${button}</main></body>
</html>`;
}

function send(res: Response, status: number, html: string): void {
  res.status(status).set({ 'Cache-Control': 'no-store', 'Content-Type': 'text/html; charset=utf-8' }).send(html);
}

async function settingsLink(config: ServerConfig): Promise<string | null> {
  return resolveWorkspaceAppUrl(config, null, '/settings/notifications').catch(() => null);
}

async function invalid(config: ServerConfig, res: Response): Promise<void> {
  const locale = await pageLocale(config, null).catch(() => 'en' as OperatorLocale);
  const href = await settingsLink(config);
  send(res, 400, page(
    locale,
    unsubscribeText(locale, 'emailUnsubscribeInvalid'),
    href ? { kind: 'link', label: unsubscribeText(locale, 'emailFooterSettings'), href } : null,
  ));
}

// GET /api/notifications/email/unsubscribe/:token — asks, changes nothing.
notificationEmailUnsubscribeRouter.get('/:token', async (req, res) => {
  const config = serverConfigOf(req);
  try {
    const check = verifyUnsubscribeToken(req.params.token);
    if (!check.ok) return await invalid(config, res);
    const locale = await pageLocale(config, check.userId);
    send(res, 200, page(
      locale,
      unsubscribeText(locale, 'emailUnsubscribeQuestion', check.type),
      { kind: 'form', label: unsubscribeText(locale, 'emailUnsubscribeConfirm') },
    ));
  } catch (err) {
    console.error('[notification-email] unsubscribe page failed', { message: err instanceof Error ? err.message : String(err) });
    send(res, 500, page('en', unsubscribeText('en', 'emailUnsubscribeFailed'), null));
  }
});

// POST /api/notifications/email/unsubscribe/:token — the one click.
notificationEmailUnsubscribeRouter.post('/:token', async (req, res) => {
  const config = serverConfigOf(req);
  try {
    const check = verifyUnsubscribeToken(req.params.token);
    if (!check.ok) return await invalid(config, res);
    const locale = await pageLocale(config, check.userId);
    const turnedOff = await turnOff(config, check.userId, check.type);
    if (!turnedOff) {
      send(res, 503, page(locale, unsubscribeText(locale, 'emailUnsubscribeFailed'), null));
      return;
    }
    const href = await settingsLink(config);
    send(res, 200, page(
      locale,
      unsubscribeText(locale, 'emailUnsubscribeDone', check.type),
      href ? { kind: 'link', label: unsubscribeText(locale, 'emailFooterSettings'), href } : null,
    ));
  } catch (err) {
    console.error('[notification-email] unsubscribe failed', { message: err instanceof Error ? err.message : String(err) });
    send(res, 500, page('en', unsubscribeText('en', 'emailUnsubscribeFailed'), null));
  }
});

/**
 * The operator's own switch for this type, off. An account that no longer
 * exists has nothing to turn off, which is the outcome asked for.
 */
async function turnOff(config: ServerConfig, userId: string, type: EmailPreferenceType): Promise<boolean> {
  const { error } = await getServiceClient(config)
    .from('user_email_notification_prefs')
    .upsert({ user_id: userId, [type]: false, updated_at: new Date().toISOString() }, { onConflict: 'user_id' });
  if (!error) return true;
  if (String(error.code) === '23503') return true;
  console.error('[notification-email] unsubscribe not saved', { type, message: error.message });
  return false;
}
