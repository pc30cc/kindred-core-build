import Foundation

/// Every piece of user-facing copy in the app.
///
/// This is a `switch` over `Language` rather than a set of `.strings` files on
/// purpose: the compiler refuses to build if a case is missing, so a key can
/// never ship translated in one language and blank in another. The web app's
/// i18n tests exist to catch exactly that; here the type system catches it.
enum Str {

    // MARK: - Common

    static func appName(_ l: Language) -> String {
        switch l {
        case .en, .tr: "Webyar"
        case .fa: "وب‌یار"
        }
    }

    static func cancel(_ l: Language) -> String {
        switch l {
        case .en: "Cancel"
        case .fa: "انصراف"
        case .tr: "İptal"
        }
    }

    static func retry(_ l: Language) -> String {
        switch l {
        case .en: "Try again"
        case .fa: "تلاش دوباره"
        case .tr: "Tekrar dene"
        }
    }

    static func search(_ l: Language) -> String {
        switch l {
        case .en: "Search"
        case .fa: "جست‌وجو"
        case .tr: "Ara"
        }
    }

    // MARK: - Login

    static func loginTitle(_ l: Language) -> String {
        switch l {
        case .en: "Welcome back"
        case .fa: "خوش آمدید"
        case .tr: "Tekrar hoş geldiniz"
        }
    }

    static func loginSubtitle(_ l: Language) -> String {
        switch l {
        case .en: "Sign in to your account"
        case .fa: "وارد حساب کاربری خود شوید"
        case .tr: "Hesabınıza giriş yapın"
        }
    }

    static func emailLabel(_ l: Language) -> String {
        switch l {
        case .en: "Email"
        case .fa: "ایمیل"
        case .tr: "E-posta"
        }
    }

    static func passwordLabel(_ l: Language) -> String {
        switch l {
        case .en: "Password"
        case .fa: "رمز عبور"
        case .tr: "Parola"
        }
    }

    static func logIn(_ l: Language) -> String {
        switch l {
        case .en: "Log in"
        case .fa: "ورود"
        case .tr: "Giriş yap"
        }
    }

    static func forgotPassword(_ l: Language) -> String {
        switch l {
        case .en: "Forgot password?"
        case .fa: "رمز عبور را فراموش کرده‌اید؟"
        case .tr: "Parolanızı mı unuttunuz?"
        }
    }

    static func resetSentTitle(_ l: Language) -> String {
        switch l {
        case .en: "Check your email"
        case .fa: "ایمیل خود را بررسی کنید"
        case .tr: "E-postanızı kontrol edin"
        }
    }

    /// Worded so it does not confirm whether the address has an account —
    /// the endpoint deliberately answers the same either way.
    static func resetSentBody(_ l: Language) -> String {
        switch l {
        case .en: "If that address has an account, a reset link is on its way."
        case .fa: "اگر آن نشانی حسابی داشته باشد، پیوند بازنشانی برایش فرستاده می‌شود."
        case .tr: "Bu adrese ait bir hesap varsa, sıfırlama bağlantısı yolda."
        }
    }

    static func resetNeedsEmail(_ l: Language) -> String {
        switch l {
        case .en: "Enter your email address first."
        case .fa: "نخست نشانی ایمیل خود را وارد کنید."
        case .tr: "Önce e-posta adresinizi girin."
        }
    }

    static func ok(_ l: Language) -> String {
        switch l {
        case .en: "OK"
        case .fa: "باشه"
        case .tr: "Tamam"
        }
    }

    static func loginFailed(_ l: Language) -> String {
        switch l {
        case .en: "Could not sign you in. Check your email and password."
        case .fa: "ورود انجام نشد. ایمیل و رمز عبور را بررسی کنید."
        case .tr: "Giriş yapılamadı. E-posta ve parolanızı kontrol edin."
        }
    }

    // MARK: - Tabs

    static func tabInbox(_ l: Language) -> String {
        switch l {
        case .en: "Inbox"
        case .fa: "صندوق"
        case .tr: "Gelen kutusu"
        }
    }

    static func tabContacts(_ l: Language) -> String {
        switch l {
        case .en: "Contacts"
        case .fa: "مخاطبین"
        case .tr: "Kişiler"
        }
    }

    static func tabSettings(_ l: Language) -> String {
        switch l {
        case .en: "Settings"
        case .fa: "تنظیمات"
        case .tr: "Ayarlar"
        }
    }

    // MARK: - Inbox

    static func filterOpen(_ l: Language) -> String {
        switch l {
        case .en: "Open"
        case .fa: "باز"
        case .tr: "Açık"
        }
    }

