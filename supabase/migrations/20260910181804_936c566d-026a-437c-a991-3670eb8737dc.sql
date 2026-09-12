CREATE OR REPLACE FUNCTION public._seed_billing_email_template(
  p_slug TEXT, p_locale TEXT, p_subject TEXT, p_title TEXT, p_intro TEXT,
  p_rows TEXT, p_cta TEXT, p_text TEXT
) RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE
  v_rtl BOOLEAN := (p_locale = 'fa');
  v_dir TEXT := CASE WHEN v_rtl THEN 'rtl' ELSE 'ltr' END;
  v_align TEXT := CASE WHEN v_rtl THEN 'right' ELSE 'left' END;
  v_html TEXT;
BEGIN
  v_html :=
    '<!DOCTYPE html><html lang="' || p_locale || '" dir="' || v_dir || '"><head><meta charset="utf-8">' ||
    '<meta name="viewport" content="width=device-width, initial-scale=1.0"><title>' || p_title || '</title></head>' ||
    '<body style="margin:0;padding:0;background-color:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica Neue,Arial,sans-serif;-webkit-font-smoothing:antialiased;">' ||
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f5f7;"><tr><td align="center" style="padding:40px 20px;">' ||
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background-color:#ffffff;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,0.06);overflow:hidden;">' ||
    '<tr><td style="background:linear-gradient(135deg,#3B82F6,#1E40AF);padding:32px 40px;text-align:center;">' ||
    '<h1 style="margin:0;color:#ffffff;font-size:22px;font-weight:700;letter-spacing:-0.3px;">{brand}</h1></td></tr>' ||
    '<tr><td style="padding:40px;text-align:' || v_align || ';">' ||
    '<h2 style="margin:0 0 16px;color:#1e293b;font-size:20px;font-weight:600;">' || p_title || '</h2>' ||
    '<p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:24px;">' || p_intro || '</p></td></tr>' ||
    CASE WHEN COALESCE(p_rows, '') = '' THEN '' ELSE
      '<tr><td style="padding:0 40px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:8px 16px;text-align:' || v_align || ';">' ||
      p_rows || '</table></td></tr>'
    END ||
    '<tr><td align="center" style="padding:30px 0;"><a href="{action_url}" style="display:inline-block;background-color:#3B82F6;color:#ffffff;font-size:16px;font-weight:600;text-decoration:none;padding:14px 32px;border-radius:8px;">' ||
    p_cta || '</a></td></tr>' ||
    '<tr><td style="padding:24px 40px;background-color:#f8fafc;border-top:1px solid #e2e8f0;text-align:center;">' ||
    '<p style="margin:0;color:#94a3b8;font-size:12px;line-height:20px;">&copy; {year} {brand}</p></td></tr>' ||
    '</table></td></tr></table></body></html>';

  DELETE FROM public.email_templates WHERE workspace_id IS NULL AND slug = p_slug AND locale = p_locale;
  INSERT INTO public.email_templates (workspace_id, slug, locale, subject, html_body, text_body, is_active)
  VALUES (NULL, p_slug, p_locale, p_subject, v_html, p_text, TRUE);
END;
$$;

CREATE OR REPLACE FUNCTION public._seed_billing_email_row(p_locale TEXT, p_label TEXT, p_value TEXT)
RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$
  SELECT '<tr><td style="padding:8px 0;color:#64748b;font-size:13px;">' || p_label ||
         '</td><td style="padding:8px 0;color:#1e293b;font-size:14px;font-weight:600;text-align:' ||
         CASE WHEN p_locale = 'fa' THEN 'left' ELSE 'right' END || ';">' || p_value || '</td></tr>';
$$;

