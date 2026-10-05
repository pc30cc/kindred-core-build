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

    /// The wordmark, which is the same in every language.
    ///
    /// `appName` is translated because it appears inside sentences — a
    /// Persian sentence saying "Webyar" in Latin letters reads as a foreign
    /// word dropped into it. A wordmark is not a word in a sentence: it is
    /// the mark on the product, the same one on the icon, the website and
    /// the invoice, and translating it would make the app look like a
    /// different product depending on who opened it. So it is Latin,
    /// capitalised, everywhere.
    ///
    /// Capitalised specifically because the mark is letter-spaced, and
    /// lowercase letters track badly.
    static let brandWordmark = "WEBYAR"

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

    // MARK: - Password reset (its own screen)
    //
    // `resetSentBody` and `resetNeedsEmail` used to live here and are gone
    // with the alert and the empty-field refusal they belonged to. The screen
    // asks for the address instead of demanding one be already typed, and
    // says where the link went instead of saying that one went somewhere.

    static func resetTitle(_ l: Language) -> String {
        switch l {
        case .en: "Reset your password"
        case .fa: "بازنشانی رمز عبور"
        case .tr: "Parolanızı sıfırlayın"
        }
    }

    static func resetSubtitle(_ l: Language) -> String {
        switch l {
        case .en: "Enter the email address you sign in with. We will send you a link to choose a new password."
        case .fa: "نشانی ایمیلی که با آن وارد می‌شوید را بنویسید. پیوندی برایتان می‌فرستیم تا رمز تازه‌ای انتخاب کنید."
        case .tr: "Giriş yaptığınız e-posta adresini yazın. Yeni bir parola seçmeniz için size bir bağlantı göndereceğiz."
        }
    }

    static func sendResetLink(_ l: Language) -> String {
        switch l {
        case .en: "Send the link"
        case .fa: "ارسال پیوند"
        case .tr: "Bağlantıyı gönder"
        }
    }

    static func backToLogin(_ l: Language) -> String {
        switch l {
        case .en: "Back to sign in"
        case .fa: "بازگشت به ورود"
        case .tr: "Girişe dön"
        }
    }

    /// Shown once the request has gone. Still worded so it does not confirm
    /// whether the address has an account.
    static func resetSentDetail(_ l: Language, email: String) -> String {
        switch l {
        case .en: "If \(email) has an account, a link to choose a new password is on its way. It expires in 24 hours."
        case .fa: "اگر \(email) حسابی داشته باشد، پیوندی برای انتخاب رمز تازه در راه است. این پیوند تا ۲۴ ساعت اعتبار دارد."
        case .tr: "\(email) adresine ait bir hesap varsa, yeni parola seçmeniz için bir bağlantı yolda. Bağlantı 24 saat geçerlidir."
        }
    }

    /// The nudge under the confirmation. People look in the inbox, find
    /// nothing, and conclude it is broken — which is what the spam folder
    /// usually is.
    static func resetCheckSpam(_ l: Language) -> String {
        switch l {
        case .en: "Not there? Check your spam folder."
        case .fa: "نیامد؟ پوشه‌ی هرزنامه را هم ببینید."
        case .tr: "Gelmedi mi? Spam klasörünü de kontrol edin."
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

    // MARK: - Notifications

    static func notifications(_ l: Language) -> String {
        switch l {
        case .en: "Notifications"
        case .fa: "اعلان‌ها"
        case .tr: "Bildirimler"
        }
    }

    // The buttons on a banner. Registered with iOS in the operator's chosen
    // language, not the device's — this app never reads the device language.

    static func pushReply(_ l: Language) -> String {
        switch l {
        case .en: "Reply"
        case .fa: "پاسخ"
        case .tr: "Yanıtla"
        }
    }

    static func pushReplyPlaceholder(_ l: Language) -> String {
        switch l {
        case .en: "Reply…"
        case .fa: "پاسخ…"
        case .tr: "Yanıt…"
        }
    }

    static func pushMarkRead(_ l: Language) -> String {
        switch l {
        case .en: "Mark as read"
        case .fa: "خوانده شد"
        case .tr: "Okundu işaretle"
        }
    }

    static func pushOpen(_ l: Language) -> String {
        switch l {
        case .en: "Open"
        case .fa: "باز کردن"
        case .tr: "Aç"
        }
    }

    // Asking for permission, in our own words, before iOS asks in its.

    static func pushPrimerTitle(_ l: Language) -> String {
        switch l {
        case .en: "Know when a customer writes"
        case .fa: "وقتی مشتری پیام می‌دهد باخبر شوید"
        case .tr: "Bir müşteri yazdığında haberiniz olsun"
        }
    }

    static func pushPrimerBody(_ l: Language) -> String {
        switch l {
        case .en: "Webyar can tell you about new messages, mentions and internal notes — even when the app is closed. You choose exactly which, and you can change it any time in Settings."
        case .fa: "وب‌یار می‌تواند پیام‌های تازه، نام‌بردن‌ها و یادداشت‌های داخلی را به شما خبر دهد — حتی وقتی برنامه بسته است. خودتان انتخاب می‌کنید کدام‌ها، و هر وقت خواستید از تنظیمات عوضش می‌کنید."
        case .tr: "Webyar yeni mesajları, bahsetmeleri ve dahili notları — uygulama kapalıyken bile — size bildirebilir. Hangilerini istediğinizi siz seçersiniz ve istediğiniz zaman Ayarlar'dan değiştirebilirsiniz."
        }
    }

    static func pushTurnOn(_ l: Language) -> String {
        switch l {
        case .en: "Turn on notifications"
        case .fa: "روشن کردن اعلان‌ها"
        case .tr: "Bildirimleri aç"
        }
    }

    static func pushNotNow(_ l: Language) -> String {
        switch l {
        case .en: "Not now"
        case .fa: "الان نه"
        case .tr: "Şimdi değil"
        }
    }

    // The settings screen.

    static func pushDeniedTitle(_ l: Language) -> String {
        switch l {
        case .en: "Notifications are off for Webyar"
        case .fa: "اعلان‌های وب‌یار خاموش است"
        case .tr: "Webyar için bildirimler kapalı"
        }
    }

    /// iOS only ever asks once, so after a refusal the only way back is the
    /// system's own settings. Saying so is better than a switch that does
    /// nothing when tapped.
    static func pushDeniedBody(_ l: Language) -> String {
        switch l {
        case .en: "iOS asks only once. Turn them back on in the Settings app to be told about new messages."
        case .fa: "iOS فقط یک‌بار می‌پرسد. برای باخبر شدن از پیام‌های تازه، آن‌ها را در برنامه‌ی تنظیمات دوباره روشن کنید."
        case .tr: "iOS yalnızca bir kez sorar. Yeni mesajlardan haberdar olmak için Ayarlar uygulamasından yeniden açın."
        }
    }

    static func pushOpenSettings(_ l: Language) -> String {
        switch l {
        case .en: "Open Settings"
        case .fa: "باز کردن تنظیمات"
        case .tr: "Ayarları aç"
        }
    }

    static func pushUnavailable(_ l: Language) -> String {
        switch l {
        case .en: "This workspace has no notification service configured, so nothing will arrive on this phone yet."
        case .fa: "برای این فضای کاری سرویس اعلان تنظیم نشده، پس فعلاً چیزی به این تلفن نمی‌رسد."
        case .tr: "Bu çalışma alanı için bildirim servisi yapılandırılmamış, bu yüzden bu telefona henüz bir şey ulaşmayacak."
        }
    }

    static func pushMuteAll(_ l: Language) -> String {
        switch l {
        case .en: "Pause all notifications"
        case .fa: "توقف همه‌ی اعلان‌ها"
        case .tr: "Tüm bildirimleri duraklat"
        }
    }

    static func pushMuteAllFooter(_ l: Language) -> String {
        switch l {
        case .en: "Nothing is sent to any of your devices while this is on."
        case .fa: "تا وقتی این روشن است، چیزی به هیچ‌کدام از دستگاه‌های شما فرستاده نمی‌شود."
        case .tr: "Bu açıkken hiçbir cihazınıza bir şey gönderilmez."
        }
    }

    static func pushScopeTitle(_ l: Language) -> String {
        switch l {
        case .en: "Tell me about"
        case .fa: "خبرم کن درباره‌ی"
        case .tr: "Şunları bildir"
        }
    }

    static func pushScopeAll(_ l: Language) -> String {
        switch l {
        case .en: "Every conversation"
        case .fa: "همه‌ی گفتگوها"
        case .tr: "Her konuşma"
        }
    }

    static func pushScopeAssigned(_ l: Language) -> String {
        switch l {
        case .en: "Conversations assigned to me"
        case .fa: "گفتگوهایی که به من سپرده شده"
        case .tr: "Bana atanan konuşmalar"
        }
    }

    static func pushScopeMentions(_ l: Language) -> String {
        switch l {
        case .en: "Only when I am mentioned"
        case .fa: "فقط وقتی نام مرا می‌برند"
        case .tr: "Yalnızca benden bahsedildiğinde"
        }
    }

    static func pushScopeNone(_ l: Language) -> String {
        switch l {
        case .en: "Nothing"
        case .fa: "هیچ‌کدام"
        case .tr: "Hiçbiri"
        }
    }

    /// An @mention always gets through the two narrower scopes; saying so
    /// stops "assigned to me" reading as "and nothing else, ever".
    static func pushScopeFooter(_ l: Language) -> String {
        switch l {
        case .en: "Someone mentioning you by name always gets through."
        case .fa: "اگر کسی نام شما را ببرد، همیشه به شما می‌رسد."
        case .tr: "Biri adınızı anarsa her durumda size ulaşır."
        }
    }

    static func pushInternalNotes(_ l: Language) -> String {
        switch l {
        case .en: "Internal notes"
        case .fa: "یادداشت‌های داخلی"
        case .tr: "Dahili notlar"
        }
    }

    /// The kinds of event beyond a customer's message, each with its own
    /// switch on the server.
    static func pushEventsTitle(_ l: Language) -> String {
        switch l {
        case .en: "Also tell me about"
        case .fa: "اعلان این موارد هم بیاید"
        case .tr: "Bunları da bildir"
        }
    }

    static func pushTeamChat(_ l: Language) -> String {
        switch l {
        case .en: "Messages from colleagues"
        case .fa: "پیام‌های همکاران"
        case .tr: "Ekip arkadaşlarından mesajlar"
        }
    }

    static func pushAssignments(_ l: Language) -> String {
        switch l {
        case .en: "Conversations handed to me"
        case .fa: "گفتگوهایی که به من سپرده می‌شود"
        case .tr: "Bana devredilen konuşmalar"
        }
    }

    static func pushEmail(_ l: Language) -> String {
        switch l {
        case .en: "New emails"
        case .fa: "ایمیل‌های جدید"
        case .tr: "Yeni e-postalar"
        }
    }

    /// "Handed to me" covers three different hands, and the AI's is the one
    /// nobody would guess.
    static func pushAssignmentsFooter(_ l: Language) -> String {
        switch l {
        case .en: "By a colleague, by automatic routing, or by the AI when a customer needs a person."
        case .fa: "توسط همکار، تخصیص خودکار، یا هوش مصنوعی وقتی مشتری به اپراتور نیاز دارد."
        case .tr: "Bir ekip arkadaşı, otomatik yönlendirme ya da müşteri bir temsilciye ihtiyaç duyduğunda yapay zekâ tarafından."
        }
    }

    static func pushPrefsLoadFailed(_ l: Language) -> String {
        switch l {
        case .en: "Your notification settings could not be loaded."
        case .fa: "تنظیمات اعلان بارگذاری نشد."
        case .tr: "Bildirim ayarlarınız yüklenemedi."
        }
    }

    static func pushShowPreview(_ l: Language) -> String {
        switch l {
        case .en: "Show the message"
        case .fa: "نمایش متن پیام"
        case .tr: "Mesajı göster"
        }
    }

    /// The preview is withheld by the SERVER when this is off, which is the
    /// only way it can be withheld from a locked screen.
    static func pushShowPreviewFooter(_ l: Language) -> String {
        switch l {
        case .en: "When this is off, the text never leaves the server — the notification only says a message arrived."
        case .fa: "وقتی خاموش باشد، متن پیام اصلاً از سرور بیرون نمی‌آید — اعلان فقط می‌گوید پیامی رسیده است."
        case .tr: "Bu kapalıyken metin sunucudan hiç çıkmaz — bildirim yalnızca bir mesaj geldiğini söyler."
        }
    }

    static func pushSound(_ l: Language) -> String {
        switch l {
        case .en: "Sound"
        case .fa: "صدا"
        case .tr: "Ses"
        }
    }

    /// The two presence switches. Phrased as what the operator wants, not as
    /// the state being tested: "while I am at my desk" is a thing somebody
    /// recognises about their own day; "push when online" is a column name.
    static func pushWhenOnline(_ l: Language) -> String {
        switch l {
        case .en: "While I am at my desk"
        case .fa: "وقتی پشت میزم هستم"
        case .tr: "Masamdayken"
        }
    }

    static func pushWhenOffline(_ l: Language) -> String {
        switch l {
        case .en: "While I am away"
        case .fa: "وقتی دور از میزم هستم"
        case .tr: "Uzaktayken"
        }
    }

    static func pushPresenceFooter(_ l: Language) -> String {
        switch l {
        case .en: "Webyar knows you are at your desk while the web console is open. Turn the first off to keep the phone quiet while you are already answering there."
        case .fa: "وب\u{200C}یار وقتی کنسول وب باز است می\u{200C}داند پشت میزتان هستید. اولی را خاموش کنید تا وقتی همان\u{200C}جا پاسخ می\u{200C}دهید، گوشی ساکت بماند."
        case .tr: "Web konsolu açıkken masanızda olduğunuz bilinir. Orada zaten yanıtlarken telefonun sessiz kalması için ilkini kapatın."
        }
    }

    static func pushQuietHours(_ l: Language) -> String {
        switch l {
        case .en: "Quiet hours"
        case .fa: "ساعت‌های سکوت"
        case .tr: "Sessiz saatler"
        }
    }

    static func pushQuietFrom(_ l: Language) -> String {
        switch l {
        case .en: "From"
        case .fa: "از"
        case .tr: "Başlangıç"
        }
    }

    static func pushQuietTo(_ l: Language) -> String {
        switch l {
        case .en: "Until"
        case .fa: "تا"
        case .tr: "Bitiş"
        }
    }

    static func pushQuietFooter(_ l: Language) -> String {
        switch l {
        case .en: "Nothing arrives inside this window, except someone mentioning you by name."
        case .fa: "در این بازه چیزی نمی‌رسد، مگر اینکه کسی نام شما را ببرد."
        case .tr: "Bu aralıkta, biri adınızı anmadıkça hiçbir şey ulaşmaz."
        }
    }

    static func pushThisDevice(_ l: Language) -> String {
        switch l {
        case .en: "This phone"
        case .fa: "همین تلفن"
        case .tr: "Bu telefon"
        }
    }

    static func pushDeviceRegistered(_ l: Language) -> String {
        switch l {
        case .en: "Registered and able to receive notifications."
        case .fa: "ثبت شده و آماده‌ی دریافت اعلان است."
        case .tr: "Kayıtlı ve bildirim alabilir durumda."
        }
    }

    static func pushDeviceNotRegistered(_ l: Language) -> String {
        switch l {
        case .en: "Not registered yet."
        case .fa: "هنوز ثبت نشده است."
        case .tr: "Henüz kayıtlı değil."
        }
    }

    // MARK: - Deleting the account

    static func deleteAccount(_ l: Language) -> String {
        switch l {
        case .en: "Delete account"
        case .fa: "حذف حساب"
        case .tr: "Hesabı sil"
        }
    }

    static func deleteAccountBody(_ l: Language) -> String {
        switch l {
        case .en: "Your profile, your password, your workspace memberships, your notification preferences and every device you have signed in on are removed. This cannot be undone."
        case .fa: "نمایه، رمز عبور، عضویت‌هایتان در فضاهای کاری، تنظیمات اعلان و همه‌ی دستگاه‌هایی که با آن‌ها وارد شده‌اید پاک می‌شوند. این کار برگشت‌پذیر نیست."
        case .tr: "Profiliniz, parolanız, çalışma alanı üyelikleriniz, bildirim tercihleriniz ve giriş yaptığınız her cihaz kaldırılır. Bu işlem geri alınamaz."
        }
    }

    /// Said plainly, because it is the part people worry about and the part
    /// that is genuinely reassuring.
    static func deleteAccountKeeps(_ l: Language) -> String {
        switch l {
        case .en: "Conversations you handled stay with the workspace — they belong to the customer, not to you — but they stop being attributed to you."
        case .fa: "گفتگوهایی که رسیدگی کرده‌اید در فضای کاری می‌مانند — آن‌ها مال مشتری‌اند، نه شما — ولی دیگر به نام شما ثبت نمی‌شوند."
        case .tr: "İlgilendiğiniz konuşmalar çalışma alanında kalır — müşteriye aittir, size değil — ancak artık size atfedilmez."
        }
    }

    static func deleteAccountConfirmPassword(_ l: Language) -> String {
        switch l {
        case .en: "Enter your password to confirm"
        case .fa: "برای تأیید، رمز عبورتان را وارد کنید"
        case .tr: "Onaylamak için parolanızı girin"
        }
    }

    static func deleteAccountFinal(_ l: Language) -> String {
        switch l {
        case .en: "Delete my account"
        case .fa: "حساب من را حذف کن"
        case .tr: "Hesabımı sil"
        }
    }

    static func deleteAccountWrongPassword(_ l: Language) -> String {
        switch l {
        case .en: "That password is not right."
        case .fa: "این رمز عبور درست نیست."
        case .tr: "Bu parola doğru değil."
        }
    }

    /// The one case the server refuses, and the only one worth a screen of
    /// its own: an owner's profile cascades to their workspaces.
    static func deleteAccountOwnsTitle(_ l: Language) -> String {
        switch l {
        case .en: "Hand these over first"
        case .fa: "اول این‌ها را واگذار کنید"
        case .tr: "Önce bunları devredin"
        }
    }

    static func deleteAccountOwnsBody(_ l: Language, workspaces: String) -> String {
        switch l {
        case .en: "You still own \(workspaces). Deleting your account would take the workspace and everything in it — every conversation, contact and invoice — with it, so ownership has to move to somebody else first. Support will do that for you, and then this will go through."
        case .fa: "هنوز مالک \(workspaces) هستید. حذف حسابتان فضای کاری و هر چیزی که در آن است — هر گفتگو، مخاطب و صورتحساب — را هم با خود می‌برد، پس اول باید مالکیت به شخص دیگری منتقل شود. پشتیبانی این کار را برایتان انجام می‌دهد و بعد از آن حذف انجام می‌شود."
        case .tr: "Hâlâ \(workspaces) alanının sahibisiniz. Hesabınızı silmek çalışma alanını ve içindeki her şeyi — her konuşmayı, kişiyi ve faturayı — birlikte götürür; bu yüzden önce sahipliğin başka birine geçmesi gerekir. Destek bunu sizin için yapar, sonra silme işlemi tamamlanır."
        }
    }

    static func accountDeleted(_ l: Language) -> String {
        switch l {
        case .en: "Your account has been deleted."
        case .fa: "حساب شما حذف شد."
        case .tr: "Hesabınız silindi."
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

    /// What VoiceOver says of the dot on the Inbox tab. A template: `{count}`
    /// is replaced with the number in the reader's digits.
    static func tabUnread(_ l: Language) -> String {
        switch l {
        case .en: "{count} unread"
        case .fa: "{count} خوانده‌نشده"
        case .tr: "{count} okunmamış"
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

    /// The AI queue. In full in Persian — "هوش" alone reads as "intelligence"
    /// rather than as the AI — which the strip has room for because it holds
    /// three segments, not four. "Yapay zekâ" is too long even for a third
    /// of the control with a count, so Turkish keeps its usual "YZ".
    static func filterAI(_ l: Language) -> String {
        switch l {
        case .en: "AI"
        case .fa: "هوش مصنوعی"
        case .tr: "YZ"
        }
    }

    /// The main queue narrowed to threads waiting on the customer, not on us.
    ///
    /// Named for who is being waited on rather than for the status word:
    /// "Pending" alone leaves an operator guessing whose move it is, and the
    /// whole point of the queue is that it is not theirs.
    static func filterPending(_ l: Language) -> String {
        switch l {
        case .en: "Awaiting customer"
        case .fa: "در انتظار مشتری"
        case .tr: "Müşteri bekleniyor"
        }
    }

    static func filterResolved(_ l: Language) -> String {
        switch l {
        case .en: "Resolved"
        case .fa: "حل‌شده"
        case .tr: "Çözüldü"
        }
    }

    static func filterSpam(_ l: Language) -> String {
        switch l {
        case .en: "Spam"
        case .fa: "هرزنامه"
        case .tr: "Spam"
        }
    }

    /// The menu behind the inbox title: every inbox this plan grants.
    static func allInboxes(_ l: Language) -> String {
        switch l {
        case .en: "Inboxes"
        case .fa: "صندوق‌ها"
        case .tr: "Gelen kutuları"
        }
    }

    static func otherInboxes(_ l: Language) -> String {
        switch l {
        case .en: "Other inboxes"
        case .fa: "صندوق‌های دیگر"
        case .tr: "Diğer gelen kutuları"
        }
    }

    // MARK: - Colleagues

    static func colleagues(_ l: Language) -> String {
        switch l {
        case .en: "Colleagues"
        case .fa: "همکاران"
        case .tr: "Meslektaşlar"
        }
    }

    static func colleaguesEmptyTitle(_ l: Language) -> String {
        switch l {
        case .en: "No colleagues yet"
        case .fa: "هنوز همکاری نیست"
        case .tr: "Henüz meslektaş yok"
        }
    }

    static func colleaguesEmptyBody(_ l: Language) -> String {
        switch l {
        case .en: "Operators invited to this workspace appear here."
        case .fa: "اپراتورهایی که به این فضای کاری دعوت شوند اینجا دیده می‌شوند."
        case .tr: "Bu çalışma alanına davet edilen operatörler burada görünür."
        }
    }

    static func colleagueThreadEmpty(_ l: Language) -> String {
        switch l {
        case .en: "No messages yet"
        case .fa: "هنوز پیغامی نیست"
        case .tr: "Henüz mesaj yok"
        }
    }

    // MARK: - Availability

    static func availability(_ l: Language) -> String {
        switch l {
        case .en: "Availability"
        case .fa: "وضعیت دسترس‌پذیری"
        case .tr: "Uygunluk"
        }
    }

    static func availabilitySeenAs(_ l: Language) -> String {
        switch l {
        case .en: "You are currently seen as"
        case .fa: "در حال حاضر شما این‌گونه دیده می‌شوید"
        case .tr: "Şu anda şöyle görünüyorsunuz"
        }
    }

    static func availabilityOnline(_ l: Language) -> String {
        switch l {
        case .en: "Online"
        case .fa: "آنلاین"
        case .tr: "Çevrimiçi"
        }
    }

    static func availabilityOffline(_ l: Language) -> String {
        switch l {
        case .en: "Offline"
        case .fa: "آفلاین"
        case .tr: "Çevrimdışı"
        }
    }

    static func availabilityForceOffline(_ l: Language) -> String {
        switch l {
        case .en: "Force offline (invisible mode)"
        case .fa: "آفلاین اجباری (حالت نامرئی)"
        case .tr: "Zorla çevrimdışı (görünmez mod)"
        }
    }

    static func availabilityForceOfflineHint(_ l: Language) -> String {
        switch l {
        case .en: "You appear offline to visitors whatever your schedule says."
        case .fa: "صرف‌نظر از زمان‌بندی، برای بازدیدکنندگان آفلاین دیده می‌شوید."
        case .tr: "Programınız ne derse desin ziyaretçilere çevrimdışı görünürsünüz."
        }
    }

    static func availabilityWhenUsingApp(_ l: Language) -> String {
        switch l {
        case .en: "Available while I use the app"
        case .fa: "وقتی از برنامه استفاده می‌کنم، در دسترس باشم"
        case .tr: "Uygulamayı kullanırken uygunum"
        }
    }

    static func availabilityWhenUsingAppHint(_ l: Language) -> String {
        switch l {
        case .en: "Marks you online automatically while the app is open."
        case .fa: "تا وقتی برنامه باز است، به‌صورت خودکار آنلاین در نظر گرفته می‌شوید."
        case .tr: "Uygulama açıkken sizi otomatik olarak çevrimiçi işaretler."
        }
    }

    static func availabilitySchedule(_ l: Language) -> String {
        switch l {
        case .en: "Use my weekly schedule"
        case .fa: "از زمان‌بندی هفتگی‌ام استفاده کن"
        case .tr: "Haftalık programımı kullan"
        }
    }

    static func availabilityScheduleHint(_ l: Language) -> String {
        switch l {
        case .en: "The hours themselves are set in the web console."
        case .fa: "خود ساعت‌ها را در کنسول وب تنظیم می‌کنید."
        case .tr: "Saatlerin kendisi web konsolundan ayarlanır."
        }
    }

    static func availabilitySaveFailed(_ l: Language) -> String {
        switch l {
        case .en: "That did not save. Try again."
        case .fa: "ذخیره نشد. دوباره تلاش کنید."
        case .tr: "Kaydedilemedi. Tekrar deneyin."
        }
    }

    // MARK: - Email inbox

    static func emailInbox(_ l: Language) -> String {
        switch l {
        case .en: "Email"
        case .fa: "ایمیل"
        case .tr: "E-posta"
        }
    }

    static func emailEmptyTitle(_ l: Language) -> String {
        switch l {
        case .en: "No email"
        case .fa: "ایمیلی نیست"
        case .tr: "E-posta yok"
        }
    }

    static func emailEmptyBody(_ l: Language) -> String {
        switch l {
        case .en: "New mail in this mailbox will appear here."
        case .fa: "ایمیل‌های تازهٔ این صندوق اینجا نشان داده می‌شوند."
        case .tr: "Bu posta kutusuna gelen yeni e-postalar burada görünür."
        }
    }

    static func emailNotConnectedTitle(_ l: Language) -> String {
        switch l {
        case .en: "Mailbox not connected"
        case .fa: "صندوق ایمیل وصل نیست"
        case .tr: "Posta kutusu bağlı değil"
        }
    }

    static func emailNotConnectedBody(_ l: Language) -> String {
        switch l {
        case .en: "Connect a mailbox in the web console under Email, then it will open here too."
        case .fa: "در کنسول وب، بخش ایمیل، یک صندوق وصل کنید؛ بعد از آن اینجا هم باز می‌شود."
        case .tr: "Web konsolunda E-posta bölümünden bir posta kutusu bağlayın; sonra burada da açılır."
        }
    }

    static func emailNoSubject(_ l: Language) -> String {
        switch l {
        case .en: "(no subject)"
        case .fa: "(بدون موضوع)"
        case .tr: "(konu yok)"
        }
    }

    static func emailReply(_ l: Language) -> String {
        switch l {
        case .en: "Reply"
        case .fa: "پاسخ"
        case .tr: "Yanıtla"
        }
    }

    static func emailReplyPlaceholder(_ l: Language) -> String {
        switch l {
        case .en: "Write a reply"
        case .fa: "پاسخ بنویسید"
        case .tr: "Bir yanıt yazın"
        }
    }

    static func emailSend(_ l: Language) -> String {
        switch l {
        case .en: "Send"
        case .fa: "ارسال"
        case .tr: "Gönder"
        }
    }

    static func emailStar(_ l: Language) -> String {
        switch l {
        case .en: "Star"
        case .fa: "ستاره"
        case .tr: "Yıldız"
        }
    }

    static func emailMarkUnread(_ l: Language) -> String {
        switch l {
        case .en: "Mark as unread"
        case .fa: "علامت خوانده‌نشده"
        case .tr: "Okunmadı olarak işaretle"
        }
    }

    static func emailSendFailed(_ l: Language) -> String {
        switch l {
        case .en: "The reply was not sent. Try again."
        case .fa: "پاسخ فرستاده نشد. دوباره تلاش کنید."
        case .tr: "Yanıt gönderilemedi. Tekrar deneyin."
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

    /// The one way forward for an owner who wants their account removed.
    static func support(_ l: Language) -> String {
        switch l {
        case .en: "Support"
        case .fa: "پشتیبانی"
        case .tr: "Destek"
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

    /// The account form asks for the two parts rather than one "Name": the
    /// route stores a composed `full_name` but accepts `first_name` and
    /// `last_name`, and a family name is optional where a given name is not.
    static func firstName(_ l: Language) -> String {
        switch l {
        case .en: "First name"
        case .fa: "نام"
        case .tr: "Ad"
        }
    }

    static func lastName(_ l: Language) -> String {
        switch l {
        case .en: "Last name"
        case .fa: "نام خانوادگی"
        case .tr: "Soyad"
        }
    }

    static func phoneLabel(_ l: Language) -> String {
        switch l {
        case .en: "Phone number"
        case .fa: "شماره تلفن"
        case .tr: "Telefon numarası"
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

    /// The button on a device row. Short, because it sits at the end of a
    /// line that already says which device — `revokeSession` is the swipe
    /// action's label and says the whole sentence.
    static func signOutDevice(_ l: Language) -> String {
        switch l {
        case .en: "Sign out"
        case .fa: "خروج"
        case .tr: "Çıkış"
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

    // MARK: - Saved replies

    static func shortcuts(_ l: Language) -> String {
        switch l {
        case .en: "Shortcuts"
        case .fa: "میان‌برها"
        case .tr: "Kısayollar"
        }
    }

    static func searchShortcuts(_ l: Language) -> String {
        switch l {
        case .en: "Search shortcuts"
        case .fa: "جست‌وجوی میان‌برها"
        case .tr: "Kısayollarda ara"
        }
    }

    static func shortcutsEmptyTitle(_ l: Language) -> String {
        switch l {
        case .en: "No saved replies yet"
        case .fa: "هنوز پاسخ آماده‌ای نیست"
        case .tr: "Henüz hazır yanıt yok"
        }
    }

    static func shortcutsEmptyBody(_ l: Language) -> String {
        switch l {
        case .en: "Add them in the console under Settings → Shortcuts. Everyone in the workspace can use them."
        case .fa: "در کنسول، از تنظیمات ← میان‌برها اضافه‌شان کنید. همهٔ اعضای فضای کاری می‌توانند از آن‌ها استفاده کنند."
        case .tr: "Konsolda Ayarlar → Kısayollar altından ekleyin. Çalışma alanındaki herkes kullanabilir."
        }
    }

    static func shortcutsUnavailableTitle(_ l: Language) -> String {
        switch l {
        case .en: "Shortcuts are not set up on this server"
        case .fa: "میان‌برها روی این سرور راه‌اندازی نشده‌اند"
        case .tr: "Kısayollar bu sunucuda kurulu değil"
        }
    }

    static func shortcutsUnavailableBody(_ l: Language) -> String {
        switch l {
        case .en: "Your administrator can enable them by bringing the database up to date."
        case .fa: "مدیر سامانه می‌تواند با به‌روزرسانی پایگاه داده فعالشان کند."
        case .tr: "Yöneticiniz veritabanını güncelleyerek etkinleştirebilir."
        }
    }

    static func emoji(_ l: Language) -> String {
        switch l {
        case .en: "Emoji"
        case .fa: "شکلک"
        case .tr: "Emoji"
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

    // MARK: - Offline and storage

    /// Above conversations the phone saved earlier, when the server cannot
    /// be reached right now.
    static func offlineSavedCopy(_ l: Language) -> String {
        switch l {
        case .en: "Offline — showing what was saved on this phone."
        case .fa: "آفلاین — آنچه روی این گوشی ذخیره شده نمایش داده می‌شود."
        case .tr: "Çevrimdışı — bu telefonda kayıtlı olanlar gösteriliyor."
        }
    }

    /// Read aloud for a message that has not reached the server yet.
    static func messageSending(_ l: Language) -> String {
        switch l {
        case .en: "Sending"
        case .fa: "در حال ارسال"
        case .tr: "Gönderiliyor"
        }
    }

    static func storage(_ l: Language) -> String {
        switch l {
        case .en: "Storage"
        case .fa: "فضای ذخیره‌سازی"
        case .tr: "Depolama"
        }
    }

    static func storageConversations(_ l: Language) -> String {
        switch l {
        case .en: "Saved conversations"
        case .fa: "گفتگوهای ذخیره‌شده"
        case .tr: "Kayıtlı konuşmalar"
        }
    }

    static func storageFiles(_ l: Language) -> String {
        switch l {
        case .en: "Files and media"
        case .fa: "فایل‌ها و رسانه‌ها"
        case .tr: "Dosyalar ve medya"
        }
    }

    static func storagePictures(_ l: Language) -> String {
        switch l {
        case .en: "Pictures"
        case .fa: "تصاویر پروفایل"
        case .tr: "Profil resimleri"
        }
    }

    static func storageTotal(_ l: Language) -> String {
        switch l {
        case .en: "Total"
        case .fa: "مجموع"
        case .tr: "Toplam"
        }
    }

    static func storageFooter(_ l: Language) -> String {
        switch l {
        case .en: "Copies kept on this phone so conversations open at once and files are not downloaded twice. Clearing them removes nothing from the server and does not sign you out."
        case .fa: "نسخه‌هایی که روی این گوشی نگه داشته می‌شوند تا گفتگوها فوراً باز شوند و فایل‌ها دوباره دانلود نشوند. پاک کردن آن‌ها چیزی را از سرور حذف نمی‌کند و شما را از حساب خارج نمی‌کند."
        case .tr: "Konuşmaların hemen açılması ve dosyaların iki kez indirilmemesi için bu telefonda tutulan kopyalar. Silmek sunucudan hiçbir şeyi kaldırmaz ve oturumunuzu kapatmaz."
        }
    }

    static func clearCache(_ l: Language) -> String {
        switch l {
        case .en: "Clear Cache"
        case .fa: "پاک کردن حافظهٔ موقت"
        case .tr: "Önbelleği Temizle"
        }
    }

    static func clearCacheConfirm(_ l: Language) -> String {
        switch l {
        case .en: "Remove the copies saved on this phone? They will be downloaded again as needed."
        case .fa: "نسخه‌های ذخیره‌شده روی این گوشی حذف شوند؟ در صورت نیاز دوباره دانلود می‌شوند."
        case .tr: "Bu telefonda kayıtlı kopyalar kaldırılsın mı? Gerektiğinde yeniden indirilecekler."
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

    // MARK: - Device types
    //
    // The server labels a session's device in English — `Desktop`, `Mobile`,
    // `Tablet` — and the console translates those three words rather than
    // showing them raw (`deviceDesktop` and friends in `src/i18n/locales`).
    // Everything else in a device label is a proper noun: macOS, Chrome.

    static func deviceDesktop(_ l: Language) -> String {
        switch l {
        case .en: "Desktop"
        case .fa: "رایانه رومیزی"
        case .tr: "Masaüstü"
        }
    }

    static func deviceMobile(_ l: Language) -> String {
        switch l {
        case .en: "Mobile"
        case .fa: "موبایل"
        case .tr: "Mobil"
        }
    }

    static func deviceTablet(_ l: Language) -> String {
        switch l {
        case .en: "Tablet"
        case .fa: "تبلت"
        case .tr: "Tablet"
        }
    }

    // MARK: - Attachments

    /// Shown while the bytes are on their way. Taken from the console's
    /// `inbox.receivingFile`, so the two read the same.
    static func receivingFile(_ l: Language) -> String {
        switch l {
        case .en: "Receiving…"
        case .fa: "در حال دریافت…"
        case .tr: "Alınıyor…"
        }
    }

    static func attachmentFailed(_ l: Language) -> String {
        switch l {
        case .en: "Could not load this file."
        case .fa: "این فایل بارگیری نشد."
        case .tr: "Bu dosya yüklenemedi."
        }
    }

    /// For a recording in a format this phone has no decoder for — an Opus
    /// voice note from Telegram, say. The file is still there; only playing
    /// it here is not possible.
    static func playbackUnsupported(_ l: Language) -> String {
        switch l {
        case .en: "This format can't be played here."
        case .fa: "این قالب اینجا پخش نمی‌شود."
        case .tr: "Bu biçim burada oynatılamıyor."
        }
    }

    static func photo(_ l: Language) -> String {
        switch l {
        case .en: "Photo"
        case .fa: "تصویر"
        case .tr: "Fotoğraf"
        }
    }

    static func videoFile(_ l: Language) -> String {
        switch l {
        case .en: "Video"
        case .fa: "ویدیو"
        case .tr: "Video"
        }
    }

    static func file(_ l: Language) -> String {
        switch l {
        case .en: "File"
        case .fa: "فایل"
        case .tr: "Dosya"
        }
    }

    static func notNow(_ l: Language) -> String {
        switch l {
        case .en: "Not now"
        case .fa: "الان نه"
        case .tr: "Şimdi değil"
        }
    }

    static func close(_ l: Language) -> String {
        switch l {
        case .en: "Close"
        case .fa: "بستن"
        case .tr: "Kapat"
        }
    }

    /// Byte units. Latin abbreviations in English and Turkish; Persian has its
    /// own words for these and the console uses them.
    static func unitBytes(_ l: Language) -> String {
        switch l {
        case .en, .tr: "B"
        case .fa: "بایت"
        }
    }

    static func unitKilobytes(_ l: Language) -> String {
        switch l {
        case .en, .tr: "KB"
        case .fa: "کیلوبایت"
        }
    }

    static func unitMegabytes(_ l: Language) -> String {
        switch l {
        case .en, .tr: "MB"
        case .fa: "مگابایت"
        }
    }

    // MARK: - Sending a file

    static func sendPhoto(_ l: Language) -> String {
        switch l {
        case .en: "Photo or video"
        case .fa: "تصویر یا ویدیو"
        case .tr: "Fotoğraf veya video"
        }
    }

    static func sendDocument(_ l: Language) -> String {
        switch l {
        case .en: "Document"
        case .fa: "سند"
        case .tr: "Belge"
        }
    }

    static func sendingFile(_ l: Language) -> String {
        switch l {
        case .en: "Sending…"
        case .fa: "در حال ارسال…"
        case .tr: "Gönderiliyor…"
        }
    }

    static func fileTooLarge(_ l: Language) -> String {
        switch l {
        case .en: "That file is over 25 MB."
        case .fa: "این فایل از ۲۵ مگابایت بزرگ‌تر است."
        case .tr: "Bu dosya 25 MB'tan büyük."
        }
    }

    static func fileTypeNotAllowed(_ l: Language) -> String {
        switch l {
        case .en: "That kind of file can't be sent."
        case .fa: "این نوع فایل قابل ارسال نیست."
        case .tr: "Bu tür bir dosya gönderilemez."
        }
    }

    // MARK: - Recording

    static func recording(_ l: Language) -> String {
        switch l {
        case .en: "Recording"
        case .fa: "در حال ضبط"
        case .tr: "Kaydediliyor"
        }
    }

    /// Shown when the microphone was refused. It points at Settings because
    /// that is the only place the answer can be changed once it is given.
    static func microphoneDenied(_ l: Language) -> String {
        switch l {
        case .en: "Allow microphone access in Settings to record a voice note."
        case .fa: "برای ضبط پیام صوتی، دسترسی به میکروفون را در تنظیمات اجازه دهید."
        case .tr: "Sesli mesaj kaydetmek için Ayarlar'dan mikrofon erişimine izin verin."
        }
    }

    static func recordingFailed(_ l: Language) -> String {
        switch l {
        case .en: "Recording could not start."
        case .fa: "ضبط شروع نشد."
        case .tr: "Kayıt başlatılamadı."
        }
    }

    static func discard(_ l: Language) -> String {
        switch l {
        case .en: "Discard"
        case .fa: "دور انداختن"
        case .tr: "At"
        }
    }

    // MARK: - The AI speaking for the operator

    /// The whole of what the field says it is for.
    ///
    /// A question rather than an instruction, and nothing after it: the
    /// operator does not need the mechanism explained every time they open a
    /// thread, and a placeholder that runs to three lines pushes the field
    /// itself off the bottom of a phone.
    static func sayNowPlaceholder(_ l: Language) -> String {
        switch l {
        case .en: "What should the visitor be told?"
        case .fa: "چه چیزی به بازدیدکننده گفته شود؟"
        case .tr: "Ziyaretçiye ne söylensin?"
        }
    }

    /// The line in the AI composer's tool row, as the Mac app has it: what
    /// happens to the operator's words once they are sent.
    static func sayNowHint(_ l: Language) -> String {
        switch l {
        case .en: "The AI rewrites your words and sends them to the visitor now."
        case .fa: "هوش مصنوعی حرف شما را بازنویسی می‌کند و همین حالا برای بازدیدکننده می‌فرستد."
        case .tr: "Yapay zekâ sözlerinizi yeniden yazar ve ziyaretçiye hemen gönderir."
        }
    }

    /// The AI send button, spoken. Its glyph is the AI's sparkles, but a
    /// glyph says nothing to VoiceOver.
    static func sayNowAction(_ l: Language) -> String {
        switch l {
        case .en: "Send with AI"
        case .fa: "ارسال با هوش مصنوعی"
        case .tr: "Yapay zekâ ile gönder"
        }
    }

    static func sayNowSent(_ l: Language) -> String {
        switch l {
        case .en: "The AI sent your message to the visitor"
        case .fa: "پیام با هوش مصنوعی برای بازدیدکننده ارسال شد"
        case .tr: "Mesajınız yapay zekâ ile ziyaretçiye gönderildi"
        }
    }

    static func sayNowFailed(_ l: Language) -> String {
        switch l {
        case .en: "Could not send the message"
        case .fa: "ارسال پیام ممکن نشد"
        case .tr: "Mesaj gönderilemedi"
        }
    }

    /// What the voice button picks, for VoiceOver. Its value is read out
    /// separately, so this names the choice and not the current answer.
    static func sayNowVoice(_ l: Language) -> String {
        switch l {
        case .en: "Voice"
        case .fa: "زبان پیام"
        case .tr: "Mesajın dili"
        }
    }

    static func sayNowVoiceSpecialist(_ l: Language) -> String {
        switch l {
        case .en: "In a specialist's voice"
        case .fa: "از زبان کارشناس"
        case .tr: "Uzman dilinden"
        }
    }

    static func sayNowVoiceAssistant(_ l: Language) -> String {
        switch l {
        case .en: "In the AI's voice"
        case .fa: "از زبان هوش مصنوعی"
        case .tr: "Yapay zekâ dilinden"
        }
    }

    // MARK: - Take over

    static func takeOver(_ l: Language) -> String {
        switch l {
        case .en: "Take over"
        case .fa: "در دست گرفتن"
        case .tr: "Devral"
        }
    }

    static func takenOver(_ l: Language) -> String {
        switch l {
        case .en: "The conversation is yours — the AI has stopped replying."
        case .fa: "مکالمه در اختیار شما قرار گرفت — هوش مصنوعی دیگر پاسخ خودکار نمی‌دهد."
        case .tr: "Görüşme sizde — yapay zekâ artık otomatik yanıt vermiyor."
        }
    }

    static func takeOverFailed(_ l: Language) -> String {
        switch l {
        case .en: "Take-over failed"
        case .fa: "در دست گرفتن ناموفق بود"
        case .tr: "Devralma başarısız oldu"
        }
    }

    // MARK: - Online visitors

    /// The Visitors tab. Short, because it shares the bar with four others.
    static func tabVisitors(_ l: Language) -> String {
        switch l {
        case .en: "Visitors"
        case .fa: "بازدیدکنندگان"
        case .tr: "Ziyaretçiler"
        }
    }

    static func visitorsTitle(_ l: Language) -> String {
        switch l {
        case .en: "Online Visitors"
        case .fa: "بازدیدکنندگان آنلاین"
        case .tr: "Çevrimiçi Ziyaretçiler"
        }
    }

    static func visitorsSubtitle(_ l: Language) -> String {
        switch l {
        case .en: "Real-time visitor intelligence"
        case .fa: "هوش لحظه‌ای بازدیدکنندگان"
        case .tr: "Gerçek zamanlı ziyaretçi zekâsı"
        }
    }

    static func visitorsSearchPrompt(_ l: Language) -> String {
        switch l {
        case .en: "Search by page, country, browser…"
        case .fa: "جست‌وجو بر اساس صفحه، کشور، مرورگر…"
        case .tr: "Sayfa, ülke, tarayıcı ile ara…"
        }
    }

    /// The list half of the list / map switch.
    static func visitorsList(_ l: Language) -> String {
        switch l {
        case .en: "List"
        case .fa: "فهرست"
        case .tr: "Liste"
        }
    }

    static func visitorsMap(_ l: Language) -> String {
        switch l {
        case .en: "Map"
        case .fa: "نقشه"
        case .tr: "Harita"
        }
    }

    static func visitorsFilters(_ l: Language) -> String {
        switch l {
        case .en: "Filters"
        case .fa: "فیلترها"
        case .tr: "Filtreler"
        }
    }

    static func visitorsFilterOnline(_ l: Language) -> String {
        switch l {
        case .en: "Online only"
        case .fa: "فقط آنلاین"
        case .tr: "Yalnızca çevrimiçi"
        }
    }

    static func visitorsFilterInChat(_ l: Language) -> String {
        switch l {
        case .en: "Has conversation"
        case .fa: "دارای گفت‌وگو"
        case .tr: "Sohbeti olan"
        }
    }

    static func visitorsFilterCountry(_ l: Language) -> String {
        switch l {
        case .en: "Country"
        case .fa: "کشور"
        case .tr: "Ülke"
        }
    }

    static func visitorsAllCountries(_ l: Language) -> String {
        switch l {
        case .en: "All countries"
        case .fa: "همه کشورها"
        case .tr: "Tüm ülkeler"
        }
    }

    static func visitorsIncludeOffline(_ l: Language) -> String {
        switch l {
        case .en: "Include offline"
        case .fa: "نمایش آفلاین‌ها"
        case .tr: "Çevrimdışıları göster"
        }
    }

    static func visitorsClearFilters(_ l: Language) -> String {
        switch l {
        case .en: "Clear filters"
        case .fa: "پاک کردن فیلترها"
        case .tr: "Filtreleri temizle"
        }
    }

    static func visitorsStatOnline(_ l: Language) -> String {
        switch l {
        case .en: "Online"
        case .fa: "آنلاین"
        case .tr: "Çevrimiçi"
        }
    }

    static func visitorsStatActive(_ l: Language) -> String {
        switch l {
        case .en: "Active now"
        case .fa: "فعال"
        case .tr: "Şu an aktif"
        }
    }

    static func visitorsStatCountries(_ l: Language) -> String {
        switch l {
        case .en: "Countries"
        case .fa: "کشورها"
        case .tr: "Ülkeler"
        }
    }

    static func visitorsStatPages(_ l: Language) -> String {
        switch l {
        case .en: "Pages"
        case .fa: "صفحات"
        case .tr: "Sayfalar"
        }
    }

    static func visitorsEmptyTitle(_ l: Language) -> String {
        switch l {
        case .en: "No visitors right now"
        case .fa: "بازدیدکننده‌ای حضور ندارد"
        case .tr: "Şu anda ziyaretçi yok"
        }
    }

    static func visitorsEmptyBody(_ l: Language) -> String {
        switch l {
        case .en: "Live visitors browsing your site will appear here."
        case .fa: "بازدیدکنندگانی که همین حالا در سایت شما هستند اینجا نمایش داده می‌شوند."
        case .tr: "Sitenizdeki canlı ziyaretçiler burada görünecek."
        }
    }

    static func visitorsNoResults(_ l: Language) -> String {
        switch l {
        case .en: "No visitors match your filters"
        case .fa: "بازدیدکننده‌ای با این فیلترها یافت نشد"
        case .tr: "Filtrelerinizle eşleşen ziyaretçi yok"
        }
    }

    static func visitorsErrorTitle(_ l: Language) -> String {
        switch l {
        case .en: "Could not load visitors"
        case .fa: "بارگذاری بازدیدکنندگان ناموفق بود"
        case .tr: "Ziyaretçiler yüklenemedi"
        }
    }

    static func visitorsJustNow(_ l: Language) -> String {
        switch l {
        case .en: "just now"
        case .fa: "هم‌اکنون"
        case .tr: "şimdi"
        }
    }

    /// A template: `{n}` is replaced with the number in the reader's digits.
    static func visitorsMinutesAgo(_ l: Language) -> String {
        switch l {
        case .en: "{n}m ago"
        case .fa: "{n} دقیقه پیش"
        case .tr: "{n} dk önce"
        }
    }

    /// A template: `{n}` is replaced with the number in the reader's digits.
    static func visitorsHoursAgo(_ l: Language) -> String {
        switch l {
        case .en: "{n}h ago"
        case .fa: "{n} ساعت پیش"
        case .tr: "{n} sa önce"
        }
    }

    static func visitorsUnknownLocation(_ l: Language) -> String {
        switch l {
        case .en: "Unknown location"
        case .fa: "موقعیت نامشخص"
        case .tr: "Bilinmeyen konum"
        }
    }

    /// Under the map. A template: `{n}` is replaced with the number.
    static func visitorsWithoutLocation(_ l: Language) -> String {
        switch l {
        case .en: "{n} without a known location"
        case .fa: "{n} نفر بدون موقعیت مشخص"
        case .tr: "Konumu bilinmeyen {n} kişi"
        }
    }

    static func visitorStatusOnline(_ l: Language) -> String {
        switch l {
        case .en: "Online"
        case .fa: "آنلاین"
        case .tr: "Çevrimiçi"
        }
    }

    static func visitorStatusIdle(_ l: Language) -> String {
        switch l {
        case .en: "Idle"
        case .fa: "غیرفعال"
        case .tr: "Boşta"
        }
    }

    static func visitorStatusOffline(_ l: Language) -> String {
        switch l {
        case .en: "Offline"
        case .fa: "آفلاین"
        case .tr: "Çevrimdışı"
        }
    }

    static func visitorInChat(_ l: Language) -> String {
        switch l {
        case .en: "In chat"
        case .fa: "در گفت‌وگو"
        case .tr: "Sohbette"
        }
    }

    static func visitorDetails(_ l: Language) -> String {
        switch l {
        case .en: "Visitor details"
        case .fa: "جزئیات بازدیدکننده"
        case .tr: "Ziyaretçi detayları"
        }
    }

    static func visitorCurrentPage(_ l: Language) -> String {
        switch l {
        case .en: "Current page"
        case .fa: "صفحه فعلی"
        case .tr: "Mevcut sayfa"
        }
    }

    static func visitorLocation(_ l: Language) -> String {
        switch l {
        case .en: "Location"
        case .fa: "موقعیت"
        case .tr: "Konum"
        }
    }

    static func visitorIPAddress(_ l: Language) -> String {
        switch l {
        case .en: "IP address"
        case .fa: "آدرس IP"
        case .tr: "IP adresi"
        }
    }

    static func visitorBrowserOS(_ l: Language) -> String {
        switch l {
        case .en: "Browser · OS"
        case .fa: "مرورگر · سیستم‌عامل"
        case .tr: "Tarayıcı · İşletim sistemi"
        }
    }

    static func visitorDevice(_ l: Language) -> String {
        switch l {
        case .en: "Device"
        case .fa: "دستگاه"
        case .tr: "Cihaz"
        }
    }

    static func visitorReferrer(_ l: Language) -> String {
        switch l {
        case .en: "Referrer"
        case .fa: "ارجاع‌دهنده"
        case .tr: "Yönlendiren"
        }
    }

    static func visitorDirect(_ l: Language) -> String {
        switch l {
        case .en: "Direct visit"
        case .fa: "ورود مستقیم"
        case .tr: "Doğrudan ziyaret"
        }
    }

    static func visitorLastActivity(_ l: Language) -> String {
        switch l {
        case .en: "Last activity"
        case .fa: "آخرین فعالیت"
        case .tr: "Son etkinlik"
        }
    }

    static func visitorPageHistory(_ l: Language) -> String {
        switch l {
        case .en: "Page history"
        case .fa: "تاریخچه صفحات"
        case .tr: "Sayfa geçmişi"
        }
    }

    static func visitorPageHistoryEmpty(_ l: Language) -> String {
        switch l {
        case .en: "No page history yet"
        case .fa: "هنوز تاریخچه‌ای ثبت نشده"
        case .tr: "Henüz sayfa geçmişi yok"
        }
    }

    static func visitorEntryPoint(_ l: Language) -> String {
        switch l {
        case .en: "Entry point"
        case .fa: "نقطه ورود"
        case .tr: "Giriş noktası"
        }
    }

    static func visitorJourney(_ l: Language) -> String {
        switch l {
        case .en: "Journey"
        case .fa: "مسیر بازدید"
        case .tr: "Gezinti"
        }
    }

    static func visitorCurrentlyOn(_ l: Language) -> String {
        switch l {
        case .en: "Currently on"
        case .fa: "هم‌اکنون در"
        case .tr: "Şu anda"
        }
    }

    static func visitorStartChat(_ l: Language) -> String {
        switch l {
        case .en: "Start chat"
        case .fa: "شروع گفت‌وگو"
        case .tr: "Sohbet başlat"
        }
    }

    static func visitorOpenChat(_ l: Language) -> String {
        switch l {
        case .en: "Open chat"
        case .fa: "باز کردن گفت‌وگو"
        case .tr: "Sohbeti aç"
        }
    }

    static func visitorCopySession(_ l: Language) -> String {
        switch l {
        case .en: "Copy session ID"
        case .fa: "کپی شناسه نشست"
        case .tr: "Oturum kimliğini kopyala"
        }
    }

    static func visitorCopied(_ l: Language) -> String {
        switch l {
        case .en: "Copied"
        case .fa: "کپی شد"
        case .tr: "Kopyalandı"
        }
    }

    static func visitorChatFailed(_ l: Language) -> String {
        switch l {
        case .en: "The chat could not be opened. Try again in a moment."
        case .fa: "باز کردن گفت‌وگو ممکن نشد. کمی بعد دوباره امتحان کنید."
        case .tr: "Sohbet açılamadı. Birazdan tekrar deneyin."
        }
    }

    /// Over a visitor's page when they dropped off the live list while it was open.
    static func visitorLeft(_ l: Language) -> String {
        switch l {
        case .en: "This visitor has left the site."
        case .fa: "این بازدیدکننده سایت را ترک کرده است."
        case .tr: "Bu ziyaretçi siteden ayrıldı."
        }
    }

    // MARK: - Website analytics

    /// The Analytics tab. Short, because it shares the bar with four others.
    static func tabAnalytics(_ l: Language) -> String {
        switch l {
        case .en: "Analytics"
        case .fa: "آمار"
        case .tr: "Analitik"
        }
    }

    static func analyticsTitle(_ l: Language) -> String {
        switch l {
        case .en: "Website analytics"
        case .fa: "تحلیل وب‌سایت"
        case .tr: "Web sitesi analitiği"
        }
    }

    static func analyticsSubtitle(_ l: Language) -> String {
        switch l {
        case .en: "Visits recorded by the chat widget on your site"
        case .fa: "بازدیدهایی که ویجت گفت‌وگو در سایت شما ثبت می‌کند"
        case .tr: "Sohbet widget'ının sitenizde kaydettiği ziyaretler"
        }
    }

    /// A template: `{count}` is replaced with the number in the reader's digits.
    static func analyticsLiveNow(_ l: Language) -> String {
        switch l {
        case .en: "{count} on the site now"
        case .fa: "{count} نفر هم‌اکنون در سایت"
        case .tr: "Şu an sitede {count} kişi"
        }
    }

    static func analyticsRange7(_ l: Language) -> String {
        switch l {
        case .en: "7 days"
        case .fa: "۷ روز"
        case .tr: "7 gün"
        }
    }

    static func analyticsRange28(_ l: Language) -> String {
        switch l {
        case .en: "28 days"
        case .fa: "۲۸ روز"
        case .tr: "28 gün"
        }
    }

    static func analyticsRange90(_ l: Language) -> String {
        switch l {
        case .en: "90 days"
        case .fa: "۹۰ روز"
        case .tr: "90 gün"
        }
    }

    static func analyticsOverview(_ l: Language) -> String {
        switch l {
        case .en: "Overview"
        case .fa: "نمای کلی"
        case .tr: "Genel bakış"
        }
    }

    static func analyticsOverviewHint(_ l: Language) -> String {
        switch l {
        case .en: "Visitors, visits and time on site"
        case .fa: "بازدیدکننده‌ها، بازدیدها و زمان حضور"
        case .tr: "Ziyaretçiler, ziyaretler ve sitede geçen süre"
        }
    }

    static func analyticsSources(_ l: Language) -> String {
        switch l {
        case .en: "Traffic sources"
        case .fa: "منابع ترافیک"
        case .tr: "Trafik kaynakları"
        }
    }

    static func analyticsSourcesHint(_ l: Language) -> String {
        switch l {
        case .en: "Where your visitors come from"
        case .fa: "بازدیدکننده‌ها از کجا می‌آیند"
        case .tr: "Ziyaretçileriniz nereden geliyor"
        }
    }

    static func analyticsPages(_ l: Language) -> String {
        switch l {
        case .en: "Pages"
        case .fa: "صفحات"
        case .tr: "Sayfalar"
        }
    }

    static func analyticsPagesHint(_ l: Language) -> String {
        switch l {
        case .en: "Most viewed, entry and exit pages"
        case .fa: "پربازدیدترین، صفحات ورود و خروج"
        case .tr: "En çok görüntülenen, giriş ve çıkış sayfaları"
        }
    }

    static func analyticsGeography(_ l: Language) -> String {
        switch l {
        case .en: "Geography"
        case .fa: "جغرافیا"
        case .tr: "Coğrafya"
        }
    }

    static func analyticsGeographyHint(_ l: Language) -> String {
        switch l {
        case .en: "Countries, cities and languages"
        case .fa: "کشورها، شهرها و زبان‌ها"
        case .tr: "Ülkeler, şehirler ve diller"
        }
    }

    static func analyticsTechnology(_ l: Language) -> String {
        switch l {
        case .en: "Devices & browsers"
        case .fa: "دستگاه و مرورگر"
        case .tr: "Cihaz ve tarayıcı"
        }
    }

    static func analyticsTechnologyHint(_ l: Language) -> String {
        switch l {
        case .en: "Device, operating system and browser"
        case .fa: "نوع دستگاه، سیستم‌عامل و مرورگر"
        case .tr: "Cihaz, işletim sistemi ve tarayıcı"
        }
    }

    static func analyticsEvents(_ l: Language) -> String {
        switch l {
        case .en: "Events"
        case .fa: "رویدادها"
        case .tr: "Olaylar"
        }
    }

    static func analyticsEventsHint(_ l: Language) -> String {
        switch l {
        case .en: "Custom events from your site"
        case .fa: "رویدادهای سفارشی سایت شما"
        case .tr: "Sitenizden özel olaylar"
        }
    }

    static func analyticsVisitors(_ l: Language) -> String {
        switch l {
        case .en: "Visitors"
        case .fa: "بازدیدکننده"
        case .tr: "Ziyaretçi"
        }
    }

    static func analyticsSessions(_ l: Language) -> String {
        switch l {
        case .en: "Visits"
        case .fa: "بازدید"
        case .tr: "Ziyaret"
        }
    }

    static func analyticsPageviews(_ l: Language) -> String {
        switch l {
        case .en: "Page views"
        case .fa: "بازدید صفحه"
        case .tr: "Sayfa görüntüleme"
        }
    }

    static func analyticsPagesPerVisit(_ l: Language) -> String {
        switch l {
        case .en: "Pages per visit"
        case .fa: "صفحه در هر بازدید"
        case .tr: "Ziyaret başına sayfa"
        }
    }

    static func analyticsBounceRate(_ l: Language) -> String {
        switch l {
        case .en: "Bounce rate"
        case .fa: "نرخ پرش"
        case .tr: "Hemen çıkma oranı"
        }
    }

    static func analyticsAvgDuration(_ l: Language) -> String {
        switch l {
        case .en: "Avg. time on site"
        case .fa: "میانگین زمان حضور"
        case .tr: "Ort. sitede kalma"
        }
    }

    /// A template: `{count}` is replaced with the number in the reader's digits.
    static func analyticsVsPrevious(_ l: Language) -> String {
        switch l {
        case .en: "Compared with the {count} days before"
        case .fa: "در مقایسه با {count} روز قبل از آن"
        case .tr: "Önceki {count} günle karşılaştırıldığında"
        }
    }

    static func analyticsTrend(_ l: Language) -> String {
        switch l {
        case .en: "Traffic over time"
        case .fa: "روند ترافیک"
        case .tr: "Zaman içinde trafik"
        }
    }

    static func analyticsTopChannels(_ l: Language) -> String {
        switch l {
        case .en: "Top channels"
        case .fa: "کانال‌های برتر"
        case .tr: "En iyi kanallar"
        }
    }

    static func analyticsTopPages(_ l: Language) -> String {
        switch l {
        case .en: "Top pages"
        case .fa: "صفحات برتر"
        case .tr: "En iyi sayfalar"
        }
    }

    static func analyticsVisitsUnit(_ l: Language) -> String {
        switch l {
        case .en: "visits"
        case .fa: "بازدید"
        case .tr: "ziyaret"
        }
    }

    static func analyticsViewsUnit(_ l: Language) -> String {
        switch l {
        case .en: "views"
        case .fa: "بازدید"
        case .tr: "görüntüleme"
        }
    }

    static func analyticsChannel(_ l: Language) -> String {
        switch l {
        case .en: "Channel"
        case .fa: "کانال"
        case .tr: "Kanal"
        }
    }

    static func analyticsSource(_ l: Language) -> String {
        switch l {
        case .en: "Source"
        case .fa: "منبع"
        case .tr: "Kaynak"
        }
    }

    static func analyticsCampaign(_ l: Language) -> String {
        switch l {
        case .en: "Campaign"
        case .fa: "کمپین"
        case .tr: "Kampanya"
        }
    }

    static func analyticsCountry(_ l: Language) -> String {
        switch l {
        case .en: "Country"
        case .fa: "کشور"
        case .tr: "Ülke"
        }
    }

    static func analyticsCity(_ l: Language) -> String {
        switch l {
        case .en: "City"
        case .fa: "شهر"
        case .tr: "Şehir"
        }
    }

    static func analyticsLanguage(_ l: Language) -> String {
        switch l {
        case .en: "Language"
        case .fa: "زبان"
        case .tr: "Dil"
        }
    }

    static func analyticsPagesTop(_ l: Language) -> String {
        switch l {
        case .en: "Most viewed"
        case .fa: "پربازدیدترین"
        case .tr: "En çok görüntülenen"
        }
    }

    static func analyticsPagesEntry(_ l: Language) -> String {
        switch l {
        case .en: "Entry"
        case .fa: "ورود"
        case .tr: "Giriş"
        }
    }

    static func analyticsPagesExit(_ l: Language) -> String {
        switch l {
        case .en: "Exit"
        case .fa: "خروج"
        case .tr: "Çıkış"
        }
    }

    static func analyticsDevice(_ l: Language) -> String {
        switch l {
        case .en: "Device"
        case .fa: "دستگاه"
        case .tr: "Cihaz"
        }
    }

    static func analyticsOS(_ l: Language) -> String {
        switch l {
        case .en: "Operating system"
        case .fa: "سیستم‌عامل"
        case .tr: "İşletim sistemi"
        }
    }

    static func analyticsBrowser(_ l: Language) -> String {
        switch l {
        case .en: "Browser"
        case .fa: "مرورگر"
        case .tr: "Tarayıcı"
        }
    }

    static func analyticsEventCount(_ l: Language) -> String {
        switch l {
        case .en: "Times"
        case .fa: "تعداد"
        case .tr: "Adet"
        }
    }

    static func analyticsEventVisits(_ l: Language) -> String {
        switch l {
        case .en: "Visits"
        case .fa: "بازدید"
        case .tr: "Ziyaret"
        }
    }

    static func analyticsConversion(_ l: Language) -> String {
        switch l {
        case .en: "Conversion"
        case .fa: "نرخ تبدیل"
        case .tr: "Dönüşüm"
        }
    }

    static func analyticsNoData(_ l: Language) -> String {
        switch l {
        case .en: "No visits in this range yet"
        case .fa: "در این بازه هنوز بازدیدی نیست"
        case .tr: "Bu aralıkta henüz ziyaret yok"
        }
    }

    static func analyticsNoDataHint(_ l: Language) -> String {
        switch l {
        case .en: "The chat widget's snippet records every page view on your site; they show up here."
        case .fa: "اسکریپت ویجت گفت‌وگو هر بازدید صفحه در سایت شما را ثبت می‌کند و اینجا نمایش داده می‌شود."
        case .tr: "Sohbet widget'ının kodu sitenizdeki her sayfa görüntülemeyi kaydeder; burada görünür."
        }
    }

    static func analyticsNoEvents(_ l: Language) -> String {
        switch l {
        case .en: "No custom events yet"
        case .fa: "هنوز رویداد سفارشی‌ای نیست"
        case .tr: "Henüz özel olay yok"
        }
    }

    static func analyticsNoEventsHint(_ l: Language) -> String {
        switch l {
        case .en: "Send them from your site with window.gsAnalytics.track('name')."
        case .fa: "از سایت خود با window.gsAnalytics.track('name') رویداد بفرستید."
        case .tr: "Sitenizden window.gsAnalytics.track('ad') ile gönderin."
        }
    }

    static func analyticsLocked(_ l: Language) -> String {
        switch l {
        case .en: "Website analytics is not in your plan"
        case .fa: "تحلیل وب‌سایت در پلن شما نیست"
        case .tr: "Web sitesi analitiği planınızda yok"
        }
    }

    static func analyticsLockedHint(_ l: Language) -> String {
        switch l {
        case .en: "Ask the workspace owner about access to website analytics."
        case .fa: "برای دسترسی به تحلیل وب‌سایت با مالک فضای کاری هماهنگ کنید."
        case .tr: "Web sitesi analitiğine erişim için çalışma alanı sahibine danışın."
        }
    }

    static func analyticsLoadFailed(_ l: Language) -> String {
        switch l {
        case .en: "This report could not be loaded."
        case .fa: "این گزارش بارگذاری نشد."
        case .tr: "Bu rapor yüklenemedi."
        }
    }

    static func analyticsTruncated(_ l: Language) -> String {
        switch l {
        case .en: "This range is very busy, so these numbers are from a sample of it."
        case .fa: "این بازه خیلی پرترافیک است؛ اعداد از نمونه‌ای از آن محاسبه شده‌اند."
        case .tr: "Bu aralık çok yoğun; rakamlar bir örneklemden hesaplandı."
        }
    }

    static func analyticsUnknown(_ l: Language) -> String {
        switch l {
        case .en: "Unknown"
        case .fa: "نامشخص"
        case .tr: "Bilinmiyor"
        }
    }

    static func analyticsTotal(_ l: Language) -> String {
        switch l {
        case .en: "Total"
        case .fa: "مجموع"
        case .tr: "Toplam"
        }
    }

    static func analyticsLeader(_ l: Language) -> String {
        switch l {
        case .en: "Top"
        case .fa: "در صدر"
        case .tr: "Zirvede"
        }
    }

    static func analyticsDistinct(_ l: Language) -> String {
        switch l {
        case .en: "Different items"
        case .fa: "تعداد موارد"
        case .tr: "Farklı öğe"
        }
    }

    /// After a number of minutes in a duration: 2m 14s.
    static func analyticsMinutesShort(_ l: Language) -> String {
        switch l {
        case .en: "m"
        case .fa: "دقیقه"
        case .tr: "dk"
        }
    }

    /// After a number of seconds in a duration: 2m 14s.
    static func analyticsSecondsShort(_ l: Language) -> String {
        switch l {
        case .en: "s"
        case .fa: "ثانیه"
        case .tr: "sn"
        }
    }

    static func analyticsChannelDirect(_ l: Language) -> String {
        switch l {
        case .en: "Direct"
        case .fa: "مستقیم"
        case .tr: "Doğrudan"
        }
    }

    static func analyticsChannelOrganicSearch(_ l: Language) -> String {
        switch l {
        case .en: "Organic search"
        case .fa: "جست‌وجوی ارگانیک"
        case .tr: "Organik arama"
        }
    }

    static func analyticsChannelOrganicSocial(_ l: Language) -> String {
        switch l {
        case .en: "Organic social"
        case .fa: "شبکه‌های اجتماعی"
        case .tr: "Organik sosyal"
        }
    }

    static func analyticsChannelReferral(_ l: Language) -> String {
        switch l {
        case .en: "Referral"
        case .fa: "ارجاع از سایت‌ها"
        case .tr: "Yönlendirme"
        }
    }

    static func analyticsChannelPaidSearch(_ l: Language) -> String {
        switch l {
        case .en: "Paid search"
        case .fa: "جست‌وجوی پولی"
        case .tr: "Ücretli arama"
        }
    }

    static func analyticsChannelPaidSocial(_ l: Language) -> String {
        switch l {
        case .en: "Paid social"
        case .fa: "تبلیغات شبکه‌های اجتماعی"
        case .tr: "Ücretli sosyal"
        }
    }

    static func analyticsChannelEmail(_ l: Language) -> String {
        switch l {
        case .en: "Email"
        case .fa: "ایمیل"
        case .tr: "E-posta"
        }
    }

    static func analyticsChannelOther(_ l: Language) -> String {
        switch l {
        case .en: "Other"
        case .fa: "سایر"
        case .tr: "Diğer"
        }
    }

    static func analyticsDeviceMobile(_ l: Language) -> String {
        switch l {
        case .en: "Mobile"
        case .fa: "موبایل"
        case .tr: "Mobil"
        }
    }

    static func analyticsDeviceDesktop(_ l: Language) -> String {
        switch l {
        case .en: "Desktop"
        case .fa: "دسکتاپ"
        case .tr: "Masaüstü"
        }
    }

    static func analyticsDeviceTablet(_ l: Language) -> String {
        switch l {
        case .en, .tr: "Tablet"
        case .fa: "تبلت"
        }
    }
}