    static func filterAI(_ l: Language) -> String {
        switch l {
        case .en: "AI"
        case .fa: "هوش مصنوعی"
        case .tr: "Yapay zekâ"
        }
    }

    static func filterResolved(_ l: Language) -> String {
        switch l {
        case .en: "Resolved"
        case .fa: "حل‌شده"
        case .tr: "Çözüldü"
        }
    }

    static func inboxEmptyTitle(_ l: Language) -> String {
        switch l {
        case .en: "No conversations"
        case .fa: "گفت‌وگویی نیست"
        case .tr: "Görüşme yok"
        }
    }

    static func inboxEmptyBody(_ l: Language) -> String {
        switch l {
        case .en: "New conversations will appear here as visitors reach out."
        case .fa: "گفت‌وگوهای تازه با پیام بازدیدکنندگان همین‌جا ظاهر می‌شوند."
        case .tr: "Ziyaretçiler yazdıkça yeni görüşmeler burada görünür."
        }
    }

    static func markResolved(_ l: Language) -> String {
        switch l {
        case .en: "Resolve"
        case .fa: "حل شد"
        case .tr: "Çöz"
        }
    }

    static func reopen(_ l: Language) -> String {
        switch l {
        case .en: "Reopen"
        case .fa: "بازگشایی"
        case .tr: "Yeniden aç"
        }
    }

    // MARK: - Chat

    static func messagePlaceholder(_ l: Language) -> String {
        switch l {
        case .en: "Message"
        case .fa: "پیام"
        case .tr: "Mesaj"
        }
    }

    static func send(_ l: Language) -> String {
        switch l {
        case .en: "Send"
        case .fa: "ارسال"
        case .tr: "Gönder"
        }
    }

    static func chatEmpty(_ l: Language) -> String {
        switch l {
        case .en: "No messages yet"
        case .fa: "هنوز پیامی نیست"
        case .tr: "Henüz mesaj yok"
        }
    }

    static func aiReply(_ l: Language) -> String {
        switch l {
        case .en: "AI"
        case .fa: "هوش مصنوعی"
        case .tr: "Yapay zekâ"
        }
    }

    static func systemNote(_ l: Language) -> String {
        switch l {
        case .en: "System"
        case .fa: "سیستم"
        case .tr: "Sistem"
        }
    }

    // MARK: - Contacts

    static func contactsEmptyTitle(_ l: Language) -> String {
        switch l {
        case .en: "No contacts"
        case .fa: "مخاطبی نیست"
        case .tr: "Kişi yok"
        }
    }

    static func contactsEmptyBody(_ l: Language) -> String {
        switch l {
        case .en: "People who talk to you are added here automatically."
        case .fa: "کسانی که با شما گفت‌وگو کنند خودکار این‌جا افزوده می‌شوند."
        case .tr: "Sizinle konuşan kişiler buraya otomatik eklenir."
        }
    }

    static func noResults(_ l: Language) -> String {
        switch l {
        case .en: "No results"
        case .fa: "نتیجه‌ای نیست"
        case .tr: "Sonuç yok"
        }
    }

    static func conversationsCount(_ l: Language, _ n: Int) -> String {
        switch l {
        case .en: n == 1 ? "1 conversation" : "\(n) conversations"
        case .fa: "\(n) گفت‌وگو"
        case .tr: "\(n) görüşme"
        }
    }

    // MARK: - Settings

    static func account(_ l: Language) -> String {
        switch l {
        case .en: "Account"
        case .fa: "حساب کاربری"
        case .tr: "Hesap"
        }
    }

    static func language(_ l: Language) -> String {
        switch l {
        case .en: "Language"
        case .fa: "زبان"
        case .tr: "Dil"
        }
    }

    static func workspace(_ l: Language) -> String {
        switch l {
        case .en: "Workspace"
        case .fa: "فضای کاری"
        case .tr: "Çalışma alanı"
        }
    }

    static func about(_ l: Language) -> String {
        switch l {
        case .en: "About"
        case .fa: "درباره"
        case .tr: "Hakkında"
        }
    }

    static func version(_ l: Language) -> String {
        switch l {
        case .en: "Version"
        case .fa: "نسخه"
        case .tr: "Sürüm"
        }
    }

    static func signOut(_ l: Language) -> String {
        switch l {
        case .en: "Sign out"
        case .fa: "خروج از حساب"
        case .tr: "Çıkış yap"
        }
    }

    static func signOutConfirm(_ l: Language) -> String {
        switch l {
        case .en: "Sign out of Webyar?"
        case .fa: "از وب‌یار خارج می‌شوید؟"
        case .tr: "Webyar'dan çıkılsın mı?"
        }
    }

