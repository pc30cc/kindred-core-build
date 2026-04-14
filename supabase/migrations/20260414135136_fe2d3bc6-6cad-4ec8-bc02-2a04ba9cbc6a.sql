
INSERT INTO public.email_templates (workspace_id, slug, locale, subject, html_body, text_body, is_active) VALUES
-- ── Auth ──
(NULL, 'email_verify', 'en', 'Verify your email', '<h2>Hi {name},</h2><p>Please verify your email by clicking the link below:</p><p><a href="{action_url}">Verify Email</a></p><p>This link expires in {expiry_time}.</p><p>— {brand}</p>', NULL, true),
(NULL, 'email_verify', 'fa', 'تایید ایمیل شما', '<h2>سلام {name}،</h2><p>لطفاً ایمیل خود را با کلیک روی لینک زیر تایید کنید:</p><p><a href="{action_url}">تایید ایمیل</a></p><p>این لینک تا {expiry_time} معتبر است.</p><p>— {brand}</p>', NULL, true),
(NULL, 'email_verify', 'tr', 'E-postanızı doğrulayın', '<h2>Merhaba {name},</h2><p>Lütfen aşağıdaki bağlantıya tıklayarak e-postanızı doğrulayın:</p><p><a href="{action_url}">E-postayı Doğrula</a></p><p>Bu bağlantı {expiry_time} süresince geçerlidir.</p><p>— {brand}</p>', NULL, true),

(NULL, 'password_reset', 'en', 'Reset your password', '<h2>Hi {name},</h2><p>Click below to reset your password:</p><p><a href="{action_url}">Reset Password</a></p><p>This link expires in {expiry_time}.</p><p>— {brand}</p>', NULL, true),
(NULL, 'password_reset', 'fa', 'بازنشانی رمز عبور', '<h2>سلام {name}،</h2><p>برای بازنشانی رمز عبور روی لینک زیر کلیک کنید:</p><p><a href="{action_url}">بازنشانی رمز عبور</a></p><p>این لینک تا {expiry_time} معتبر است.</p><p>— {brand}</p>', NULL, true),
(NULL, 'password_reset', 'tr', 'Şifrenizi sıfırlayın', '<h2>Merhaba {name},</h2><p>Şifrenizi sıfırlamak için aşağıdaki bağlantıya tıklayın:</p><p><a href="{action_url}">Şifreyi Sıfırla</a></p><p>Bu bağlantı {expiry_time} süresince geçerlidir.</p><p>— {brand}</p>', NULL, true),

(NULL, 'magic_link', 'en', 'Your login link', '<h2>Hi {name},</h2><p>Click below to sign in:</p><p><a href="{action_url}">Sign In</a></p><p>This link expires in {expiry_time}.</p><p>— {brand}</p>', NULL, true),
(NULL, 'magic_link', 'fa', 'لینک ورود شما', '<h2>سلام {name}،</h2><p>برای ورود روی لینک زیر کلیک کنید:</p><p><a href="{action_url}">ورود</a></p><p>این لینک تا {expiry_time} معتبر است.</p><p>— {brand}</p>', NULL, true),
(NULL, 'magic_link', 'tr', 'Giriş bağlantınız', '<h2>Merhaba {name},</h2><p>Giriş yapmak için aşağıdaki bağlantıya tıklayın:</p><p><a href="{action_url}">Giriş Yap</a></p><p>Bu bağlantı {expiry_time} süresince geçerlidir.</p><p>— {brand}</p>', NULL, true),

(NULL, 'welcome', 'en', 'Welcome to {brand}!', '<h2>Hi {name},</h2><p>Welcome to {brand}! Your account is ready.</p><p><a href="{action_url}">Go to Dashboard</a></p><p>— {brand}</p>', NULL, true),
(NULL, 'welcome', 'fa', 'به {brand} خوش آمدید!', '<h2>سلام {name}،</h2><p>به {brand} خوش آمدید! حساب شما آماده است.</p><p><a href="{action_url}">ورود به داشبورد</a></p><p>— {brand}</p>', NULL, true),
(NULL, 'welcome', 'tr', '{brand} ''a hoş geldiniz!', '<h2>Merhaba {name},</h2><p>{brand}''a hoş geldiniz! Hesabınız hazır.</p><p><a href="{action_url}">Panele Git</a></p><p>— {brand}</p>', NULL, true),