DO $seed$
BEGIN
  PERFORM public._seed_billing_email_template('subscription_activated','fa',
    'پلن «{plan_name}» فعال شد — {brand}', 'پلن شما فعال شد',
    'پلن «{plan_name}» برای فضای کاری شما فعال شد و همه امکانات آن هم‌اکنون در دسترس است.',
    public._seed_billing_email_row('fa','پلن','{plan_name}') || public._seed_billing_email_row('fa','اعتبار تا','{period_end}'),
    'مشاهده اشتراک',
    'پلن «{plan_name}» فعال شد و تا {period_end} اعتبار دارد.');
  PERFORM public._seed_billing_email_template('subscription_activated','en',
    'Your {plan_name} plan is active — {brand}', 'Your plan is active',
    'The {plan_name} plan is now active for your workspace and every feature is available.',
    public._seed_billing_email_row('en','Plan','{plan_name}') || public._seed_billing_email_row('en','Paid through','{period_end}'),
    'View subscription',
    'The {plan_name} plan is active through {period_end}.');
  PERFORM public._seed_billing_email_template('subscription_activated','tr',
    '{plan_name} planınız etkin — {brand}', 'Planınız etkinleştirildi',
    '{plan_name} planı çalışma alanınız için etkinleştirildi ve tüm özellikler kullanıma hazır.',
    public._seed_billing_email_row('tr','Plan','{plan_name}') || public._seed_billing_email_row('tr','Geçerlilik','{period_end}'),
    'Aboneliği görüntüle',
    '{plan_name} planı {period_end} tarihine kadar etkin.');

  PERFORM public._seed_billing_email_template('wallet_deposit_received','fa',
    'کیف پول شما شارژ شد — {brand}', 'کیف پول شارژ شد',
    'مبلغ پرداختی شما با موفقیت به کیف پول فضای کاری اضافه شد.',
    public._seed_billing_email_row('fa','مبلغ','{amount}'), 'مشاهده کیف پول',
    'مبلغ {amount} به کیف پول شما اضافه شد.');
  PERFORM public._seed_billing_email_template('wallet_deposit_received','en',
    'Wallet topped up — {brand}', 'Wallet topped up',
    'Your payment was added to the workspace wallet balance.',
    public._seed_billing_email_row('en','Amount','{amount}'), 'View wallet',
    '{amount} was added to your workspace wallet.');
  PERFORM public._seed_billing_email_template('wallet_deposit_received','tr',
    'Cüzdanınıza bakiye yüklendi — {brand}', 'Cüzdan yüklendi',
    'Ödemeniz çalışma alanı cüzdan bakiyenize eklendi.',
    public._seed_billing_email_row('tr','Tutar','{amount}'), 'Cüzdanı görüntüle',
    'Cüzdanınıza {amount} eklendi.');

  PERFORM public._seed_billing_email_template('ai_credit_purchased','fa',
    'اعتبار هوش مصنوعی شما افزایش یافت — {brand}', 'اعتبار هوش مصنوعی شارژ شد',
    'خرید اعتبار هوش مصنوعی شما با موفقیت ثبت شد و اعتبار جدید بلافاصله قابل استفاده است.',
    public._seed_billing_email_row('fa','مبلغ','{amount}'), 'مشاهده اعتبار',
    'خرید اعتبار هوش مصنوعی به مبلغ {amount} ثبت شد.');
  PERFORM public._seed_billing_email_template('ai_credit_purchased','en',
    'AI credit added — {brand}', 'AI credit added',
    'Your AI credit purchase was completed and the new balance is available right away.',
    public._seed_billing_email_row('en','Amount','{amount}'), 'View balance',
    'Your AI credit purchase of {amount} was completed.');
  PERFORM public._seed_billing_email_template('ai_credit_purchased','tr',
    'AI kredisi eklendi — {brand}', 'AI kredisi eklendi',
    'AI kredi satın alımınız tamamlandı ve yeni bakiye hemen kullanılabilir.',
    public._seed_billing_email_row('tr','Tutar','{amount}'), 'Bakiyeyi görüntüle',
    '{amount} tutarındaki AI kredi satın alımınız tamamlandı.');

  PERFORM public._seed_billing_email_template('trial_ending_soon','fa',
    '{days_left} روز تا پایان دوره آزمایشی — {brand}', 'دوره آزمایشی رو به پایان است',
    'دوره آزمایشی فضای کاری شما به‌زودی تمام می‌شود. برای ادامه استفاده از همه امکانات، پلن خود را ارتقا دهید.',
    public._seed_billing_email_row('fa','پلن فعلی','{plan_name}') ||
    public._seed_billing_email_row('fa','پایان دوره','{trial_end}') ||
    public._seed_billing_email_row('fa','روز باقی‌مانده','{days_left}'),
    'ارتقای پلن',
    'دوره آزمایشی شما در {trial_end} به پایان می‌رسد ({days_left} روز دیگر).');
  PERFORM public._seed_billing_email_template('trial_ending_soon','en',
    'Your trial ends in {days_left} day(s) — {brand}', 'Your trial is ending soon',
    'Your workspace trial is about to end. Upgrade to keep every feature available.',
    public._seed_billing_email_row('en','Current plan','{plan_name}') ||
    public._seed_billing_email_row('en','Trial ends','{trial_end}') ||
    public._seed_billing_email_row('en','Days left','{days_left}'),
    'Upgrade plan',
    'Your trial ends on {trial_end} ({days_left} day(s) left).');
  PERFORM public._seed_billing_email_template('trial_ending_soon','tr',
    'Deneme süreniz {days_left} gün içinde bitiyor — {brand}', 'Deneme süreniz bitmek üzere',
    'Çalışma alanınızın deneme süresi bitmek üzere. Tüm özellikleri korumak için planınızı yükseltin.',
    public._seed_billing_email_row('tr','Mevcut plan','{plan_name}') ||
    public._seed_billing_email_row('tr','Bitiş','{trial_end}') ||
    public._seed_billing_email_row('tr','Kalan gün','{days_left}'),
    'Planı yükselt',
    'Deneme süreniz {trial_end} tarihinde sona eriyor ({days_left} gün kaldı).');

  PERFORM public._seed_billing_email_template('trial_expired','fa',
    'دوره آزمایشی شما به پایان رسید — {brand}', 'دوره آزمایشی تمام شد',
    'دوره آزمایشی شما تمام شد و فضای کاری به نسخه رایگان منتقل شد. هیچ داده‌ای حذف نشده است و با ارتقای پلن همه امکانات دوباره فعال می‌شود.',
    '', 'مشاهده پلن‌ها',
    'دوره آزمایشی شما تمام شد و فضای کاری به نسخه رایگان منتقل شد.');
  PERFORM public._seed_billing_email_template('trial_expired','en',
    'Your trial has ended — {brand}', 'Your trial has ended',
    'Your trial has ended and the workspace moved to the free plan. No data was deleted — upgrading restores full access.',
    '', 'See plans',
    'Your trial has ended and the workspace moved to the free plan.');
  PERFORM public._seed_billing_email_template('trial_expired','tr',
    'Deneme süreniz sona erdi — {brand}', 'Deneme süreniz sona erdi',
    'Deneme süreniz sona erdi ve çalışma alanı ücretsiz plana geçti. Hiçbir veri silinmedi; planı yükselttiğinizde tüm erişim geri gelir.',
    '', 'Planları gör',
    'Deneme süreniz sona erdi ve çalışma alanı ücretsiz plana geçti.');
