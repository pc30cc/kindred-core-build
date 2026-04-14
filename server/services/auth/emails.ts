/**
 * Auth email templates and sending.
 * Uses the project's own email service (Resend/SendGrid/SMTP).
 * Fully backend-controlled — no Supabase email dependency.
 */

import type { ServerConfig } from '../../config.js';
import { sendEmail } from '../email/index.js';

// ─── Localized email content ─────────────────────────────────────

interface EmailContent {
  subject: string;
  html: string;
  text: string;
}

const verificationTemplates: Record<string, (link: string, platformName: string) => EmailContent> = {
  en: (link, platformName) => ({
    subject: `Verify your email — ${platformName}`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;">
        <h2 style="color:#1a1a1a;">Verify your email</h2>
        <p style="color:#555;line-height:1.6;">Thank you for signing up. Please verify your email address by clicking the button below.</p>
        <div style="text-align:center;margin:32px 0;">
          <a href="${link}" style="display:inline-block;background:#3B82F6;color:#fff;padding:12px 32px;border-radius:8px;text-decoration:none;font-weight:600;">Verify Email</a>
        </div>
        <p style="color:#999;font-size:12px;">If you didn't create an account, you can safely ignore this email.</p>
        <p style="color:#999;font-size:12px;">This link expires in 24 hours.</p>
      </div>`,
    text: `Verify your email\n\nThank you for signing up. Please verify your email by visiting:\n${link}\n\nThis link expires in 24 hours.`,
  }),
  fa: (link, platformName) => ({
    subject: `تأیید ایمیل — ${platformName}`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;direction:rtl;">
        <h2 style="color:#1a1a1a;">تأیید ایمیل</h2>
        <p style="color:#555;line-height:1.6;">از ثبت‌نام شما متشکریم. لطفاً با کلیک روی دکمه زیر ایمیل خود را تأیید کنید.</p>
        <div style="text-align:center;margin:32px 0;">
          <a href="${link}" style="display:inline-block;background:#3B82F6;color:#fff;padding:12px 32px;border-radius:8px;text-decoration:none;font-weight:600;">تأیید ایمیل</a>
        </div>
        <p style="color:#999;font-size:12px;">اگر حساب کاربری ایجاد نکرده‌اید، می‌توانید این ایمیل را نادیده بگیرید.</p>
        <p style="color:#999;font-size:12px;">این لینک ۲۴ ساعت اعتبار دارد.</p>
      </div>`,
    text: `تأیید ایمیل\n\nاز ثبت‌نام شما متشکریم. لطفاً ایمیل خود را با مراجعه به لینک زیر تأیید کنید:\n${link}\n\nاین لینک ۲۴ ساعت اعتبار دارد.`,
  }),
  tr: (link, platformName) => ({
    subject: `E-postanızı doğrulayın — ${platformName}`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;">
        <h2 style="color:#1a1a1a;">E-postanızı doğrulayın</h2>
        <p style="color:#555;line-height:1.6;">Kaydınız için teşekkürler. Lütfen aşağıdaki butona tıklayarak e-posta adresinizi doğrulayın.</p>
        <div style="text-align:center;margin:32px 0;">
          <a href="${link}" style="display:inline-block;background:#3B82F6;color:#fff;padding:12px 32px;border-radius:8px;text-decoration:none;font-weight:600;">E-postayı Doğrula</a>
        </div>
        <p style="color:#999;font-size:12px;">Bir hesap oluşturmadıysanız bu e-postayı güvenle görmezden gelebilirsiniz.</p>
        <p style="color:#999;font-size:12px;">Bu bağlantı 24 saat geçerlidir.</p>
      </div>`,
    text: `E-postanızı doğrulayın\n\nKaydınız için teşekkürler. Lütfen aşağıdaki bağlantıyı ziyaret ederek e-postanızı doğrulayın:\n${link}\n\nBu bağlantı 24 saat geçerlidir.`,
  }),
};

const resetTemplates: Record<string, (link: string, platformName: string) => EmailContent> = {
  en: (link, platformName) => ({
    subject: `Reset your password — ${platformName}`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;">
        <h2 style="color:#1a1a1a;">Reset your password</h2>
        <p style="color:#555;line-height:1.6;">We received a request to reset your password. Click the button below to choose a new password.</p>
        <div style="text-align:center;margin:32px 0;">
          <a href="${link}" style="display:inline-block;background:#3B82F6;color:#fff;padding:12px 32px;border-radius:8px;text-decoration:none;font-weight:600;">Reset Password</a>
        </div>
        <p style="color:#999;font-size:12px;">If you didn't request this, you can safely ignore this email.</p>
        <p style="color:#999;font-size:12px;">This link expires in 30 minutes.</p>
      </div>`,
    text: `Reset your password\n\nWe received a request to reset your password. Visit:\n${link}\n\nThis link expires in 30 minutes.`,
  }),
  fa: (link, platformName) => ({
    subject: `بازنشانی رمز عبور — ${platformName}`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;direction:rtl;">
        <h2 style="color:#1a1a1a;">بازنشانی رمز عبور</h2>
        <p style="color:#555;line-height:1.6;">درخواست بازنشانی رمز عبور دریافت شد. برای انتخاب رمز عبور جدید روی دکمه زیر کلیک کنید.</p>
        <div style="text-align:center;margin:32px 0;">
          <a href="${link}" style="display:inline-block;background:#3B82F6;color:#fff;padding:12px 32px;border-radius:8px;text-decoration:none;font-weight:600;">بازنشانی رمز عبور</a>
        </div>
        <p style="color:#999;font-size:12px;">اگر این درخواست را ارسال نکرده‌اید، می‌توانید این ایمیل را نادیده بگیرید.</p>
        <p style="color:#999;font-size:12px;">این لینک ۳۰ دقیقه اعتبار دارد.</p>
      </div>`,
    text: `بازنشانی رمز عبور\n\nدرخواست بازنشانی رمز عبور دریافت شد. لطفاً به لینک زیر مراجعه کنید:\n${link}\n\nاین لینک ۳۰ دقیقه اعتبار دارد.`,
  }),
  tr: (link, platformName) => ({
    subject: `Şifrenizi sıfırlayın — ${platformName}`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;">
        <h2 style="color:#1a1a1a;">Şifrenizi sıfırlayın</h2>
        <p style="color:#555;line-height:1.6;">Şifre sıfırlama isteği aldık. Yeni bir şifre seçmek için aşağıdaki butona tıklayın.</p>
        <div style="text-align:center;margin:32px 0;">
          <a href="${link}" style="display:inline-block;background:#3B82F6;color:#fff;padding:12px 32px;border-radius:8px;text-decoration:none;font-weight:600;">Şifreyi Sıfırla</a>
        </div>
        <p style="color:#999;font-size:12px;">Bu isteği siz yapmadıysanız bu e-postayı güvenle görmezden gelebilirsiniz.</p>
        <p style="color:#999;font-size:12px;">Bu bağlantı 30 dakika geçerlidir.</p>
      </div>`,
    text: `Şifrenizi sıfırlayın\n\nŞifre sıfırlama isteği aldık. Aşağıdaki bağlantıyı ziyaret edin:\n${link}\n\nBu bağlantı 30 dakika geçerlidir.`,
  }),
};