    static func signOutFailed(_ l: Language) -> String {
        switch l {
        case .en: "Sign out failed. You are still signed in."
        case .fa: "خروج انجام نشد. هنوز وارد حساب هستید."
        case .tr: "Çıkış yapılamadı. Hâlâ oturumunuz açık."
        }
    }


    // MARK: - Inbox (plan-gated queues)

    static func filterNeedsHuman(_ l: Language) -> String {
        switch l {
        case .en: "Needs you"
        case .fa: "نیاز به شما"
        case .tr: "Sizi bekliyor"
        }
    }

    static func claim(_ l: Language) -> String {
        switch l {
        case .en: "Assign to me"
        case .fa: "به من بسپار"
        case .tr: "Bana ata"
        }
    }

    static func assignedToYou(_ l: Language) -> String {
        switch l {
        case .en: "Yours"
        case .fa: "مال شما"
        case .tr: "Sizde"
        }
    }

    static func priorityUrgent(_ l: Language) -> String {
        switch l {
        case .en: "Urgent"
        case .fa: "فوری"
        case .tr: "Acil"
        }
    }

    static func priorityHigh(_ l: Language) -> String {
        switch l {
        case .en: "High"
        case .fa: "زیاد"
        case .tr: "Yüksek"
        }
    }

    // MARK: - Call centre

    static func tabCalls(_ l: Language) -> String {
        switch l {
        case .en: "Calls"
        case .fa: "تماس‌ها"
        case .tr: "Aramalar"
        }
    }

    static func callsWaiting(_ l: Language) -> String {
        switch l {
        case .en: "Waiting"
        case .fa: "در انتظار"
        case .tr: "Bekleyen"
        }
    }

    static func callsActive(_ l: Language) -> String {
        switch l {
        case .en: "Active"
        case .fa: "در جریان"
        case .tr: "Aktif"
        }
    }

    static func callsToday(_ l: Language) -> String {
        switch l {
        case .en: "Today"
        case .fa: "امروز"
        case .tr: "Bugün"
        }
    }

    static func callsMissed(_ l: Language) -> String {
        switch l {
        case .en: "Missed"
        case .fa: "بی‌پاسخ"
        case .tr: "Cevapsız"
        }
    }

    static func callsQueueTitle(_ l: Language) -> String {
        switch l {
        case .en: "In the queue"
        case .fa: "در صف"
        case .tr: "Sırada"
        }
    }

    static func callsRecentTitle(_ l: Language) -> String {
        switch l {
        case .en: "Recent calls"
        case .fa: "تماس‌های اخیر"
        case .tr: "Son aramalar"
        }
    }

    static func callsQueueEmpty(_ l: Language) -> String {
        switch l {
        case .en: "Nobody is waiting"
        case .fa: "کسی در صف نیست"
        case .tr: "Bekleyen yok"
        }
    }

    static func callsEmptyBody(_ l: Language) -> String {
        switch l {
        case .en: "Incoming calls appear here the moment someone rings."
        case .fa: "تماس‌های ورودی به‌محض زنگ‌خوردن همین‌جا ظاهر می‌شوند."
        case .tr: "Gelen aramalar biri aradığı anda burada görünür."
        }
    }

    static func callsHistoryEmpty(_ l: Language) -> String {
        switch l {
        case .en: "No calls yet"
        case .fa: "هنوز تماسی نبوده"
        case .tr: "Henüz arama yok"
        }
    }

    // MARK: - Settings (profile & security)

    static func profile(_ l: Language) -> String {
        switch l {
        case .en: "Profile"
        case .fa: "نمایه"
        case .tr: "Profil"
        }
    }

    static func displayName(_ l: Language) -> String {
        switch l {
        case .en: "Name"
        case .fa: "نام"
        case .tr: "Ad"
        }
    }

    static func changePhoto(_ l: Language) -> String {
        switch l {
        case .en: "Change photo"
        case .fa: "تغییر عکس"
        case .tr: "Fotoğrafı değiştir"
        }
    }

    static func removePhoto(_ l: Language) -> String {
        switch l {
        case .en: "Remove photo"
        case .fa: "حذف عکس"
        case .tr: "Fotoğrafı kaldır"
        }
    }

    static func save(_ l: Language) -> String {
        switch l {
        case .en: "Save"
        case .fa: "ذخیره"
        case .tr: "Kaydet"
        }
    }

    static func saved(_ l: Language) -> String {
        switch l {
        case .en: "Saved"
        case .fa: "ذخیره شد"
        case .tr: "Kaydedildi"
        }
    }

    static func saveFailed(_ l: Language) -> String {
        switch l {
        case .en: "Could not save. Try again."
        case .fa: "ذخیره نشد. دوباره تلاش کنید."
        case .tr: "Kaydedilemedi. Tekrar deneyin."
        }
    }