END
$seed$;

DROP FUNCTION public._seed_billing_email_template(TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT);
DROP FUNCTION public._seed_billing_email_row(TEXT,TEXT,TEXT);

CREATE OR REPLACE FUNCTION public.billing_v2_resolve_billing_recipient(p_workspace_id uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_owner   UUID;
  v_email   TEXT;
  v_locale  TEXT;
  v_phone   TEXT;
  v_contact JSONB;
  v_default TEXT;
BEGIN
  SELECT metadata->'billing_contact' INTO v_contact
    FROM public.workspace_subscriptions WHERE workspace_id = p_workspace_id;

  SELECT owner_id INTO v_owner FROM public.workspaces WHERE id = p_workspace_id;
  IF v_owner IS NOT NULL THEN
    SELECT email INTO v_email FROM public.profiles WHERE id = v_owner;
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'profiles'
         AND column_name = 'preferred_locale'
    ) THEN
      EXECUTE 'SELECT preferred_locale FROM public.profiles WHERE id = $1'
        INTO v_locale USING v_owner;
    END IF;
  END IF;

  IF to_regclass('public.user_phone_verifications') IS NOT NULL AND v_owner IS NOT NULL THEN
    EXECUTE 'SELECT phone_e164 FROM public.user_phone_verifications
              WHERE user_id = $1 AND phone_verified_at IS NOT NULL'
      INTO v_phone USING v_owner;
  END IF;

  IF v_phone IS NULL AND v_owner IS NOT NULL AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'profiles' AND column_name = 'phone'
  ) THEN
    EXECUTE 'SELECT phone FROM public.profiles WHERE id = $1' INTO v_phone USING v_owner;
  END IF;

  SELECT NULLIF(default_locale, '') INTO v_default FROM public.platform_settings LIMIT 1;

  RETURN jsonb_build_object(
    'user_id', v_owner,
    'email', NULLIF(COALESCE(v_contact->>'email', v_email), ''),
    'phone', NULLIF(COALESCE(v_contact->>'phone', v_phone), ''),
    'locale', COALESCE(NULLIF(v_contact->>'locale', ''), NULLIF(v_locale, ''), v_default, 'en')
  );
END;
$function$;