function getTemplate(
  templates: Record<string, (link: string, name: string) => EmailContent>,
  locale: string,
  link: string,
  platformName: string
): EmailContent {
  const tpl = templates[locale] || templates['en'];
  return tpl(link, platformName);
}

// ─── Send functions ──────────────────────────────────────────────

/**
 * Send verification email using our own email provider.
 * Falls back to stub (console log) if no provider configured.
 */
export async function sendVerificationEmail(
  config: ServerConfig,
  to: string,
  verifyLink: string,
  locale: string = 'en',
  workspaceId?: string
): Promise<boolean> {
  const platformName = config.appName || 'Growth Suite';
  const content = getTemplate(verificationTemplates, locale, verifyLink, platformName);

  try {
    const result = await sendEmail(config, {
      workspaceId: workspaceId || '__system__',
      to,
      subject: content.subject,
      html: content.html,
      text: content.text,
      from: config.systemFromEmail || undefined,
    });
    return result.success;
  } catch (err) {
    console.error('[auth/emails] Failed to send verification email:', err);
    // Fallback: log the link for development
    console.log(`[auth/emails] FALLBACK: Verification link for ${to}: ${verifyLink}`);
    return false;
  }
}

/**
 * Send password reset email using our own email provider.
 */
export async function sendResetEmail(
  config: ServerConfig,
  to: string,
  resetLink: string,
  locale: string = 'en',
  workspaceId?: string
): Promise<boolean> {
  const platformName = config.appName || 'Growth Suite';
  const content = getTemplate(resetTemplates, locale, resetLink, platformName);

  try {
    const result = await sendEmail(config, {
      workspaceId: workspaceId || '__system__',
      to,
      subject: content.subject,
      html: content.html,
      text: content.text,
      from: config.systemFromEmail || undefined,
    });
    return result.success;
  } catch (err) {
    console.error('[auth/emails] Failed to send reset email:', err);
    console.log(`[auth/emails] FALLBACK: Reset link for ${to}: ${resetLink}`);
    return false;
  }
}