-- ── Transactional ──
(NULL, 'invite_member', 'en', 'You''ve been invited to {workspace}', '<h2>Hi {name},</h2><p>{inviter} invited you to join <strong>{workspace}</strong> as <strong>{role}</strong>.</p><p><a href="{action_url}">Accept Invite</a></p><p>— {brand}</p>', NULL, true),
(NULL, 'invite_member', 'fa', 'دعوت به {workspace}', '<h2>سلام {name}،</h2><p>{inviter} شما را به <strong>{workspace}</strong> با نقش <strong>{role}</strong> دعوت کرده است.</p><p><a href="{action_url}">پذیرش دعوت</a></p><p>— {brand}</p>', NULL, true),
(NULL, 'invite_member', 'tr', '{workspace} ''a davet edildiniz', '<h2>Merhaba {name},</h2><p>{inviter} sizi <strong>{workspace}</strong> ''a <strong>{role}</strong> olarak davet etti.</p><p><a href="{action_url}">Daveti Kabul Et</a></p><p>— {brand}</p>', NULL, true),

(NULL, 'payment_success', 'en', 'Payment received', '<h2>Hi {name},</h2><p>Your payment of <strong>{amount} {currency}</strong> for <strong>{plan}</strong> was successful.</p><p><a href="{invoice_url}">View Invoice</a></p><p>— {brand}</p>', NULL, true),
(NULL, 'payment_success', 'fa', 'پرداخت موفق', '<h2>سلام {name}،</h2><p>پرداخت شما به مبلغ <strong>{amount} {currency}</strong> برای پلن <strong>{plan}</strong> موفق بود.</p><p><a href="{invoice_url}">مشاهده فاکتور</a></p><p>— {brand}</p>', NULL, true),
(NULL, 'payment_success', 'tr', 'Ödeme alındı', '<h2>Merhaba {name},</h2><p><strong>{plan}</strong> planı için <strong>{amount} {currency}</strong> ödemeniz başarılı oldu.</p><p><a href="{invoice_url}">Faturayı Görüntüle</a></p><p>— {brand}</p>', NULL, true),

(NULL, 'payment_failed', 'en', 'Payment failed', '<h2>Hi {name},</h2><p>Your payment of <strong>{amount} {currency}</strong> failed. Reason: {reason}</p><p><a href="{action_url}">Update Payment Method</a></p><p>— {brand}</p>', NULL, true),
(NULL, 'payment_failed', 'fa', 'پرداخت ناموفق', '<h2>سلام {name}،</h2><p>پرداخت شما به مبلغ <strong>{amount} {currency}</strong> ناموفق بود. دلیل: {reason}</p><p><a href="{action_url}">به‌روزرسانی روش پرداخت</a></p><p>— {brand}</p>', NULL, true),
(NULL, 'payment_failed', 'tr', 'Ödeme başarısız', '<h2>Merhaba {name},</h2><p><strong>{amount} {currency}</strong> tutarındaki ödemeniz başarısız oldu. Neden: {reason}</p><p><a href="{action_url}">Ödeme Yöntemini Güncelle</a></p><p>— {brand}</p>', NULL, true),

(NULL, 'subscription_renewed', 'en', 'Subscription renewed', '<h2>Hi {name},</h2><p>Your <strong>{plan}</strong> subscription has been renewed. Next billing: {next_date}. Amount: {amount}.</p><p>— {brand}</p>', NULL, true),
(NULL, 'subscription_renewed', 'fa', 'تمدید اشتراک', '<h2>سلام {name}،</h2><p>اشتراک <strong>{plan}</strong> شما تمدید شد. صورتحساب بعدی: {next_date}. مبلغ: {amount}.</p><p>— {brand}</p>', NULL, true),
(NULL, 'subscription_renewed', 'tr', 'Abonelik yenilendi', '<h2>Merhaba {name},</h2><p><strong>{plan}</strong> aboneliğiniz yenilendi. Sonraki fatura: {next_date}. Tutar: {amount}.</p><p>— {brand}</p>', NULL, true),

