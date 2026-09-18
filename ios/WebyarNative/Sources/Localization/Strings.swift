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

    /// Short everywhere for the same reason — "هوش مصنوعی" and "Yapay zekâ"
    /// are both too long to sit in a quarter of the control with a count.
    static func filterAI(_ l: Language) -> String {
        switch l {
        case .en: "AI"
        case .fa: "هوش"
        case .tr: "YZ"
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
        // A `let` before the switch means the body is no longer a single
        // expression, so every branch needs its `return` spelled out.
        let text = Format.number(n, language: l)
        switch l {
        case .en: return n == 1 ? "1 conversation" : "\(text) conversations"
        case .fa: return "\(text) گفت‌وگو"
        case .tr: return "\(text) görüşme"
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

    /// Deliberately terse: with four queues and a count beside each, a longer
    /// label truncates mid-word in the segmented control.
    static func filterNeedsHuman(_ l: Language) -> String {
        switch l {
        case .en: "Needs me"
        case .fa: "با شما"
        case .tr: "Sizde"
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


    // MARK: - Composer

    static func attachFile(_ l: Language) -> String {
        switch l {
        case .en: "Attach a file"
        case .fa: "پیوست فایل"
        case .tr: "Dosya ekle"
        }
    }

    static func voiceNote(_ l: Language) -> String {
        switch l {
        case .en: "Voice note"
        case .fa: "پیام صوتی"
        case .tr: "Sesli not"
        }
    }

    static func emoji(_ l: Language) -> String {
        switch l {
        case .en: "Emoji"
        case .fa: "شکلک"
        case .tr: "Emoji"
        }
    }

    /// Explains why the composer offers nothing but text right now.
    static func aiOwnsThread(_ l: Language) -> String {
        switch l {
        case .en: "The AI is answering this conversation. You can reply in text; files, voice notes and emoji resume once you take over."
        case .fa: "هوش مصنوعی در حال پاسخ‌دادن به این گفت‌وگوست. می‌توانید متنی پاسخ دهید؛ فایل و پیام صوتی و شکلک پس از تحویل‌گرفتن گفت‌وگو فعال می‌شوند."
        case .tr: "Bu görüşmeyi yapay zekâ yanıtlıyor. Metin yazabilirsiniz; dosya, sesli not ve emoji siz devraldığınızda etkinleşir."
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

    // The API answers in English whoever is asking — `server/routes/auth.ts`
    // returns "Invalid email or password" to every client, and the server
    // deliberately never reads `Accept-Language`. These are what the operator
    // reads instead of that, chosen by status code.

    static func errorInvalidInput(_ l: Language) -> String {
        switch l {
        case .en: "Something in that request wasn't valid."
        case .fa: "اطلاعات واردشده درست نیست."
        case .tr: "Gönderilen bilgiler geçerli değil."
        }
    }

    static func errorNotAllowed(_ l: Language) -> String {
        switch l {
        case .en: "You don't have access to do that."
        case .fa: "برای این کار دسترسی ندارید."
        case .tr: "Bu işlem için yetkiniz yok."
        }
    }

    static func errorNotFound(_ l: Language) -> String {
        switch l {
        case .en: "That couldn't be found."
        case .fa: "این مورد پیدا نشد."
        case .tr: "Bu kayıt bulunamadı."
        }
    }

    static func errorConflict(_ l: Language) -> String {
        switch l {
        case .en: "That changed since you opened it. Try again."
        case .fa: "این مورد در این فاصله تغییر کرده است. دوباره تلاش کنید."
        case .tr: "Bu kayıt siz açtıktan sonra değişti. Tekrar deneyin."
        }
    }

    static func errorTooManyRequests(_ l: Language) -> String {
        switch l {
        case .en: "Too many attempts. Wait a moment and try again."
        case .fa: "تلاش‌ها بیش از حد بود. کمی صبر کنید و دوباره تلاش کنید."
        case .tr: "Çok fazla deneme yapıldı. Biraz bekleyip tekrar deneyin."
        }
    }

    static func errorServerProblem(_ l: Language) -> String {
        switch l {
        case .en: "The server ran into a problem. Try again shortly."
        case .fa: "سرور به مشکل خورد. کمی بعد دوباره تلاش کنید."
        case .tr: "Sunucuda bir sorun oluştu. Birazdan tekrar deneyin."
        }
    }

    static func errorUnreadableAnswer(_ l: Language) -> String {
        switch l {
        case .en: "The server's answer couldn't be read. Update the app if this keeps happening."
        case .fa: "پاسخ سرور خوانده نشد. اگر تکرار شد، اپ را به‌روز کنید."
        case .tr: "Sunucunun yanıtı okunamadı. Sorun sürerse uygulamayı güncelleyin."
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

// MARK: - Conversation actions
//
// The wording follows the web app's own inbox copy, so an operator who uses
// both does not have to learn two vocabularies for the same four buttons.

extension Str {

    static func filters(_ l: Language) -> String {
        switch l {
        case .en: "Filters"
        case .fa: "پالایه‌ها"
        case .tr: "Filtreler"
        }
    }

    static func clearFilters(_ l: Language) -> String {
        switch l {
        case .en: "Clear"
        case .fa: "پاک کردن"
        case .tr: "Temizle"
        }
    }

    static func apply(_ l: Language) -> String {
        switch l {
        case .en: "Apply"
        case .fa: "اعمال"
        case .tr: "Uygula"
        }
    }

    static func done(_ l: Language) -> String {
        switch l {
        case .en: "Done"
        case .fa: "تمام"
        case .tr: "Bitti"
        }
    }

    static func filterByName(_ l: Language) -> String {
        switch l {
        case .en: "Contact name"
        case .fa: "نام مخاطب"
        case .tr: "Kişi adı"
        }
    }

    static func filterByEmail(_ l: Language) -> String {
        switch l {
        case .en: "Email address"
        case .fa: "نشانی ایمیل"
        case .tr: "E-posta adresi"
        }
    }

    static func filterBySubject(_ l: Language) -> String {
        switch l {
        case .en: "Subject"
        case .fa: "موضوع"
        case .tr: "Konu"
        }
    }

    static func activeFilters(_ count: Int, _ l: Language) -> String {
        let text = Format.number(count, language: l)
        switch l {
        case .en: return count == 1 ? "1 filter" : "\(text) filters"
        case .fa: return "\(text) پالایه"
        case .tr: return "\(text) filtre"
        }
    }

    // MARK: Conversation menu

    static func conversationActions(_ l: Language) -> String {
        switch l {
        case .en: "Conversation"
        case .fa: "گفت‌وگو"
        case .tr: "Görüşme"
        }
    }

    static func transferConversation(_ l: Language) -> String {
        switch l {
        case .en: "Transfer"
        case .fa: "انتقال مکالمه"
        case .tr: "Aktar"
        }
    }

    static func changeStatus(_ l: Language) -> String {
        switch l {
        case .en: "Status"
        case .fa: "وضعیت مکالمه"
        case .tr: "Durum"
        }
    }

    static func changePriority(_ l: Language) -> String {
        switch l {
        case .en: "Priority"
        case .fa: "اولویت"
        case .tr: "Öncelik"
        }
    }

    static func tags(_ l: Language) -> String {
        switch l {
        case .en: "Tags"
        case .fa: "برچسب‌ها"
        case .tr: "Etiketler"
        }
    }

    static func addTag(_ l: Language) -> String {
        switch l {
        case .en: "Add a tag"
        case .fa: "افزودن برچسب"
        case .tr: "Etiket ekle"
        }
    }

    static func noTags(_ l: Language) -> String {
        switch l {
        case .en: "No tags yet"
        case .fa: "هنوز برچسبی نیست"
        case .tr: "Henüz etiket yok"
        }
    }

    static func internalNotes(_ l: Language) -> String {
        switch l {
        case .en: "Internal notes"
        case .fa: "یادداشت داخلی"
        case .tr: "İç notlar"
        }
    }

    static func notesPrivacyNote(_ l: Language) -> String {
        switch l {
        case .en: "Only your team can see these. The visitor never does."
        case .fa: "فقط هم‌تیمی‌های شما این‌ها را می‌بینند؛ بازدیدکننده هرگز."
        case .tr: "Bunları yalnızca ekibiniz görür; ziyaretçi asla görmez."
        }
    }

    static func noNotes(_ l: Language) -> String {
        switch l {
        case .en: "No notes yet"
        case .fa: "هنوز یادداشتی نیست"
        case .tr: "Henüz not yok"
        }
    }

    static func writeNote(_ l: Language) -> String {
        switch l {
        case .en: "Write a note"
        case .fa: "یادداشتی بنویسید"
        case .tr: "Bir not yazın"
        }
    }

    static func unassigned(_ l: Language) -> String {
        switch l {
        case .en: "Unassigned"
        case .fa: "بدون مسئول"
        case .tr: "Atanmamış"
        }
    }

    static func statusPending(_ l: Language) -> String {
        switch l {
        case .en: "Pending"
        case .fa: "در انتظار"
        case .tr: "Beklemede"
        }
    }

    static func statusClosed(_ l: Language) -> String {
        switch l {
        case .en: "Closed"
        case .fa: "بسته"
        case .tr: "Kapalı"
        }
    }

    static func priorityLow(_ l: Language) -> String {
        switch l {
        case .en: "Low"
        case .fa: "کم"
        case .tr: "Düşük"
        }
    }

    static func priorityNormal(_ l: Language) -> String {
        switch l {
        case .en: "Normal"
        case .fa: "عادی"
        case .tr: "Normal"
        }
    }

    // MARK: Calls

    static func voiceCall(_ l: Language) -> String {
        switch l {
        case .en: "Voice call"
        case .fa: "تماس صوتی"
        case .tr: "Sesli arama"
        }
    }

    static func videoCall(_ l: Language) -> String {
        switch l {
        case .en: "Video call"
        case .fa: "تماس تصویری"
        case .tr: "Görüntülü arama"
        }
    }

    static func inviteSent(_ l: Language) -> String {
        switch l {
        case .en: "Waiting for the visitor to accept"
        case .fa: "در انتظار پذیرش بازدیدکننده"
        case .tr: "Ziyaretçinin kabul etmesi bekleniyor"
        }
    }

    static func inviteFailed(_ l: Language) -> String {
        switch l {
        case .en: "The call could not be started"
        case .fa: "تماس آغاز نشد"
        case .tr: "Arama başlatılamadı"
        }
    }
}

// MARK: - A call in progress

extension Str {

    static func connectingCall(_ l: Language) -> String {
        switch l {
        case .en: "Connecting…"
        case .fa: "در حال اتصال…"
        case .tr: "Bağlanıyor…"
        }
    }

    static func hangUpCall(_ l: Language) -> String {
        switch l {
        case .en: "End"
        case .fa: "پایان"
        case .tr: "Bitir"
        }
    }

    static func mute(_ l: Language) -> String {
        switch l {
        case .en: "Mute"
        case .fa: "بی‌صدا"
        case .tr: "Sessiz"
        }
    }

    static func camera(_ l: Language) -> String {
        switch l {
        case .en: "Camera"
        case .fa: "دوربین"
        case .tr: "Kamera"
        }
    }

    static func speaker(_ l: Language) -> String {
        switch l {
        case .en: "Speaker"
        case .fa: "بلندگو"
        case .tr: "Hoparlör"
        }
    }

    static func callEnded(_ l: Language) -> String {
        switch l {
        case .en: "Call ended"
        case .fa: "تماس پایان یافت"
        case .tr: "Arama bitti"
        }
    }

    static func callDeclined(_ l: Language) -> String {
        switch l {
        case .en: "The visitor declined"
        case .fa: "بازدیدکننده نپذیرفت"
        case .tr: "Ziyaretçi reddetti"
        }
    }

    static func callNoAnswer(_ l: Language) -> String {
        switch l {
        case .en: "No answer"
        case .fa: "پاسخی داده نشد"
        case .tr: "Yanıt yok"
        }
    }

    static func callFailed(_ l: Language) -> String {
        switch l {
        case .en: "The call could not connect"
        case .fa: "تماس برقرار نشد"
        case .tr: "Arama bağlanamadı"
        }
    }

    static func callRelayWarning(_ l: Language) -> String {
        switch l {
        case .en: "No relay server configured — this call may fail on some networks"
        case .fa: "سرور رله تنظیم نشده — ممکن است روی بعضی شبکه‌ها برقرار نشود"
        case .tr: "Röle sunucusu tanımlı değil — bazı ağlarda bağlanmayabilir"
        }
    }
}

extension Str {

    static func callNoMicrophone(_ l: Language) -> String {
        switch l {
        case .en: "Your microphone is unavailable — they cannot hear you"
        case .fa: "میکروفون در دسترس نیست — صدای شما را نمی‌شنوند"
        case .tr: "Mikrofonunuz kullanılamıyor — sizi duyamıyorlar"
        }
    }

    static func callNoCamera(_ l: Language) -> String {
        switch l {
        case .en: "Camera unavailable — continuing with audio only"
        case .fa: "دوربین در دسترس نیست — تماس فقط صوتی ادامه دارد"
        case .tr: "Kamera kullanılamıyor — yalnızca sesle devam ediliyor"
        }
    }


    // MARK: - System notices
    //
    // Every one of these is a sentence the *server* already wrote into the
    // message row, in English, frozen at insert time — so the stored body can
    // never follow the reader's language. The web console rebuilds each one
    // from `metadata` for exactly that reason (`src/lib/systemMessageText.ts`)
    // and this is the same copy, key for key, taken from `src/i18n/locales`.
    // Two clients showing the same conversation have to say the same thing.

    static func sysTransferred(_ l: Language, actor: String, to: String) -> String {
        let text: String
        switch l {
        case .en: text = "{actor} transferred this conversation to {to}"
        case .fa: text = "{actor} این گفتگو را به {to} منتقل کرد"
        case .tr: text = "{actor} bu görüşmeyi {to} kişisine aktardı"
        }
        return text
            .replacingOccurrences(of: "{actor}", with: actor)
            .replacingOccurrences(of: "{to}", with: to)
    }

    static func sysUnassigned(_ l: Language, actor: String) -> String {
        let text: String
        switch l {
        case .en: text = "{actor} unassigned this conversation"
        case .fa: text = "{actor} این گفتگو را از حالت واگذارشده خارج کرد"
        case .tr: text = "{actor} bu görüşmenin atamasını kaldırdı"
        }
        return text
            .replacingOccurrences(of: "{actor}", with: actor)
    }

    static func sysAgentJoined(_ l: Language, name: String) -> String {
        let text: String
        switch l {
        case .en: text = "{name} joined the conversation"
        case .fa: text = "{name} به گفتگو پیوست"
        case .tr: text = "{name} sohbete katıldı"
        }
        return text
            .replacingOccurrences(of: "{name}", with: name)
    }

    static func sysAgentJoinedGeneric(_ l: Language) -> String {
        switch l {
        case .en: "A colleague joined the conversation"
        case .fa: "یکی از همکاران به گفتگو پیوست"
        case .tr: "Bir meslektaşımız sohbete katıldı"
        }
    }

    static func sysNoAgentAvailable(_ l: Language) -> String {
        switch l {
        case .en: "All our colleagues are currently busy. Your message was recorded and we'll respond as soon as we can."
        case .fa: "همه همکاران در حال حاضر مشغول هستند. پیام شما ثبت شد و در اولین فرصت پاسخ می‌دهیم."
        case .tr: "Tüm ekibimiz şu anda meşgul. Mesajınız kaydedildi, en kısa sürede yanıtlayacağız."
        }
    }

    static func sysInQueue(_ l: Language) -> String {
        switch l {
        case .en: "You are in the queue — someone will be with you shortly."
        case .fa: "در صف هستید — به‌زودی همکاری پاسخ می‌دهد."
        case .tr: "Sıradasınız — kısa süre içinde bir ekip arkadaşımız yanıtlayacak."
        }
    }

    static func sysCallInviteAudio(_ l: Language) -> String {
        switch l {
        case .en: "Visitor invited to an audio call"
        case .fa: "کاربر به تماس صوتی دعوت شد"
        case .tr: "Ziyaretçi sesli aramaya davet edildi"
        }
    }

    static func sysCallInviteVideo(_ l: Language) -> String {
        switch l {
        case .en: "Visitor invited to a video call"
        case .fa: "کاربر به تماس تصویری دعوت شد"
        case .tr: "Ziyaretçi görüntülü aramaya davet edildi"
        }
    }

    static func sysCallInviteAudioFrom(_ l: Language, op: String) -> String {
        let text: String
        switch l {
        case .en: text = "{op} invited the visitor to an audio call"
        case .fa: text = "{op} کاربر را به تماس صوتی دعوت کرد"
        case .tr: text = "{op} ziyaretçiyi sesli aramaya davet etti"
        }
        return text
            .replacingOccurrences(of: "{op}", with: op)
    }

    static func sysCallInviteVideoFrom(_ l: Language, op: String) -> String {
        let text: String
        switch l {
        case .en: text = "{op} invited the visitor to a video call"
        case .fa: text = "{op} کاربر را به تماس تصویری دعوت کرد"
        case .tr: text = "{op} ziyaretçiyi görüntülü aramaya davet etti"
        }
        return text
            .replacingOccurrences(of: "{op}", with: op)
    }

    static func callEndedByOperator(_ l: Language, duration: String) -> String {
        let text: String
        switch l {
        case .en: text = "Call ended by operator · Duration {duration}"
        case .fa: text = "تماس از طرف اپراتور پایان یافت · مدت مکالمه {duration}"
        case .tr: text = "Görüşme operatör tarafından sonlandırıldı · Süre {duration}"
        }
        return text
            .replacingOccurrences(of: "{duration}", with: duration)
    }

    static func callEndedByVisitor(_ l: Language, duration: String) -> String {
        let text: String
        switch l {
        case .en: text = "Call ended by visitor · Duration {duration}"
        case .fa: text = "تماس از طرف کاربر پایان یافت · مدت مکالمه {duration}"
        case .tr: text = "Görüşme ziyaretçi tarafından sonlandırıldı · Süre {duration}"
        }
        return text
            .replacingOccurrences(of: "{duration}", with: duration)
    }

    static func callEndedBySystem(_ l: Language, duration: String) -> String {
        let text: String
        switch l {
        case .en: text = "Call ended · Duration {duration}"
        case .fa: text = "تماس پایان یافت · مدت مکالمه {duration}"
        case .tr: text = "Görüşme sona erdi · Süre {duration}"
        }
        return text
            .replacingOccurrences(of: "{duration}", with: duration)
    }

    static func callEndedNotConnected(_ l: Language) -> String {
        switch l {
        case .en: "Call did not connect"
        case .fa: "تماس برقرار نشد"
        case .tr: "Görüşme bağlanamadı"
        }
    }

    static func inviteStatusPending(_ l: Language) -> String {
        switch l {
        case .en: "Pending"
        case .fa: "در انتظار"
        case .tr: "Bekliyor"
        }
    }

    static func inviteStatusJoined(_ l: Language) -> String {
        switch l {
        case .en: "Joined"
        case .fa: "پیوست"
        case .tr: "Katıldı"
        }
    }

    static func inviteStatusExpired(_ l: Language) -> String {
        switch l {
        case .en: "Expired"
        case .fa: "منقضی"
        case .tr: "Süresi doldu"
        }
    }

    static func inviteStatusCancelled(_ l: Language) -> String {
        switch l {
        case .en: "Cancelled"
        case .fa: "لغو شد"
        case .tr: "İptal edildi"
        }
    }

    static func inviteStatusDeclined(_ l: Language) -> String {
        switch l {
        case .en: "Declined"
        case .fa: "رد شد"
        case .tr: "Reddedildi"
        }
    }

    static func previewSomeone(_ l: Language) -> String {
        switch l {
        case .en: "A user"
        case .fa: "کاربر"
        case .tr: "Bir kullanıcı"
        }
    }

    static func previewYouSentImage(_ l: Language) -> String {
        switch l {
        case .en: "You sent a photo"
        case .fa: "شما یک تصویر ارسال کردید"
        case .tr: "Bir fotoğraf gönderdiniz"
        }
    }

    static func previewYouSentAudio(_ l: Language) -> String {
        switch l {
        case .en: "You sent a voice message"
        case .fa: "شما یک پیام صوتی ارسال کردید"
        case .tr: "Bir sesli mesaj gönderdiniz"
        }
    }

    static func previewYouSentVideo(_ l: Language) -> String {
        switch l {
        case .en: "You sent a video"
        case .fa: "شما یک ویدیو ارسال کردید"
        case .tr: "Bir video gönderdiniz"
        }
    }

    static func previewYouSentFile(_ l: Language) -> String {
        switch l {
        case .en: "You sent a file"
        case .fa: "شما یک فایل ارسال کردید"
        case .tr: "Bir dosya gönderdiniz"
        }
    }

    static func previewSentByImage(_ l: Language, name: String) -> String {
        let text: String
        switch l {
        case .en: text = "{name} sent a photo"
        case .fa: text = "{name} یک تصویر ارسال کرد"
        case .tr: text = "{name} bir fotoğraf gönderdi"
        }
        return text
            .replacingOccurrences(of: "{name}", with: name)
    }

    static func previewSentByAudio(_ l: Language, name: String) -> String {
        let text: String
        switch l {
        case .en: text = "{name} sent a voice message"
        case .fa: text = "{name} یک پیام صوتی ارسال کرد"
        case .tr: text = "{name} bir sesli mesaj gönderdi"
        }
        return text
            .replacingOccurrences(of: "{name}", with: name)
    }

    static func previewSentByVideo(_ l: Language, name: String) -> String {
        let text: String
        switch l {
        case .en: text = "{name} sent a video"
        case .fa: text = "{name} یک ویدیو ارسال کرد"
        case .tr: text = "{name} bir video gönderdi"
        }
        return text
            .replacingOccurrences(of: "{name}", with: name)
    }

    static func previewSentByFile(_ l: Language, name: String) -> String {
        let text: String
        switch l {
        case .en: text = "{name} sent a file"
        case .fa: text = "{name} یک فایل ارسال کرد"
        case .tr: text = "{name} bir dosya gönderdi"
        }
        return text
            .replacingOccurrences(of: "{name}", with: name)
    }
}