    static func photoTooLarge(_ l: Language) -> String {
        switch l {
        case .en: "That image is too large. Pick a smaller one."
        case .fa: "این تصویر خیلی بزرگ است. کوچک‌تری انتخاب کنید."
        case .tr: "Bu görsel çok büyük. Daha küçüğünü seçin."
        }
    }

    static func security(_ l: Language) -> String {
        switch l {
        case .en: "Security"
        case .fa: "امنیت"
        case .tr: "Güvenlik"
        }
    }

    static func changePassword(_ l: Language) -> String {
        switch l {
        case .en: "Change password"
        case .fa: "تغییر رمز عبور"
        case .tr: "Parolayı değiştir"
        }
    }

    static func currentPassword(_ l: Language) -> String {
        switch l {
        case .en: "Current password"
        case .fa: "رمز عبور فعلی"
        case .tr: "Mevcut parola"
        }
    }

    static func newPassword(_ l: Language) -> String {
        switch l {
        case .en: "New password"
        case .fa: "رمز عبور تازه"
        case .tr: "Yeni parola"
        }
    }

    static func passwordChanged(_ l: Language) -> String {
        switch l {
        case .en: "Password changed"
        case .fa: "رمز عبور عوض شد"
        case .tr: "Parola değiştirildi"
        }
    }

    static func passwordTooShort(_ l: Language) -> String {
        switch l {
        case .en: "Use at least 8 characters."
        case .fa: "دست‌کم ۸ نویسه بگذارید."
        case .tr: "En az 8 karakter kullanın."
        }
    }

    static func activeSessions(_ l: Language) -> String {
        switch l {
        case .en: "Signed-in devices"
        case .fa: "دستگاه‌های واردشده"
        case .tr: "Oturum açık cihazlar"
        }
    }

    static func thisDevice(_ l: Language) -> String {
        switch l {
        case .en: "This device"
        case .fa: "همین دستگاه"
        case .tr: "Bu cihaz"
        }
    }

    static func revokeSession(_ l: Language) -> String {
        switch l {
        case .en: "Sign out this device"
        case .fa: "خروج این دستگاه"
        case .tr: "Bu cihazdan çık"
        }
    }

    static func lastActive(_ l: Language) -> String {
        switch l {
        case .en: "Last active"
        case .fa: "آخرین فعالیت"
        case .tr: "Son etkinlik"
        }
    }

    static func appearance(_ l: Language) -> String {
        switch l {
        case .en: "Appearance"
        case .fa: "ظاهر"
        case .tr: "Görünüm"
        }
    }

    static func appearanceSystem(_ l: Language) -> String {
        switch l {
        case .en: "Match device"
        case .fa: "مطابق دستگاه"
        case .tr: "Cihazla aynı"
        }
    }

    static func appearanceLight(_ l: Language) -> String {
        switch l {
        case .en: "Light"
        case .fa: "روشن"
        case .tr: "Açık"
        }
    }

    static func appearanceDark(_ l: Language) -> String {
        switch l {
        case .en: "Dark"
        case .fa: "تیره"
        case .tr: "Koyu"
        }
    }

    static func plan(_ l: Language) -> String {
        switch l {
        case .en: "Plan"
        case .fa: "پلن"
        case .tr: "Plan"
        }
    }

    static func emailNotVerified(_ l: Language) -> String {
        switch l {
        case .en: "Email not verified"
        case .fa: "ایمیل تأیید نشده"
        case .tr: "E-posta doğrulanmadı"
        }
    }

    // MARK: - Errors

    static func offlineTitle(_ l: Language) -> String {
        switch l {
        case .en: "Can't reach the server"
        case .fa: "دسترسی به سرور ممکن نشد"
        case .tr: "Sunucuya ulaşılamıyor"
        }
    }

    static func offlineBody(_ l: Language) -> String {
        switch l {
        case .en: "Check your connection and try again."
        case .fa: "اتصال خود را بررسی کنید و دوباره تلاش کنید."
        case .tr: "Bağlantınızı kontrol edip tekrar deneyin."
        }
    }

    static func sessionExpired(_ l: Language) -> String {
        switch l {
        case .en: "Your session expired. Please sign in again."
        case .fa: "نشست شما منقضی شد. دوباره وارد شوید."
        case .tr: "Oturumunuzun süresi doldu. Lütfen tekrar giriş yapın."
        }
    }

    static func unknownVisitor(_ l: Language) -> String {
        switch l {
        case .en: "Visitor"
        case .fa: "بازدیدکننده"
        case .tr: "Ziyaretçi"
        }
    }
}