(NULL, 'subscription_cancelled', 'en', 'Subscription cancelled', '<h2>Hi {name},</h2><p>Your <strong>{plan}</strong> subscription has been cancelled. Access continues until {end_date}.</p><p>— {brand}</p>', NULL, true),
(NULL, 'subscription_cancelled', 'fa', 'لغو اشتراک', '<h2>سلام {name}،</h2><p>اشتراک <strong>{plan}</strong> شما لغو شد. دسترسی تا {end_date} ادامه دارد.</p><p>— {brand}</p>', NULL, true),
(NULL, 'subscription_cancelled', 'tr', 'Abonelik iptal edildi', '<h2>Merhaba {name},</h2><p><strong>{plan}</strong> aboneliğiniz iptal edildi. Erişiminiz {end_date} tarihine kadar devam eder.</p><p>— {brand}</p>', NULL, true),

-- ── Notification ──
(NULL, 'new_conversation', 'en', 'New conversation from {visitor}', '<h2>Hi {name},</h2><p>You have a new conversation from <strong>{visitor}</strong>:</p><blockquote>{message}</blockquote><p><a href="{action_url}">View Conversation</a></p><p>— {brand}</p>', NULL, true),
(NULL, 'new_conversation', 'fa', 'گفتگوی جدید از {visitor}', '<h2>سلام {name}،</h2><p>یک گفتگوی جدید از <strong>{visitor}</strong> دارید:</p><blockquote>{message}</blockquote><p><a href="{action_url}">مشاهده گفتگو</a></p><p>— {brand}</p>', NULL, true),
(NULL, 'new_conversation', 'tr', '{visitor} ''dan yeni görüşme', '<h2>Merhaba {name},</h2><p><strong>{visitor}</strong> ''dan yeni bir görüşmeniz var:</p><blockquote>{message}</blockquote><p><a href="{action_url}">Görüşmeyi Görüntüle</a></p><p>— {brand}</p>', NULL, true),

(NULL, 'task_assigned', 'en', 'Task assigned to you', '<h2>Hi {name},</h2><p><strong>{assigner}</strong> assigned you a task: <strong>{task}</strong></p><p><a href="{action_url}">View Task</a></p><p>— {brand}</p>', NULL, true),
(NULL, 'task_assigned', 'fa', 'وظیفه جدید برای شما', '<h2>سلام {name}،</h2><p><strong>{assigner}</strong> یک وظیفه به شما اختصاص داد: <strong>{task}</strong></p><p><a href="{action_url}">مشاهده وظیفه</a></p><p>— {brand}</p>', NULL, true),
(NULL, 'task_assigned', 'tr', 'Size görev atandı', '<h2>Merhaba {name},</h2><p><strong>{assigner}</strong> size bir görev atadı: <strong>{task}</strong></p><p><a href="{action_url}">Görevi Görüntüle</a></p><p>— {brand}</p>', NULL, true),

(NULL, 'account_expiry', 'en', 'Your account expires soon', '<h2>Hi {name},</h2><p>Your <strong>{plan}</strong> plan expires in <strong>{days_left} days</strong>.</p><p><a href="{action_url}">Renew Now</a></p><p>— {brand}</p>', NULL, true),
(NULL, 'account_expiry', 'fa', 'حساب شما به زودی منقضی می‌شود', '<h2>سلام {name}،</h2><p>پلن <strong>{plan}</strong> شما تا <strong>{days_left} روز</strong> دیگر منقضی می‌شود.</p><p><a href="{action_url}">تمدید اشتراک</a></p><p>— {brand}</p>', NULL, true),
(NULL, 'account_expiry', 'tr', 'Hesabınız yakında sona eriyor', '<h2>Merhaba {name},</h2><p><strong>{plan}</strong> planınız <strong>{days_left} gün</strong> içinde sona eriyor.</p><p><a href="{action_url}">Şimdi Yenile</a></p><p>— {brand}</p>', NULL, true),

(NULL, 'system_alert', 'en', '[{severity}] {title}', '<h2>System Alert</h2><p><strong>{title}</strong></p><p>{message}</p><p>— {brand}</p>', NULL, true),
(NULL, 'system_alert', 'fa', '[{severity}] {title}', '<h2>هشدار سیستم</h2><p><strong>{title}</strong></p><p>{message}</p><p>— {brand}</p>', NULL, true),
(NULL, 'system_alert', 'tr', '[{severity}] {title}', '<h2>Sistem Uyarısı</h2><p><strong>{title}</strong></p><p>{message}</p><p>— {brand}</p>', NULL, true)
ON CONFLICT DO NOTHING;
