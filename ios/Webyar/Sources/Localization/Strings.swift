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
        case .en, .tr, .ar: "Webyar"
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
        case .ar: "إلغاء"
        }
    }

    static func retry(_ l: Language) -> String {
        switch l {
        case .en: "Try again"
        case .fa: "تلاش دوباره"
        case .tr: "Tekrar dene"
        case .ar: "إعادة المحاولة"
        }
    }

    static func search(_ l: Language) -> String {
        switch l {
        case .en: "Search"
        case .fa: "جست‌وجو"
        case .tr: "Ara"
        case .ar: "بحث"
        }
    }

    // MARK: - Login

    static func loginTitle(_ l: Language) -> String {
        switch l {
        case .en: "Welcome back"
        case .fa: "خوش آمدید"
        case .tr: "Tekrar hoş geldiniz"
        case .ar: "مرحبًا بعودتك"
        }
    }

    static func loginSubtitle(_ l: Language) -> String {
        switch l {
        case .en: "Sign in to your account"
        case .fa: "وارد حساب کاربری خود شوید"
        case .tr: "Hesabınıza giriş yapın"
        case .ar: "سجّل الدخول إلى حسابك"
        }
    }

    static func emailLabel(_ l: Language) -> String {
        switch l {
        case .en: "Email"
        case .fa: "ایمیل"
        case .tr: "E-posta"
        case .ar: "البريد الإلكتروني"
        }
    }

    static func passwordLabel(_ l: Language) -> String {
        switch l {
        case .en: "Password"
        case .fa: "رمز عبور"
        case .tr: "Parola"
        case .ar: "كلمة المرور"
        }
    }

    static func logIn(_ l: Language) -> String {
        switch l {
        case .en: "Log in"
        case .fa: "ورود"
        case .tr: "Giriş yap"
        case .ar: "تسجيل الدخول"
        }
    }

    static func forgotPassword(_ l: Language) -> String {
        switch l {
        case .en: "Forgot password?"
        case .fa: "رمز عبور را فراموش کرده‌اید؟"
        case .tr: "Parolanızı mı unuttunuz?"
        case .ar: "نسيت كلمة المرور؟"
        }
    }

    static func resetSentTitle(_ l: Language) -> String {
        switch l {
        case .en: "Check your email"
        case .fa: "ایمیل خود را بررسی کنید"
        case .tr: "E-postanızı kontrol edin"
        case .ar: "تحقّق من بريدك الإلكتروني"
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
        case .ar: "إعادة تعيين كلمة المرور"
        }
    }

    static func resetSubtitle(_ l: Language) -> String {
        switch l {
        case .en: "Enter the email address you sign in with. We will send you a link to choose a new password."
        case .fa: "نشانی ایمیلی که با آن وارد می‌شوید را بنویسید. پیوندی برایتان می‌فرستیم تا رمز تازه‌ای انتخاب کنید."
        case .tr: "Giriş yaptığınız e-posta adresini yazın. Yeni bir parola seçmeniz için size bir bağlantı göndereceğiz."
        case .ar: "أدخل عنوان البريد الإلكتروني الذي تسجّل الدخول به، وسنرسل إليك رابطًا لاختيار كلمة مرور جديدة."
        }
    }

    static func sendResetLink(_ l: Language) -> String {
        switch l {
        case .en: "Send the link"
        case .fa: "ارسال پیوند"
        case .tr: "Bağlantıyı gönder"
        case .ar: "إرسال الرابط"
        }
    }

    static func backToLogin(_ l: Language) -> String {
        switch l {
        case .en: "Back to sign in"
        case .fa: "بازگشت به ورود"
        case .tr: "Girişe dön"
        case .ar: "العودة إلى تسجيل الدخول"
        }
    }

    /// Shown once the request has gone. Still worded so it does not confirm
    /// whether the address has an account.
    static func resetSentDetail(_ l: Language, email: String) -> String {
        switch l {
        case .en: "If \(email) has an account, a link to choose a new password is on its way. It expires in 24 hours."
        case .fa: "اگر \(email) حسابی داشته باشد، پیوندی برای انتخاب رمز تازه در راه است. این پیوند تا ۲۴ ساعت اعتبار دارد."
        case .tr: "\(email) adresine ait bir hesap varsa, yeni parola seçmeniz için bir bağlantı yolda. Bağlantı 24 saat geçerlidir."
        case .ar: "إذا كان للعنوان \(email) حساب، فإن رابطًا لاختيار كلمة مرور جديدة في الطريق إليك. تنتهي صلاحيته خلال ٢٤ ساعة."
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
        case .ar: "لم تجده؟ تحقّق من مجلد البريد العشوائي."
        }
    }

    static func ok(_ l: Language) -> String {
        switch l {
        case .en: "OK"
        case .fa: "باشه"
        case .tr: "Tamam"
        case .ar: "حسنًا"
        }
    }

    static func loginFailed(_ l: Language) -> String {
        switch l {
        case .en: "Could not sign you in. Check your email and password."
        case .fa: "ورود انجام نشد. ایمیل و رمز عبور را بررسی کنید."
        case .tr: "Giriş yapılamadı. E-posta ve parolanızı kontrol edin."
        case .ar: "تعذّر تسجيل دخولك. تحقّق من البريد الإلكتروني وكلمة المرور."
        }
    }

    // MARK: - Notifications

    static func notifications(_ l: Language) -> String {
        switch l {
        case .en: "Notifications"
        case .fa: "اعلان‌ها"
        case .tr: "Bildirimler"
        case .ar: "الإشعارات"
        }
    }

    // The buttons on a banner. Registered with iOS in the operator's chosen
    // language, not the device's — this app never reads the device language.

    static func pushReply(_ l: Language) -> String {
        switch l {
        case .en: "Reply"
        case .fa: "پاسخ"
        case .tr: "Yanıtla"
        case .ar: "رد"
        }
    }

    static func pushReplyPlaceholder(_ l: Language) -> String {
        switch l {
        case .en: "Reply…"
        case .fa: "پاسخ…"
        case .tr: "Yanıt…"
        case .ar: "رد…"
        }
    }

    static func pushMarkRead(_ l: Language) -> String {
        switch l {
        case .en: "Mark as read"
        case .fa: "خوانده شد"
        case .tr: "Okundu işaretle"
        case .ar: "تعليم كمقروءة"
        }
    }

    static func pushOpen(_ l: Language) -> String {
        switch l {
        case .en: "Open"
        case .fa: "باز کردن"
        case .tr: "Aç"
        case .ar: "فتح"
        }
    }

    // Asking for permission, in our own words, before iOS asks in its.

    static func pushPrimerTitle(_ l: Language) -> String {
        switch l {
        case .en: "Know when a customer writes"
        case .fa: "وقتی مشتری پیام می‌دهد باخبر شوید"
        case .tr: "Bir müşteri yazdığında haberiniz olsun"
        case .ar: "اعرف متى يكتب إليك عميل"
        }
    }

    static func pushPrimerBody(_ l: Language) -> String {
        switch l {
        case .en: "Webyar can tell you about new messages, mentions and internal notes — even when the app is closed. You choose exactly which, and you can change it any time in Settings."
        case .fa: "وب‌یار می‌تواند پیام‌های تازه، نام‌بردن‌ها و یادداشت‌های داخلی را به شما خبر دهد — حتی وقتی برنامه بسته است. خودتان انتخاب می‌کنید کدام‌ها، و هر وقت خواستید از تنظیمات عوضش می‌کنید."
        case .tr: "Webyar yeni mesajları, bahsetmeleri ve dahili notları — uygulama kapalıyken bile — size bildirebilir. Hangilerini istediğinizi siz seçersiniz ve istediğiniz zaman Ayarlar'dan değiştirebilirsiniz."
        case .ar: "يمكن لـ Webyar إعلامك بالرسائل الجديدة والإشارات والملاحظات الداخلية — حتى عندما يكون التطبيق مغلقًا. أنت تختار ما تريده بالضبط، ويمكنك تغييره في أي وقت من الإعدادات."
        }
    }

    static func pushTurnOn(_ l: Language) -> String {
        switch l {
        case .en: "Turn on notifications"
        case .fa: "روشن کردن اعلان‌ها"
        case .tr: "Bildirimleri aç"
        case .ar: "تفعيل الإشعارات"
        }
    }

    static func pushNotNow(_ l: Language) -> String {
        switch l {
        case .en: "Not now"
        case .fa: "الان نه"
        case .tr: "Şimdi değil"
        case .ar: "ليس الآن"
        }
    }

    // The settings screen.

    static func pushDeniedTitle(_ l: Language) -> String {
        switch l {
        case .en: "Notifications are off for Webyar"
        case .fa: "اعلان‌های وب‌یار خاموش است"
        case .tr: "Webyar için bildirimler kapalı"
        case .ar: "الإشعارات متوقفة لتطبيق Webyar"
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
        case .ar: "لا يسأل iOS إلا مرة واحدة. أعد تشغيلها من تطبيق الإعدادات ليصلك إشعار بالرسائل الجديدة."
        }
    }

    static func pushOpenSettings(_ l: Language) -> String {
        switch l {
        case .en: "Open Settings"
        case .fa: "باز کردن تنظیمات"
        case .tr: "Ayarları aç"
        case .ar: "فتح الإعدادات"
        }
    }

    static func pushUnavailable(_ l: Language) -> String {
        switch l {
        case .en: "This workspace has no notification service configured, so nothing will arrive on this phone yet."
        case .fa: "برای این فضای کاری سرویس اعلان تنظیم نشده، پس فعلاً چیزی به این تلفن نمی‌رسد."
        case .tr: "Bu çalışma alanı için bildirim servisi yapılandırılmamış, bu yüzden bu telefona henüz bir şey ulaşmayacak."
        case .ar: "لم تُهيَّأ خدمة إشعارات لمساحة العمل هذه، لذا لن يصل شيء إلى هذا الهاتف بعد."
        }
    }

    static func pushMuteAll(_ l: Language) -> String {
        switch l {
        case .en: "Pause all notifications"
        case .fa: "توقف همه‌ی اعلان‌ها"
        case .tr: "Tüm bildirimleri duraklat"
        case .ar: "إيقاف جميع الإشعارات مؤقتًا"
        }
    }

    static func pushMuteAllFooter(_ l: Language) -> String {
        switch l {
        case .en: "Nothing is sent to any of your devices while this is on."
        case .fa: "تا وقتی این روشن است، چیزی به هیچ‌کدام از دستگاه‌های شما فرستاده نمی‌شود."
        case .tr: "Bu açıkken hiçbir cihazınıza bir şey gönderilmez."
        case .ar: "لا يُرسَل أي شيء إلى أي من أجهزتك ما دام هذا الخيار مفعّلًا."
        }
    }

    static func pushScopeTitle(_ l: Language) -> String {
        switch l {
        case .en: "Tell me about"
        case .fa: "خبرم کن درباره‌ی"
        case .tr: "Şunları bildir"
        case .ar: "أعلمني بـ"
        }
    }

    static func pushScopeAll(_ l: Language) -> String {
        switch l {
        case .en: "Every conversation"
        case .fa: "همه‌ی گفتگوها"
        case .tr: "Her konuşma"
        case .ar: "كل المحادثات"
        }
    }

    static func pushScopeAssigned(_ l: Language) -> String {
        switch l {
        case .en: "Conversations assigned to me"
        case .fa: "گفتگوهایی که به من سپرده شده"
        case .tr: "Bana atanan konuşmalar"
        case .ar: "المحادثات المسندة إليّ"
        }
    }

    static func pushScopeMentions(_ l: Language) -> String {
        switch l {
        case .en: "Only when I am mentioned"
        case .fa: "فقط وقتی نام مرا می‌برند"
        case .tr: "Yalnızca benden bahsedildiğinde"
        case .ar: "فقط عند الإشارة إليّ"
        }
    }

    static func pushScopeNone(_ l: Language) -> String {
        switch l {
        case .en: "Nothing"
        case .fa: "هیچ‌کدام"
        case .tr: "Hiçbiri"
        case .ar: "لا شيء"
        }
    }

    /// An @mention always gets through the two narrower scopes; saying so
    /// stops "assigned to me" reading as "and nothing else, ever".
    static func pushScopeFooter(_ l: Language) -> String {
        switch l {
        case .en: "Someone mentioning you by name always gets through."
        case .fa: "اگر کسی نام شما را ببرد، همیشه به شما می‌رسد."
        case .tr: "Biri adınızı anarsa her durumda size ulaşır."
        case .ar: "الإشارة إليك بالاسم تصلك دائمًا."
        }
    }

    static func pushInternalNotes(_ l: Language) -> String {
        switch l {
        case .en: "Internal notes"
        case .fa: "یادداشت‌های داخلی"
        case .tr: "Dahili notlar"
        case .ar: "الملاحظات الداخلية"
        }
    }

    /// The kinds of event beyond a customer's message, each with its own
    /// switch on the server.
    static func pushEventsTitle(_ l: Language) -> String {
        switch l {
        case .en: "Also tell me about"
        case .fa: "اعلان این موارد هم بیاید"
        case .tr: "Bunları da bildir"
        case .ar: "أعلمني أيضًا بـ"
        }
    }

    static func pushTeamChat(_ l: Language) -> String {
        switch l {
        case .en: "Messages from colleagues"
        case .fa: "پیام‌های همکاران"
        case .tr: "Ekip arkadaşlarından mesajlar"
        case .ar: "رسائل الزملاء"
        }
    }

    static func pushAssignments(_ l: Language) -> String {
        switch l {
        case .en: "Conversations handed to me"
        case .fa: "گفتگوهایی که به من سپرده می‌شود"
        case .tr: "Bana devredilen konuşmalar"
        case .ar: "المحادثات المحوّلة إليّ"
        }
    }

    static func pushEmail(_ l: Language) -> String {
        switch l {
        case .en: "New emails"
        case .fa: "ایمیل‌های جدید"
        case .tr: "Yeni e-postalar"
        case .ar: "رسائل البريد الجديدة"
        }
    }

    /// "Handed to me" covers three different hands, and the AI's is the one
    /// nobody would guess.
    static func pushAssignmentsFooter(_ l: Language) -> String {
        switch l {
        case .en: "By a colleague, by automatic routing, or by the AI when a customer needs a person."
        case .fa: "توسط همکار، تخصیص خودکار، یا هوش مصنوعی وقتی مشتری به اپراتور نیاز دارد."
        case .tr: "Bir ekip arkadaşı, otomatik yönlendirme ya da müşteri bir temsilciye ihtiyaç duyduğunda yapay zekâ tarafından."
        case .ar: "من زميل، أو بالتوزيع التلقائي، أو من الذكاء الاصطناعي عندما يحتاج العميل إلى شخص."
        }
    }

    static func pushPrefsLoadFailed(_ l: Language) -> String {
        switch l {
        case .en: "Your notification settings could not be loaded."
        case .fa: "تنظیمات اعلان بارگذاری نشد."
        case .tr: "Bildirim ayarlarınız yüklenemedi."
        case .ar: "تعذّر تحميل إعدادات الإشعارات."
        }
    }

    static func pushShowPreview(_ l: Language) -> String {
        switch l {
        case .en: "Show the message"
        case .fa: "نمایش متن پیام"
        case .tr: "Mesajı göster"
        case .ar: "إظهار نص الرسالة"
        }
    }

    /// The preview is withheld by the SERVER when this is off, which is the
    /// only way it can be withheld from a locked screen.
    static func pushShowPreviewFooter(_ l: Language) -> String {
        switch l {
        case .en: "When this is off, the text never leaves the server — the notification only says a message arrived."
        case .fa: "وقتی خاموش باشد، متن پیام اصلاً از سرور بیرون نمی‌آید — اعلان فقط می‌گوید پیامی رسیده است."
        case .tr: "Bu kapalıyken metin sunucudan hiç çıkmaz — bildirim yalnızca bir mesaj geldiğini söyler."
        case .ar: "عند إيقاف هذا الخيار، لا يغادر النص الخادم أبدًا — يكتفي الإشعار بالقول إن رسالة وصلت."
        }
    }

    static func pushSound(_ l: Language) -> String {
        switch l {
        case .en: "Sound"
        case .fa: "صدا"
        case .tr: "Ses"
        case .ar: "الصوت"
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
        case .ar: "أثناء وجودي على مكتبي"
        }
    }

    static func pushWhenOffline(_ l: Language) -> String {
        switch l {
        case .en: "While I am away"
        case .fa: "وقتی دور از میزم هستم"
        case .tr: "Uzaktayken"
        case .ar: "أثناء غيابي"
        }
    }

    static func pushPresenceFooter(_ l: Language) -> String {
        switch l {
        case .en: "Webyar knows you are at your desk while the web console is open. Turn the first off to keep the phone quiet while you are already answering there."
        case .fa: "وب\u{200C}یار وقتی کنسول وب باز است می\u{200C}داند پشت میزتان هستید. اولی را خاموش کنید تا وقتی همان\u{200C}جا پاسخ می\u{200C}دهید، گوشی ساکت بماند."
        case .tr: "Web konsolu açıkken masanızda olduğunuz bilinir. Orada zaten yanıtlarken telefonun sessiz kalması için ilkini kapatın."
        case .ar: "يعرف Webyar أنك على مكتبك ما دامت لوحة التحكم على الويب مفتوحة. أوقف الخيار الأول ليبقى الهاتف هادئًا بينما تجيب من هناك."
        }
    }

    static func pushQuietHours(_ l: Language) -> String {
        switch l {
        case .en: "Quiet hours"
        case .fa: "ساعت‌های سکوت"
        case .tr: "Sessiz saatler"
        case .ar: "ساعات الهدوء"
        }
    }

    static func pushQuietFrom(_ l: Language) -> String {
        switch l {
        case .en: "From"
        case .fa: "از"
        case .tr: "Başlangıç"
        case .ar: "من"
        }
    }

    static func pushQuietTo(_ l: Language) -> String {
        switch l {
        case .en: "Until"
        case .fa: "تا"
        case .tr: "Bitiş"
        case .ar: "حتى"
        }
    }

    static func pushQuietFooter(_ l: Language) -> String {
        switch l {
        case .en: "Nothing arrives inside this window, except someone mentioning you by name."
        case .fa: "در این بازه چیزی نمی‌رسد، مگر اینکه کسی نام شما را ببرد."
        case .tr: "Bu aralıkta, biri adınızı anmadıkça hiçbir şey ulaşmaz."
        case .ar: "لا يصل أي شيء خلال هذه الفترة، باستثناء الإشارة إليك بالاسم."
        }
    }

    static func pushThisDevice(_ l: Language) -> String {
        switch l {
        case .en: "This phone"
        case .fa: "همین تلفن"
        case .tr: "Bu telefon"
        case .ar: "هذا الهاتف"
        }
    }

    static func pushDeviceRegistered(_ l: Language) -> String {
        switch l {
        case .en: "Registered and able to receive notifications."
        case .fa: "ثبت شده و آماده‌ی دریافت اعلان است."
        case .tr: "Kayıtlı ve bildirim alabilir durumda."
        case .ar: "مسجَّل وقادر على تلقي الإشعارات."
        }
    }

    static func pushDeviceNotRegistered(_ l: Language) -> String {
        switch l {
        case .en: "Not registered yet."
        case .fa: "هنوز ثبت نشده است."
        case .tr: "Henüz kayıtlı değil."
        case .ar: "لم يُسجَّل بعد."
        }
    }

    // MARK: - Deleting the account

    static func deleteAccount(_ l: Language) -> String {
        switch l {
        case .en: "Delete account"
        case .fa: "حذف حساب"
        case .tr: "Hesabı sil"
        case .ar: "حذف الحساب"
        }
    }

    static func deleteAccountBody(_ l: Language) -> String {
        switch l {
        case .en: "Your profile, your password, your workspace memberships, your notification preferences and every device you have signed in on are removed. This cannot be undone."
        case .fa: "نمایه، رمز عبور، عضویت‌هایتان در فضاهای کاری، تنظیمات اعلان و همه‌ی دستگاه‌هایی که با آن‌ها وارد شده‌اید پاک می‌شوند. این کار برگشت‌پذیر نیست."
        case .tr: "Profiliniz, parolanız, çalışma alanı üyelikleriniz, bildirim tercihleriniz ve giriş yaptığınız her cihaz kaldırılır. Bu işlem geri alınamaz."
        case .ar: "سيُحذف ملفك الشخصي وكلمة مرورك وعضوياتك في مساحات العمل وتفضيلات إشعاراتك وكل جهاز سجّلت الدخول منه. لا يمكن التراجع عن ذلك."
        }
    }

    /// Said plainly, because it is the part people worry about and the part
    /// that is genuinely reassuring.
    static func deleteAccountKeeps(_ l: Language) -> String {
        switch l {
        case .en: "Conversations you handled stay with the workspace — they belong to the customer, not to you — but they stop being attributed to you."
        case .fa: "گفتگوهایی که رسیدگی کرده‌اید در فضای کاری می‌مانند — آن‌ها مال مشتری‌اند، نه شما — ولی دیگر به نام شما ثبت نمی‌شوند."
        case .tr: "İlgilendiğiniz konuşmalar çalışma alanında kalır — müşteriye aittir, size değil — ancak artık size atfedilmez."
        case .ar: "تبقى المحادثات التي تولّيتها في مساحة العمل — فهي ملك للعميل لا لك — لكنها لن تُنسب إليك بعد الآن."
        }
    }

    static func deleteAccountConfirmPassword(_ l: Language) -> String {
        switch l {
        case .en: "Enter your password to confirm"
        case .fa: "برای تأیید، رمز عبورتان را وارد کنید"
        case .tr: "Onaylamak için parolanızı girin"
        case .ar: "أدخل كلمة المرور للتأكيد"
        }
    }

    static func deleteAccountFinal(_ l: Language) -> String {
        switch l {
        case .en: "Delete my account"
        case .fa: "حساب من را حذف کن"
        case .tr: "Hesabımı sil"
        case .ar: "حذف حسابي"
        }
    }

    static func deleteAccountWrongPassword(_ l: Language) -> String {
        switch l {
        case .en: "That password is not right."
        case .fa: "این رمز عبور درست نیست."
        case .tr: "Bu parola doğru değil."
        case .ar: "كلمة المرور هذه غير صحيحة."
        }
    }

    /// The one case the server refuses, and the only one worth a screen of
    /// its own: an owner's profile cascades to their workspaces.
    static func deleteAccountOwnsTitle(_ l: Language) -> String {
        switch l {
        case .en: "Hand these over first"
        case .fa: "اول این‌ها را واگذار کنید"
        case .tr: "Önce bunları devredin"
        case .ar: "انقل ملكيتها أولًا"
        }
    }

    static func deleteAccountOwnsBody(_ l: Language, workspaces: String) -> String {
        switch l {
        case .en: "You still own \(workspaces). Deleting your account would take the workspace and everything in it — every conversation, contact and invoice — with it, so ownership has to move to somebody else first. Support will do that for you, and then this will go through."
        case .fa: "هنوز مالک \(workspaces) هستید. حذف حسابتان فضای کاری و هر چیزی که در آن است — هر گفتگو، مخاطب و صورتحساب — را هم با خود می‌برد، پس اول باید مالکیت به شخص دیگری منتقل شود. پشتیبانی این کار را برایتان انجام می‌دهد و بعد از آن حذف انجام می‌شود."
        case .tr: "Hâlâ \(workspaces) alanının sahibisiniz. Hesabınızı silmek çalışma alanını ve içindeki her şeyi — her konuşmayı, kişiyi ve faturayı — birlikte götürür; bu yüzden önce sahipliğin başka birine geçmesi gerekir. Destek bunu sizin için yapar, sonra silme işlemi tamamlanır."
        case .ar: "ما زلت تملك \(workspaces). حذف حسابك سيأخذ معه مساحة العمل وكل ما فيها — كل محادثة وجهة اتصال وفاتورة — لذا يجب نقل الملكية إلى شخص آخر أولًا. سيتولى فريق الدعم ذلك نيابةً عنك، وبعدها يكتمل الحذف."
        }
    }

    static func accountDeleted(_ l: Language) -> String {
        switch l {
        case .en: "Your account has been deleted."
        case .fa: "حساب شما حذف شد."
        case .tr: "Hesabınız silindi."
        case .ar: "تم حذف حسابك."
        }
    }

    // MARK: - Tabs

    static func tabInbox(_ l: Language) -> String {
        switch l {
        case .en: "Inbox"
        case .fa: "صندوق"
        case .tr: "Gelen kutusu"
        case .ar: "الوارد"
        }
    }

    /// What VoiceOver says of the dot on the Inbox tab. A template: `{count}`
    /// is replaced with the number in the reader's digits.
    static func tabUnread(_ l: Language) -> String {
        switch l {
        case .en: "{count} unread"
        case .fa: "{count} خوانده‌نشده"
        case .tr: "{count} okunmamış"
        case .ar: "{count} غير مقروءة"
        }
    }

    static func tabContacts(_ l: Language) -> String {
        switch l {
        case .en: "Contacts"
        case .fa: "مخاطبین"
        case .tr: "Kişiler"
        case .ar: "جهات الاتصال"
        }
    }

    static func tabSettings(_ l: Language) -> String {
        switch l {
        case .en: "Settings"
        case .fa: "تنظیمات"
        case .tr: "Ayarlar"
        case .ar: "الإعدادات"
        }
    }

    // MARK: - Inbox

    static func filterOpen(_ l: Language) -> String {
        switch l {
        case .en: "Open"
        case .fa: "باز"
        case .tr: "Açık"
        case .ar: "المفتوحة"
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
        case .ar: "الذكاء الاصطناعي"
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
        case .ar: "بانتظار العميل"
        }
    }

    static func filterResolved(_ l: Language) -> String {
        switch l {
        case .en: "Resolved"
        case .fa: "حل‌شده"
        case .tr: "Çözüldü"
        case .ar: "تم الحل"
        }
    }

    static func filterSpam(_ l: Language) -> String {
        switch l {
        case .en: "Spam"
        case .fa: "هرزنامه"
        case .tr: "Spam"
        case .ar: "غير مرغوب فيها"
        }
    }

    /// The menu behind the inbox title: every inbox this plan grants.
    static func allInboxes(_ l: Language) -> String {
        switch l {
        case .en: "Inboxes"
        case .fa: "صندوق‌ها"
        case .tr: "Gelen kutuları"
        case .ar: "صناديق الوارد"
        }
    }

    static func otherInboxes(_ l: Language) -> String {
        switch l {
        case .en: "Other inboxes"
        case .fa: "صندوق‌های دیگر"
        case .tr: "Diğer gelen kutuları"
        case .ar: "صناديق وارد أخرى"
        }
    }

    // MARK: - Colleagues

    static func colleagues(_ l: Language) -> String {
        switch l {
        case .en: "Colleagues"
        case .fa: "همکاران"
        case .tr: "Meslektaşlar"
        case .ar: "الزملاء"
        }
    }

    static func colleaguesEmptyTitle(_ l: Language) -> String {
        switch l {
        case .en: "No colleagues yet"
        case .fa: "هنوز همکاری نیست"
        case .tr: "Henüz meslektaş yok"
        case .ar: "لا يوجد زملاء بعد"
        }
    }

    static func colleaguesEmptyBody(_ l: Language) -> String {
        switch l {
        case .en: "Operators invited to this workspace appear here."
        case .fa: "اپراتورهایی که به این فضای کاری دعوت شوند اینجا دیده می‌شوند."
        case .tr: "Bu çalışma alanına davet edilen operatörler burada görünür."
        case .ar: "يظهر هنا الموظفون المدعوون إلى مساحة العمل هذه."
        }
    }

    static func colleagueThreadEmpty(_ l: Language) -> String {
        switch l {
        case .en: "No messages yet"
        case .fa: "هنوز پیغامی نیست"
        case .tr: "Henüz mesaj yok"
        case .ar: "لا توجد رسائل بعد"
        }
    }

    // MARK: - Availability

    static func availability(_ l: Language) -> String {
        switch l {
        case .en: "Availability"
        case .fa: "وضعیت دسترس‌پذیری"
        case .tr: "Uygunluk"
        case .ar: "التوفّر"
        }
    }

    static func availabilitySeenAs(_ l: Language) -> String {
        switch l {
        case .en: "You are currently seen as"
        case .fa: "در حال حاضر شما این‌گونه دیده می‌شوید"
        case .tr: "Şu anda şöyle görünüyorsunuz"
        case .ar: "تظهر حاليًا"
        }
    }

    static func availabilityOnline(_ l: Language) -> String {
        switch l {
        case .en: "Online"
        case .fa: "آنلاین"
        case .tr: "Çevrimiçi"
        case .ar: "متصل"
        }
    }

    static func availabilityOffline(_ l: Language) -> String {
        switch l {
        case .en: "Offline"
        case .fa: "آفلاین"
        case .tr: "Çevrimdışı"
        case .ar: "غير متصل"
        }
    }

    static func availabilityForceOffline(_ l: Language) -> String {
        switch l {
        case .en: "Force offline (invisible mode)"
        case .fa: "آفلاین اجباری (حالت نامرئی)"
        case .tr: "Zorla çevrimdışı (görünmez mod)"
        case .ar: "الظهور غير متصل (وضع التخفي)"
        }
    }

    static func availabilityForceOfflineHint(_ l: Language) -> String {
        switch l {
        case .en: "You appear offline to visitors whatever your schedule says."
        case .fa: "صرف‌نظر از زمان‌بندی، برای بازدیدکنندگان آفلاین دیده می‌شوید."
        case .tr: "Programınız ne derse desin ziyaretçilere çevrimdışı görünürsünüz."
        case .ar: "تظهر غير متصل للزوار بغض النظر عن جدولك."
        }
    }

    static func availabilityWhenUsingApp(_ l: Language) -> String {
        switch l {
        case .en: "Available while I use the app"
        case .fa: "وقتی از برنامه استفاده می‌کنم، در دسترس باشم"
        case .tr: "Uygulamayı kullanırken uygunum"
        case .ar: "متاح أثناء استخدامي التطبيق"
        }
    }

    static func availabilityWhenUsingAppHint(_ l: Language) -> String {
        switch l {
        case .en: "Marks you online automatically while the app is open."
        case .fa: "تا وقتی برنامه باز است، به‌صورت خودکار آنلاین در نظر گرفته می‌شوید."
        case .tr: "Uygulama açıkken sizi otomatik olarak çevrimiçi işaretler."
        case .ar: "يجعلك متصلًا تلقائيًا ما دام التطبيق مفتوحًا."
        }
    }

    static func availabilitySchedule(_ l: Language) -> String {
        switch l {
        case .en: "Use my weekly schedule"
        case .fa: "از زمان‌بندی هفتگی‌ام استفاده کن"
        case .tr: "Haftalık programımı kullan"
        case .ar: "استخدام جدولي الأسبوعي"
        }
    }

    static func availabilityScheduleHint(_ l: Language) -> String {
        switch l {
        case .en: "The hours themselves are set in the web console."
        case .fa: "خود ساعت‌ها را در کنسول وب تنظیم می‌کنید."
        case .tr: "Saatlerin kendisi web konsolundan ayarlanır."
        case .ar: "تُضبط الساعات نفسها من لوحة التحكم على الويب."
        }
    }

    static func availabilitySaveFailed(_ l: Language) -> String {
        switch l {
        case .en: "That did not save. Try again."
        case .fa: "ذخیره نشد. دوباره تلاش کنید."
        case .tr: "Kaydedilemedi. Tekrar deneyin."
        case .ar: "لم يُحفظ ذلك. حاول مرة أخرى."
        }
    }

    // MARK: - Email inbox

    static func emailInbox(_ l: Language) -> String {
        switch l {
        case .en: "Email"
        case .fa: "ایمیل"
        case .tr: "E-posta"
        case .ar: "البريد الإلكتروني"
        }
    }

    static func emailEmptyTitle(_ l: Language) -> String {
        switch l {
        case .en: "No email"
        case .fa: "ایمیلی نیست"
        case .tr: "E-posta yok"
        case .ar: "لا توجد رسائل بريد"
        }
    }

    static func emailEmptyBody(_ l: Language) -> String {
        switch l {
        case .en: "New mail in this mailbox will appear here."
        case .fa: "ایمیل‌های تازهٔ این صندوق اینجا نشان داده می‌شوند."
        case .tr: "Bu posta kutusuna gelen yeni e-postalar burada görünür."
        case .ar: "ستظهر هنا الرسائل الجديدة في صندوق البريد هذا."
        }
    }

    static func emailNotConnectedTitle(_ l: Language) -> String {
        switch l {
        case .en: "Mailbox not connected"
        case .fa: "صندوق ایمیل وصل نیست"
        case .tr: "Posta kutusu bağlı değil"
        case .ar: "صندوق البريد غير مرتبط"
        }
    }

    static func emailNotConnectedBody(_ l: Language) -> String {
        switch l {
        case .en: "Connect a mailbox in the web console under Email, then it will open here too."
        case .fa: "در کنسول وب، بخش ایمیل، یک صندوق وصل کنید؛ بعد از آن اینجا هم باز می‌شود."
        case .tr: "Web konsolunda E-posta bölümünden bir posta kutusu bağlayın; sonra burada da açılır."
        case .ar: "اربط صندوق بريد من لوحة التحكم على الويب ضمن «البريد الإلكتروني»، وسيُفتح هنا أيضًا."
        }
    }

    static func emailNoSubject(_ l: Language) -> String {
        switch l {
        case .en: "(no subject)"
        case .fa: "(بدون موضوع)"
        case .tr: "(konu yok)"
        case .ar: "(بلا موضوع)"
        }
    }

    static func emailReply(_ l: Language) -> String {
        switch l {
        case .en: "Reply"
        case .fa: "پاسخ"
        case .tr: "Yanıtla"
        case .ar: "رد"
        }
    }

    static func emailReplyPlaceholder(_ l: Language) -> String {
        switch l {
        case .en: "Write a reply"
        case .fa: "پاسخ بنویسید"
        case .tr: "Bir yanıt yazın"
        case .ar: "اكتب ردًا"
        }
    }

    static func emailSend(_ l: Language) -> String {
        switch l {
        case .en: "Send"
        case .fa: "ارسال"
        case .tr: "Gönder"
        case .ar: "إرسال"
        }
    }

    static func emailStar(_ l: Language) -> String {
        switch l {
        case .en: "Star"
        case .fa: "ستاره"
        case .tr: "Yıldız"
        case .ar: "تمييز بنجمة"
        }
    }

    static func emailMarkUnread(_ l: Language) -> String {
        switch l {
        case .en: "Mark as unread"
        case .fa: "علامت خوانده‌نشده"
        case .tr: "Okunmadı olarak işaretle"
        case .ar: "تعليم كغير مقروءة"
        }
    }

    static func emailSendFailed(_ l: Language) -> String {
        switch l {
        case .en: "The reply was not sent. Try again."
        case .fa: "پاسخ فرستاده نشد. دوباره تلاش کنید."
        case .tr: "Yanıt gönderilemedi. Tekrar deneyin."
        case .ar: "لم يُرسَل الرد. حاول مرة أخرى."
        }
    }

    static func inboxEmptyTitle(_ l: Language) -> String {
        switch l {
        case .en: "No conversations"
        case .fa: "گفت‌وگویی نیست"
        case .tr: "Görüşme yok"
        case .ar: "لا توجد محادثات"
        }
    }

    static func inboxEmptyBody(_ l: Language) -> String {
        switch l {
        case .en: "New conversations will appear here as visitors reach out."
        case .fa: "گفت‌وگوهای تازه با پیام بازدیدکنندگان همین‌جا ظاهر می‌شوند."
        case .tr: "Ziyaretçiler yazdıkça yeni görüşmeler burada görünür."
        case .ar: "ستظهر هنا المحادثات الجديدة عندما يتواصل الزوار."
        }
    }

    static func markResolved(_ l: Language) -> String {
        switch l {
        case .en: "Resolve"
        case .fa: "حل شد"
        case .tr: "Çöz"
        case .ar: "تم الحل"
        }
    }

    static func reopen(_ l: Language) -> String {
        switch l {
        case .en: "Reopen"
        case .fa: "بازگشایی"
        case .tr: "Yeniden aç"
        case .ar: "إعادة فتح"
        }
    }

    // MARK: - Chat

    static func messagePlaceholder(_ l: Language) -> String {
        switch l {
        case .en: "Message"
        case .fa: "پیام"
        case .tr: "Mesaj"
        case .ar: "رسالة"
        }
    }

    static func send(_ l: Language) -> String {
        switch l {
        case .en: "Send"
        case .fa: "ارسال"
        case .tr: "Gönder"
        case .ar: "إرسال"
        }
    }

    static func chatEmpty(_ l: Language) -> String {
        switch l {
        case .en: "No messages yet"
        case .fa: "هنوز پیامی نیست"
        case .tr: "Henüz mesaj yok"
        case .ar: "لا توجد رسائل بعد"
        }
    }

    static func aiReply(_ l: Language) -> String {
        switch l {
        case .en: "AI"
        case .fa: "هوش مصنوعی"
        case .tr: "Yapay zekâ"
        case .ar: "الذكاء الاصطناعي"
        }
    }

    static func systemNote(_ l: Language) -> String {
        switch l {
        case .en: "System"
        case .fa: "سیستم"
        case .tr: "Sistem"
        case .ar: "النظام"
        }
    }

    // MARK: - Contacts

    static func contactsEmptyTitle(_ l: Language) -> String {
        switch l {
        case .en: "No contacts"
        case .fa: "مخاطبی نیست"
        case .tr: "Kişi yok"
        case .ar: "لا توجد جهات اتصال"
        }
    }

    static func contactsEmptyBody(_ l: Language) -> String {
        switch l {
        case .en: "People who talk to you are added here automatically."
        case .fa: "کسانی که با شما گفت‌وگو کنند خودکار این‌جا افزوده می‌شوند."
        case .tr: "Sizinle konuşan kişiler buraya otomatik eklenir."
        case .ar: "يُضاف هنا تلقائيًا كل من يتحدث معك."
        }
    }

    static func noResults(_ l: Language) -> String {
        switch l {
        case .en: "No results"
        case .fa: "نتیجه‌ای نیست"
        case .tr: "Sonuç yok"
        case .ar: "لا توجد نتائج"
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
        case .ar: return Format.arabicCount(n, one: "محادثة واحدة", two: "محادثتان", few: "محادثات", many: "محادثة")
        }
    }

    // MARK: - Settings

    static func account(_ l: Language) -> String {
        switch l {
        case .en: "Account"
        case .fa: "حساب کاربری"
        case .tr: "Hesap"
        case .ar: "الحساب"
        }
    }

    static func language(_ l: Language) -> String {
        switch l {
        case .en: "Language"
        case .fa: "زبان"
        case .tr: "Dil"
        case .ar: "اللغة"
        }
    }

    static func workspace(_ l: Language) -> String {
        switch l {
        case .en: "Workspace"
        case .fa: "فضای کاری"
        case .tr: "Çalışma alanı"
        case .ar: "مساحة العمل"
        }
    }

    static func about(_ l: Language) -> String {
        switch l {
        case .en: "About"
        case .fa: "درباره"
        case .tr: "Hakkında"
        case .ar: "حول التطبيق"
        }
    }

    /// The one way forward for an owner who wants their account removed.
    static func support(_ l: Language) -> String {
        switch l {
        case .en: "Support"
        case .fa: "پشتیبانی"
        case .tr: "Destek"
        case .ar: "الدعم"
        }
    }

    static func version(_ l: Language) -> String {
        switch l {
        case .en: "Version"
        case .fa: "نسخه"
        case .tr: "Sürüm"
        case .ar: "الإصدار"
        }
    }

    static func signOut(_ l: Language) -> String {
        switch l {
        case .en: "Sign out"
        case .fa: "خروج از حساب"
        case .tr: "Çıkış yap"
        case .ar: "تسجيل الخروج"
        }
    }

    static func signOutConfirm(_ l: Language) -> String {
        switch l {
        case .en: "Sign out of Webyar?"
        case .fa: "از وب‌یار خارج می‌شوید؟"
        case .tr: "Webyar'dan çıkılsın mı?"
        case .ar: "تسجيل الخروج من Webyar؟"
        }
    }

    static func signOutFailed(_ l: Language) -> String {
        switch l {
        case .en: "Sign out failed. You are still signed in."
        case .fa: "خروج انجام نشد. هنوز وارد حساب هستید."
        case .tr: "Çıkış yapılamadı. Hâlâ oturumunuz açık."
        case .ar: "فشل تسجيل الخروج. ما زلت مسجّل الدخول."
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
        case .ar: "بحاجة إليك"
        }
    }

    static func claim(_ l: Language) -> String {
        switch l {
        case .en: "Assign to me"
        case .fa: "به من بسپار"
        case .tr: "Bana ata"
        case .ar: "إسناد إليّ"
        }
    }

    static func assignedToYou(_ l: Language) -> String {
        switch l {
        case .en: "Yours"
        case .fa: "مال شما"
        case .tr: "Sizde"
        case .ar: "لك"
        }
    }

    static func priorityUrgent(_ l: Language) -> String {
        switch l {
        case .en: "Urgent"
        case .fa: "فوری"
        case .tr: "Acil"
        case .ar: "عاجلة"
        }
    }

    static func priorityHigh(_ l: Language) -> String {
        switch l {
        case .en: "High"
        case .fa: "زیاد"
        case .tr: "Yüksek"
        case .ar: "مرتفعة"
        }
    }

    // MARK: - Settings (profile & security)

    static func profile(_ l: Language) -> String {
        switch l {
        case .en: "Profile"
        case .fa: "نمایه"
        case .tr: "Profil"
        case .ar: "الملف الشخصي"
        }
    }

    static func displayName(_ l: Language) -> String {
        switch l {
        case .en: "Name"
        case .fa: "نام"
        case .tr: "Ad"
        case .ar: "الاسم"
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
        case .ar: "الاسم الأول"
        }
    }

    static func lastName(_ l: Language) -> String {
        switch l {
        case .en: "Last name"
        case .fa: "نام خانوادگی"
        case .tr: "Soyad"
        case .ar: "اسم العائلة"
        }
    }

    static func phoneLabel(_ l: Language) -> String {
        switch l {
        case .en: "Phone number"
        case .fa: "شماره تلفن"
        case .tr: "Telefon numarası"
        case .ar: "رقم الهاتف"
        }
    }

    static func changePhoto(_ l: Language) -> String {
        switch l {
        case .en: "Change photo"
        case .fa: "تغییر عکس"
        case .tr: "Fotoğrafı değiştir"
        case .ar: "تغيير الصورة"
        }
    }

    static func removePhoto(_ l: Language) -> String {
        switch l {
        case .en: "Remove photo"
        case .fa: "حذف عکس"
        case .tr: "Fotoğrafı kaldır"
        case .ar: "إزالة الصورة"
        }
    }

    static func save(_ l: Language) -> String {
        switch l {
        case .en: "Save"
        case .fa: "ذخیره"
        case .tr: "Kaydet"
        case .ar: "حفظ"
        }
    }

    static func saved(_ l: Language) -> String {
        switch l {
        case .en: "Saved"
        case .fa: "ذخیره شد"
        case .tr: "Kaydedildi"
        case .ar: "تم الحفظ"
        }
    }

    static func saveFailed(_ l: Language) -> String {
        switch l {
        case .en: "Could not save. Try again."
        case .fa: "ذخیره نشد. دوباره تلاش کنید."
        case .tr: "Kaydedilemedi. Tekrar deneyin."
        case .ar: "تعذّر الحفظ. حاول مرة أخرى."
        }
    }

    static func photoTooLarge(_ l: Language) -> String {
        switch l {
        case .en: "That image is too large. Pick a smaller one."
        case .fa: "این تصویر خیلی بزرگ است. کوچک‌تری انتخاب کنید."
        case .tr: "Bu görsel çok büyük. Daha küçüğünü seçin."
        case .ar: "هذه الصورة كبيرة جدًا. اختر صورة أصغر."
        }
    }

    static func security(_ l: Language) -> String {
        switch l {
        case .en: "Security"
        case .fa: "امنیت"
        case .tr: "Güvenlik"
        case .ar: "الأمان"
        }
    }

    static func changePassword(_ l: Language) -> String {
        switch l {
        case .en: "Change password"
        case .fa: "تغییر رمز عبور"
        case .tr: "Parolayı değiştir"
        case .ar: "تغيير كلمة المرور"
        }
    }

    static func currentPassword(_ l: Language) -> String {
        switch l {
        case .en: "Current password"
        case .fa: "رمز عبور فعلی"
        case .tr: "Mevcut parola"
        case .ar: "كلمة المرور الحالية"
        }
    }

    static func newPassword(_ l: Language) -> String {
        switch l {
        case .en: "New password"
        case .fa: "رمز عبور تازه"
        case .tr: "Yeni parola"
        case .ar: "كلمة المرور الجديدة"
        }
    }

    static func passwordChanged(_ l: Language) -> String {
        switch l {
        case .en: "Password changed"
        case .fa: "رمز عبور عوض شد"
        case .tr: "Parola değiştirildi"
        case .ar: "تم تغيير كلمة المرور"
        }
    }

    static func passwordTooShort(_ l: Language) -> String {
        switch l {
        case .en: "Use at least 8 characters."
        case .fa: "دست‌کم ۸ نویسه بگذارید."
        case .tr: "En az 8 karakter kullanın."
        case .ar: "استخدم ٨ أحرف على الأقل."
        }
    }

    static func activeSessions(_ l: Language) -> String {
        switch l {
        case .en: "Signed-in devices"
        case .fa: "دستگاه‌های واردشده"
        case .tr: "Oturum açık cihazlar"
        case .ar: "الأجهزة المسجّل دخولها"
        }
    }

    static func thisDevice(_ l: Language) -> String {
        switch l {
        case .en: "This device"
        case .fa: "همین دستگاه"
        case .tr: "Bu cihaz"
        case .ar: "هذا الجهاز"
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
        case .ar: "تسجيل الخروج"
        }
    }

    static func revokeSession(_ l: Language) -> String {
        switch l {
        case .en: "Sign out this device"
        case .fa: "خروج این دستگاه"
        case .tr: "Bu cihazdan çık"
        case .ar: "تسجيل خروج هذا الجهاز"
        }
    }

    static func lastActive(_ l: Language) -> String {
        switch l {
        case .en: "Last active"
        case .fa: "آخرین فعالیت"
        case .tr: "Son etkinlik"
        case .ar: "آخر نشاط"
        }
    }

    static func appearance(_ l: Language) -> String {
        switch l {
        case .en: "Appearance"
        case .fa: "ظاهر"
        case .tr: "Görünüm"
        case .ar: "المظهر"
        }
    }

    static func appearanceSystem(_ l: Language) -> String {
        switch l {
        case .en: "Match device"
        case .fa: "مطابق دستگاه"
        case .tr: "Cihazla aynı"
        case .ar: "مثل الجهاز"
        }
    }

    static func appearanceLight(_ l: Language) -> String {
        switch l {
        case .en: "Light"
        case .fa: "روشن"
        case .tr: "Açık"
        case .ar: "فاتح"
        }
    }

    static func appearanceDark(_ l: Language) -> String {
        switch l {
        case .en: "Dark"
        case .fa: "تیره"
        case .tr: "Koyu"
        case .ar: "داكن"
        }
    }

    static func plan(_ l: Language) -> String {
        switch l {
        case .en: "Plan"
        case .fa: "پلن"
        case .tr: "Plan"
        case .ar: "الباقة"
        }
    }

    static func emailNotVerified(_ l: Language) -> String {
        switch l {
        case .en: "Email not verified"
        case .fa: "ایمیل تأیید نشده"
        case .tr: "E-posta doğrulanmadı"
        case .ar: "البريد الإلكتروني غير مؤكَّد"
        }
    }


    // MARK: - Composer

    static func attachFile(_ l: Language) -> String {
        switch l {
        case .en: "Attach a file"
        case .fa: "پیوست فایل"
        case .tr: "Dosya ekle"
        case .ar: "إرفاق ملف"
        }
    }

    static func voiceNote(_ l: Language) -> String {
        switch l {
        case .en: "Voice note"
        case .fa: "پیام صوتی"
        case .tr: "Sesli not"
        case .ar: "رسالة صوتية"
        }
    }

    // MARK: - Saved replies

    static func shortcuts(_ l: Language) -> String {
        switch l {
        case .en: "Shortcuts"
        case .fa: "میان‌برها"
        case .tr: "Kısayollar"
        case .ar: "الردود الجاهزة"
        }
    }

    static func searchShortcuts(_ l: Language) -> String {
        switch l {
        case .en: "Search shortcuts"
        case .fa: "جست‌وجوی میان‌برها"
        case .tr: "Kısayollarda ara"
        case .ar: "البحث في الردود الجاهزة"
        }
    }

    static func shortcutsEmptyTitle(_ l: Language) -> String {
        switch l {
        case .en: "No saved replies yet"
        case .fa: "هنوز پاسخ آماده‌ای نیست"
        case .tr: "Henüz hazır yanıt yok"
        case .ar: "لا توجد ردود محفوظة بعد"
        }
    }

    static func shortcutsEmptyBody(_ l: Language) -> String {
        switch l {
        case .en: "Add them in the console under Settings → Shortcuts. Everyone in the workspace can use them."
        case .fa: "در کنسول، از تنظیمات ← میان‌برها اضافه‌شان کنید. همهٔ اعضای فضای کاری می‌توانند از آن‌ها استفاده کنند."
        case .tr: "Konsolda Ayarlar → Kısayollar altından ekleyin. Çalışma alanındaki herkes kullanabilir."
        case .ar: "أضفها من لوحة التحكم ضمن الإعدادات ← الردود الجاهزة. يمكن لكل من في مساحة العمل استخدامها."
        }
    }

    static func shortcutsUnavailableTitle(_ l: Language) -> String {
        switch l {
        case .en: "Shortcuts are not set up on this server"
        case .fa: "میان‌برها روی این سرور راه‌اندازی نشده‌اند"
        case .tr: "Kısayollar bu sunucuda kurulu değil"
        case .ar: "الردود الجاهزة غير مُعدّة على هذا الخادم"
        }
    }

    static func shortcutsUnavailableBody(_ l: Language) -> String {
        switch l {
        case .en: "Your administrator can enable them by bringing the database up to date."
        case .fa: "مدیر سامانه می‌تواند با به‌روزرسانی پایگاه داده فعالشان کند."
        case .tr: "Yöneticiniz veritabanını güncelleyerek etkinleştirebilir."
        case .ar: "يمكن لمسؤول النظام تفعيلها بتحديث قاعدة البيانات."
        }
    }

    static func emoji(_ l: Language) -> String {
        switch l {
        case .en: "Emoji"
        case .fa: "شکلک"
        case .tr: "Emoji"
        case .ar: "الرموز التعبيرية"
        }
    }

    // MARK: - Errors

    static func offlineTitle(_ l: Language) -> String {
        switch l {
        case .en: "Can't reach the server"
        case .fa: "دسترسی به سرور ممکن نشد"
        case .tr: "Sunucuya ulaşılamıyor"
        case .ar: "تعذّر الوصول إلى الخادم"
        }
    }

    static func offlineBody(_ l: Language) -> String {
        switch l {
        case .en: "Check your connection and try again."
        case .fa: "اتصال خود را بررسی کنید و دوباره تلاش کنید."
        case .tr: "Bağlantınızı kontrol edip tekrar deneyin."
        case .ar: "تحقّق من اتصالك وحاول مرة أخرى."
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
        case .ar: "غير متصل — يُعرض ما حُفظ على هذا الهاتف."
        }
    }

    /// Read aloud for a message that has not reached the server yet.
    static func messageSending(_ l: Language) -> String {
        switch l {
        case .en: "Sending"
        case .fa: "در حال ارسال"
        case .tr: "Gönderiliyor"
        case .ar: "جارٍ الإرسال"
        }
    }

    static func storage(_ l: Language) -> String {
        switch l {
        case .en: "Storage"
        case .fa: "فضای ذخیره‌سازی"
        case .tr: "Depolama"
        case .ar: "التخزين"
        }
    }

    static func storageConversations(_ l: Language) -> String {
        switch l {
        case .en: "Saved conversations"
        case .fa: "گفتگوهای ذخیره‌شده"
        case .tr: "Kayıtlı konuşmalar"
        case .ar: "المحادثات المحفوظة"
        }
    }

    static func storageFiles(_ l: Language) -> String {
        switch l {
        case .en: "Files and media"
        case .fa: "فایل‌ها و رسانه‌ها"
        case .tr: "Dosyalar ve medya"
        case .ar: "الملفات والوسائط"
        }
    }

    static func storagePictures(_ l: Language) -> String {
        switch l {
        case .en: "Pictures"
        case .fa: "تصاویر پروفایل"
        case .tr: "Profil resimleri"
        case .ar: "الصور"
        }
    }

    static func storageTotal(_ l: Language) -> String {
        switch l {
        case .en: "Total"
        case .fa: "مجموع"
        case .tr: "Toplam"
        case .ar: "الإجمالي"
        }
    }

    static func storageFooter(_ l: Language) -> String {
        switch l {
        case .en: "Copies kept on this phone so conversations open at once and files are not downloaded twice. Clearing them removes nothing from the server and does not sign you out."
        case .fa: "نسخه‌هایی که روی این گوشی نگه داشته می‌شوند تا گفتگوها فوراً باز شوند و فایل‌ها دوباره دانلود نشوند. پاک کردن آن‌ها چیزی را از سرور حذف نمی‌کند و شما را از حساب خارج نمی‌کند."
        case .tr: "Konuşmaların hemen açılması ve dosyaların iki kez indirilmemesi için bu telefonda tutulan kopyalar. Silmek sunucudan hiçbir şeyi kaldırmaz ve oturumunuzu kapatmaz."
        case .ar: "نسخ محفوظة على هذا الهاتف لتُفتح المحادثات فورًا ولا تُنزَّل الملفات مرتين. مسحها لا يحذف شيئًا من الخادم ولا يسجّل خروجك."
        }
    }

    static func clearCache(_ l: Language) -> String {
        switch l {
        case .en: "Clear Cache"
        case .fa: "پاک کردن حافظهٔ موقت"
        case .tr: "Önbelleği Temizle"
        case .ar: "مسح الذاكرة المؤقتة"
        }
    }

    static func clearCacheConfirm(_ l: Language) -> String {
        switch l {
        case .en: "Remove the copies saved on this phone? They will be downloaded again as needed."
        case .fa: "نسخه‌های ذخیره‌شده روی این گوشی حذف شوند؟ در صورت نیاز دوباره دانلود می‌شوند."
        case .tr: "Bu telefonda kayıtlı kopyalar kaldırılsın mı? Gerektiğinde yeniden indirilecekler."
        case .ar: "هل تريد إزالة النسخ المحفوظة على هذا الهاتف؟ سيُعاد تنزيلها عند الحاجة."
        }
    }

    static func sessionExpired(_ l: Language) -> String {
        switch l {
        case .en: "Your session expired. Please sign in again."
        case .fa: "نشست شما منقضی شد. دوباره وارد شوید."
        case .tr: "Oturumunuzun süresi doldu. Lütfen tekrar giriş yapın."
        case .ar: "انتهت جلستك. يُرجى تسجيل الدخول مجددًا."
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
        case .ar: "هناك شيء غير صالح في هذا الطلب."
        }
    }

    static func errorNotAllowed(_ l: Language) -> String {
        switch l {
        case .en: "You don't have access to do that."
        case .fa: "برای این کار دسترسی ندارید."
        case .tr: "Bu işlem için yetkiniz yok."
        case .ar: "ليست لديك صلاحية للقيام بذلك."
        }
    }

    static func errorNotFound(_ l: Language) -> String {
        switch l {
        case .en: "That couldn't be found."
        case .fa: "این مورد پیدا نشد."
        case .tr: "Bu kayıt bulunamadı."
        case .ar: "تعذّر العثور على ذلك."
        }
    }

    static func errorConflict(_ l: Language) -> String {
        switch l {
        case .en: "That changed since you opened it. Try again."
        case .fa: "این مورد در این فاصله تغییر کرده است. دوباره تلاش کنید."
        case .tr: "Bu kayıt siz açtıktan sonra değişti. Tekrar deneyin."
        case .ar: "تغيّر هذا منذ أن فتحته. حاول مرة أخرى."
        }
    }

    static func errorTooManyRequests(_ l: Language) -> String {
        switch l {
        case .en: "Too many attempts. Wait a moment and try again."
        case .fa: "تلاش‌ها بیش از حد بود. کمی صبر کنید و دوباره تلاش کنید."
        case .tr: "Çok fazla deneme yapıldı. Biraz bekleyip tekrar deneyin."
        case .ar: "محاولات كثيرة جدًا. انتظر قليلًا ثم حاول مرة أخرى."
        }
    }

    static func errorServerProblem(_ l: Language) -> String {
        switch l {
        case .en: "The server ran into a problem. Try again shortly."
        case .fa: "سرور به مشکل خورد. کمی بعد دوباره تلاش کنید."
        case .tr: "Sunucuda bir sorun oluştu. Birazdan tekrar deneyin."
        case .ar: "واجه الخادم مشكلة. حاول مرة أخرى بعد قليل."
        }
    }

    static func errorUnreadableAnswer(_ l: Language) -> String {
        switch l {
        case .en: "The server's answer couldn't be read. Update the app if this keeps happening."
        case .fa: "پاسخ سرور خوانده نشد. اگر تکرار شد، اپ را به‌روز کنید."
        case .tr: "Sunucunun yanıtı okunamadı. Sorun sürerse uygulamayı güncelleyin."
        case .ar: "تعذّرت قراءة رد الخادم. حدّث التطبيق إذا تكرر ذلك."
        }
    }

    static func unknownVisitor(_ l: Language) -> String {
        switch l {
        case .en: "Visitor"
        case .fa: "بازدیدکننده"
        case .tr: "Ziyaretçi"
        case .ar: "زائر"
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
        case .ar: "عوامل التصفية"
        }
    }

    static func clearFilters(_ l: Language) -> String {
        switch l {
        case .en: "Clear"
        case .fa: "پاک کردن"
        case .tr: "Temizle"
        case .ar: "مسح"
        }
    }

    static func apply(_ l: Language) -> String {
        switch l {
        case .en: "Apply"
        case .fa: "اعمال"
        case .tr: "Uygula"
        case .ar: "تطبيق"
        }
    }

    static func done(_ l: Language) -> String {
        switch l {
        case .en: "Done"
        case .fa: "تمام"
        case .tr: "Bitti"
        case .ar: "تم"
        }
    }

    static func filterByName(_ l: Language) -> String {
        switch l {
        case .en: "Contact name"
        case .fa: "نام مخاطب"
        case .tr: "Kişi adı"
        case .ar: "اسم جهة الاتصال"
        }
    }

    static func filterByEmail(_ l: Language) -> String {
        switch l {
        case .en: "Email address"
        case .fa: "نشانی ایمیل"
        case .tr: "E-posta adresi"
        case .ar: "عنوان البريد الإلكتروني"
        }
    }

    static func filterBySubject(_ l: Language) -> String {
        switch l {
        case .en: "Subject"
        case .fa: "موضوع"
        case .tr: "Konu"
        case .ar: "الموضوع"
        }
    }

    static func activeFilters(_ count: Int, _ l: Language) -> String {
        let text = Format.number(count, language: l)
        switch l {
        case .en: return count == 1 ? "1 filter" : "\(text) filters"
        case .fa: return "\(text) پالایه"
        case .tr: return "\(text) filtre"
        case .ar: return Format.arabicCount(count, one: "عامل تصفية واحد", two: "عاملا تصفية", few: "عوامل تصفية", many: "عامل تصفية")
        }
    }

    // MARK: Conversation menu

    static func conversationActions(_ l: Language) -> String {
        switch l {
        case .en: "Conversation"
        case .fa: "گفت‌وگو"
        case .tr: "Görüşme"
        case .ar: "المحادثة"
        }
    }

    static func transferConversation(_ l: Language) -> String {
        switch l {
        case .en: "Transfer"
        case .fa: "انتقال مکالمه"
        case .tr: "Aktar"
        case .ar: "تحويل"
        }
    }

    static func changeStatus(_ l: Language) -> String {
        switch l {
        case .en: "Status"
        case .fa: "وضعیت مکالمه"
        case .tr: "Durum"
        case .ar: "الحالة"
        }
    }

    static func changePriority(_ l: Language) -> String {
        switch l {
        case .en: "Priority"
        case .fa: "اولویت"
        case .tr: "Öncelik"
        case .ar: "الأولوية"
        }
    }

    static func tags(_ l: Language) -> String {
        switch l {
        case .en: "Tags"
        case .fa: "برچسب‌ها"
        case .tr: "Etiketler"
        case .ar: "الوسوم"
        }
    }

    static func addTag(_ l: Language) -> String {
        switch l {
        case .en: "Add a tag"
        case .fa: "افزودن برچسب"
        case .tr: "Etiket ekle"
        case .ar: "إضافة وسم"
        }
    }

    static func noTags(_ l: Language) -> String {
        switch l {
        case .en: "No tags yet"
        case .fa: "هنوز برچسبی نیست"
        case .tr: "Henüz etiket yok"
        case .ar: "لا توجد وسوم بعد"
        }
    }

    static func internalNotes(_ l: Language) -> String {
        switch l {
        case .en: "Internal notes"
        case .fa: "یادداشت داخلی"
        case .tr: "İç notlar"
        case .ar: "الملاحظات الداخلية"
        }
    }

    static func notesPrivacyNote(_ l: Language) -> String {
        switch l {
        case .en: "Only your team can see these. The visitor never does."
        case .fa: "فقط هم‌تیمی‌های شما این‌ها را می‌بینند؛ بازدیدکننده هرگز."
        case .tr: "Bunları yalnızca ekibiniz görür; ziyaretçi asla görmez."
        case .ar: "لا يراها إلا فريقك، ولا يراها الزائر أبدًا."
        }
    }

    static func noNotes(_ l: Language) -> String {
        switch l {
        case .en: "No notes yet"
        case .fa: "هنوز یادداشتی نیست"
        case .tr: "Henüz not yok"
        case .ar: "لا توجد ملاحظات بعد"
        }
    }

    static func writeNote(_ l: Language) -> String {
        switch l {
        case .en: "Write a note"
        case .fa: "یادداشتی بنویسید"
        case .tr: "Bir not yazın"
        case .ar: "اكتب ملاحظة"
        }
    }

    static func unassigned(_ l: Language) -> String {
        switch l {
        case .en: "Unassigned"
        case .fa: "بدون مسئول"
        case .tr: "Atanmamış"
        case .ar: "غير مسندة"
        }
    }

    static func statusPending(_ l: Language) -> String {
        switch l {
        case .en: "Pending"
        case .fa: "در انتظار"
        case .tr: "Beklemede"
        case .ar: "قيد الانتظار"
        }
    }

    static func statusClosed(_ l: Language) -> String {
        switch l {
        case .en: "Closed"
        case .fa: "بسته"
        case .tr: "Kapalı"
        case .ar: "مغلقة"
        }
    }

    static func priorityLow(_ l: Language) -> String {
        switch l {
        case .en: "Low"
        case .fa: "کم"
        case .tr: "Düşük"
        case .ar: "منخفضة"
        }
    }

    static func priorityNormal(_ l: Language) -> String {
        switch l {
        case .en: "Normal"
        case .fa: "عادی"
        case .tr: "Normal"
        case .ar: "عادية"
        }
    }

    // MARK: Calls

    static func voiceCall(_ l: Language) -> String {
        switch l {
        case .en: "Voice call"
        case .fa: "تماس صوتی"
        case .tr: "Sesli arama"
        case .ar: "مكالمة صوتية"
        }
    }

    static func videoCall(_ l: Language) -> String {
        switch l {
        case .en: "Video call"
        case .fa: "تماس تصویری"
        case .tr: "Görüntülü arama"
        case .ar: "مكالمة فيديو"
        }
    }

    static func inviteSent(_ l: Language) -> String {
        switch l {
        case .en: "Waiting for the visitor to accept"
        case .fa: "در انتظار پذیرش بازدیدکننده"
        case .tr: "Ziyaretçinin kabul etmesi bekleniyor"
        case .ar: "بانتظار قبول الزائر"
        }
    }

    static func inviteFailed(_ l: Language) -> String {
        switch l {
        case .en: "The call could not be started"
        case .fa: "تماس آغاز نشد"
        case .tr: "Arama başlatılamadı"
        case .ar: "تعذّر بدء المكالمة"
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
        case .ar: "جارٍ الاتصال…"
        }
    }

    static func hangUpCall(_ l: Language) -> String {
        switch l {
        case .en: "End"
        case .fa: "پایان"
        case .tr: "Bitir"
        case .ar: "إنهاء"
        }
    }

    static func mute(_ l: Language) -> String {
        switch l {
        case .en: "Mute"
        case .fa: "بی‌صدا"
        case .tr: "Sessiz"
        case .ar: "كتم"
        }
    }

    static func camera(_ l: Language) -> String {
        switch l {
        case .en: "Camera"
        case .fa: "دوربین"
        case .tr: "Kamera"
        case .ar: "الكاميرا"
        }
    }

    static func speaker(_ l: Language) -> String {
        switch l {
        case .en: "Speaker"
        case .fa: "بلندگو"
        case .tr: "Hoparlör"
        case .ar: "مكبر الصوت"
        }
    }

    static func callEnded(_ l: Language) -> String {
        switch l {
        case .en: "Call ended"
        case .fa: "تماس پایان یافت"
        case .tr: "Arama bitti"
        case .ar: "انتهت المكالمة"
        }
    }

    static func callDeclined(_ l: Language) -> String {
        switch l {
        case .en: "The visitor declined"
        case .fa: "بازدیدکننده نپذیرفت"
        case .tr: "Ziyaretçi reddetti"
        case .ar: "رفض الزائر المكالمة"
        }
    }

    static func callNoAnswer(_ l: Language) -> String {
        switch l {
        case .en: "No answer"
        case .fa: "پاسخی داده نشد"
        case .tr: "Yanıt yok"
        case .ar: "لا يوجد رد"
        }
    }

    static func callFailed(_ l: Language) -> String {
        switch l {
        case .en: "The call could not connect"
        case .fa: "تماس برقرار نشد"
        case .tr: "Arama bağlanamadı"
        case .ar: "تعذّر اتصال المكالمة"
        }
    }

    static func callRelayWarning(_ l: Language) -> String {
        switch l {
        case .en: "No relay server configured — this call may fail on some networks"
        case .fa: "سرور رله تنظیم نشده — ممکن است روی بعضی شبکه‌ها برقرار نشود"
        case .tr: "Röle sunucusu tanımlı değil — bazı ağlarda bağlanmayabilir"
        case .ar: "لم يُضبط خادم ترحيل — قد تفشل هذه المكالمة على بعض الشبكات"
        }
    }
}

extension Str {

    static func callNoMicrophone(_ l: Language) -> String {
        switch l {
        case .en: "Your microphone is unavailable — they cannot hear you"
        case .fa: "میکروفون در دسترس نیست — صدای شما را نمی‌شنوند"
        case .tr: "Mikrofonunuz kullanılamıyor — sizi duyamıyorlar"
        case .ar: "الميكروفون غير متاح — لا يمكنهم سماعك"
        }
    }

    static func callNoCamera(_ l: Language) -> String {
        switch l {
        case .en: "Camera unavailable — continuing with audio only"
        case .fa: "دوربین در دسترس نیست — تماس فقط صوتی ادامه دارد"
        case .tr: "Kamera kullanılamıyor — yalnızca sesle devam ediliyor"
        case .ar: "الكاميرا غير متاحة — تستمر المكالمة بالصوت فقط"
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
        case .ar: text = "{actor} حوّل هذه المحادثة إلى {to}"
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
        case .ar: text = "{actor} ألغى إسناد هذه المحادثة"
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
        case .ar: text = "{name} انضم إلى المحادثة"
        }
        return text
            .replacingOccurrences(of: "{name}", with: name)
    }

    static func sysAgentJoinedGeneric(_ l: Language) -> String {
        switch l {
        case .en: "A colleague joined the conversation"
        case .fa: "یکی از همکاران به گفتگو پیوست"
        case .tr: "Bir meslektaşımız sohbete katıldı"
        case .ar: "انضم زميل إلى المحادثة"
        }
    }

    static func sysNoAgentAvailable(_ l: Language) -> String {
        switch l {
        case .en: "All our colleagues are currently busy. Your message was recorded and we'll respond as soon as we can."
        case .fa: "همه همکاران در حال حاضر مشغول هستند. پیام شما ثبت شد و در اولین فرصت پاسخ می‌دهیم."
        case .tr: "Tüm ekibimiz şu anda meşgul. Mesajınız kaydedildi, en kısa sürede yanıtlayacağız."
        case .ar: "جميع زملائنا مشغولون حاليًا. سُجّلت رسالتك وسنرد في أقرب وقت ممكن."
        }
    }

    static func sysInQueue(_ l: Language) -> String {
        switch l {
        case .en: "You are in the queue — someone will be with you shortly."
        case .fa: "در صف هستید — به‌زودی همکاری پاسخ می‌دهد."
        case .tr: "Sıradasınız — kısa süre içinde bir ekip arkadaşımız yanıtlayacak."
        case .ar: "أنت في قائمة الانتظار — سيكون أحدنا معك قريبًا."
        }
    }

    static func sysCallInviteAudio(_ l: Language) -> String {
        switch l {
        case .en: "Visitor invited to an audio call"
        case .fa: "کاربر به تماس صوتی دعوت شد"
        case .tr: "Ziyaretçi sesli aramaya davet edildi"
        case .ar: "دُعي الزائر إلى مكالمة صوتية"
        }
    }

    static func sysCallInviteVideo(_ l: Language) -> String {
        switch l {
        case .en: "Visitor invited to a video call"
        case .fa: "کاربر به تماس تصویری دعوت شد"
        case .tr: "Ziyaretçi görüntülü aramaya davet edildi"
        case .ar: "دُعي الزائر إلى مكالمة فيديو"
        }
    }

    static func sysCallInviteAudioFrom(_ l: Language, op: String) -> String {
        let text: String
        switch l {
        case .en: text = "{op} invited the visitor to an audio call"
        case .fa: text = "{op} کاربر را به تماس صوتی دعوت کرد"
        case .tr: text = "{op} ziyaretçiyi sesli aramaya davet etti"
        case .ar: text = "{op} دعا الزائر إلى مكالمة صوتية"
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
        case .ar: text = "{op} دعا الزائر إلى مكالمة فيديو"
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
        case .ar: text = "أنهى الموظف المكالمة · المدة {duration}"
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
        case .ar: text = "أنهى الزائر المكالمة · المدة {duration}"
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
        case .ar: text = "انتهت المكالمة · المدة {duration}"
        }
        return text
            .replacingOccurrences(of: "{duration}", with: duration)
    }

    static func callEndedNotConnected(_ l: Language) -> String {
        switch l {
        case .en: "Call did not connect"
        case .fa: "تماس برقرار نشد"
        case .tr: "Görüşme bağlanamadı"
        case .ar: "تعذّر اتصال المكالمة"
        }
    }

    static func inviteStatusPending(_ l: Language) -> String {
        switch l {
        case .en: "Pending"
        case .fa: "در انتظار"
        case .tr: "Bekliyor"
        case .ar: "قيد الانتظار"
        }
    }

    static func inviteStatusJoined(_ l: Language) -> String {
        switch l {
        case .en: "Joined"
        case .fa: "پیوست"
        case .tr: "Katıldı"
        case .ar: "انضم"
        }
    }

    static func inviteStatusExpired(_ l: Language) -> String {
        switch l {
        case .en: "Expired"
        case .fa: "منقضی"
        case .tr: "Süresi doldu"
        case .ar: "منتهية"
        }
    }

    static func inviteStatusCancelled(_ l: Language) -> String {
        switch l {
        case .en: "Cancelled"
        case .fa: "لغو شد"
        case .tr: "İptal edildi"
        case .ar: "ملغاة"
        }
    }

    static func inviteStatusDeclined(_ l: Language) -> String {
        switch l {
        case .en: "Declined"
        case .fa: "رد شد"
        case .tr: "Reddedildi"
        case .ar: "مرفوضة"
        }
    }

    static func previewSomeone(_ l: Language) -> String {
        switch l {
        case .en: "A user"
        case .fa: "کاربر"
        case .tr: "Bir kullanıcı"
        case .ar: "مستخدم"
        }
    }

    static func previewYouSentImage(_ l: Language) -> String {
        switch l {
        case .en: "You sent a photo"
        case .fa: "شما یک تصویر ارسال کردید"
        case .tr: "Bir fotoğraf gönderdiniz"
        case .ar: "أرسلت صورة"
        }
    }

    static func previewYouSentAudio(_ l: Language) -> String {
        switch l {
        case .en: "You sent a voice message"
        case .fa: "شما یک پیام صوتی ارسال کردید"
        case .tr: "Bir sesli mesaj gönderdiniz"
        case .ar: "أرسلت رسالة صوتية"
        }
    }

    static func previewYouSentVideo(_ l: Language) -> String {
        switch l {
        case .en: "You sent a video"
        case .fa: "شما یک ویدیو ارسال کردید"
        case .tr: "Bir video gönderdiniz"
        case .ar: "أرسلت فيديو"
        }
    }

    static func previewYouSentFile(_ l: Language) -> String {
        switch l {
        case .en: "You sent a file"
        case .fa: "شما یک فایل ارسال کردید"
        case .tr: "Bir dosya gönderdiniz"
        case .ar: "أرسلت ملفًا"
        }
    }

    static func previewSentByImage(_ l: Language, name: String) -> String {
        let text: String
        switch l {
        case .en: text = "{name} sent a photo"
        case .fa: text = "{name} یک تصویر ارسال کرد"
        case .tr: text = "{name} bir fotoğraf gönderdi"
        case .ar: text = "{name} أرسل صورة"
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
        case .ar: text = "{name} أرسل رسالة صوتية"
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
        case .ar: text = "{name} أرسل فيديو"
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
        case .ar: text = "{name} أرسل ملفًا"
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
        case .ar: "حاسوب"
        }
    }

    static func deviceMobile(_ l: Language) -> String {
        switch l {
        case .en: "Mobile"
        case .fa: "موبایل"
        case .tr: "Mobil"
        case .ar: "جوال"
        }
    }

    static func deviceTablet(_ l: Language) -> String {
        switch l {
        case .en: "Tablet"
        case .fa: "تبلت"
        case .tr: "Tablet"
        case .ar: "جهاز لوحي"
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
        case .ar: "جارٍ الاستلام…"
        }
    }

    static func attachmentFailed(_ l: Language) -> String {
        switch l {
        case .en: "Could not load this file."
        case .fa: "این فایل بارگیری نشد."
        case .tr: "Bu dosya yüklenemedi."
        case .ar: "تعذّر تحميل هذا الملف."
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
        case .ar: "لا يمكن تشغيل هذه الصيغة هنا."
        }
    }

    static func photo(_ l: Language) -> String {
        switch l {
        case .en: "Photo"
        case .fa: "تصویر"
        case .tr: "Fotoğraf"
        case .ar: "صورة"
        }
    }

    static func videoFile(_ l: Language) -> String {
        switch l {
        case .en: "Video"
        case .fa: "ویدیو"
        case .tr: "Video"
        case .ar: "فيديو"
        }
    }

    static func file(_ l: Language) -> String {
        switch l {
        case .en: "File"
        case .fa: "فایل"
        case .tr: "Dosya"
        case .ar: "ملف"
        }
    }

    static func notNow(_ l: Language) -> String {
        switch l {
        case .en: "Not now"
        case .fa: "الان نه"
        case .tr: "Şimdi değil"
        case .ar: "ليس الآن"
        }
    }

    static func close(_ l: Language) -> String {
        switch l {
        case .en: "Close"
        case .fa: "بستن"
        case .tr: "Kapat"
        case .ar: "إغلاق"
        }
    }

    /// Byte units. Latin abbreviations in English and Turkish; Persian has its
    /// own words for these and the console uses them.
    static func unitBytes(_ l: Language) -> String {
        switch l {
        case .en, .tr: "B"
        case .ar: "بايت"
        case .fa: "بایت"
        }
    }

    static func unitKilobytes(_ l: Language) -> String {
        switch l {
        case .en, .tr: "KB"
        case .ar: "ك.ب"
        case .fa: "کیلوبایت"
        }
    }

    static func unitMegabytes(_ l: Language) -> String {
        switch l {
        case .en, .tr: "MB"
        case .ar: "م.ب"
        case .fa: "مگابایت"
        }
    }

    // MARK: - Sending a file

    static func sendPhoto(_ l: Language) -> String {
        switch l {
        case .en: "Photo or video"
        case .fa: "تصویر یا ویدیو"
        case .tr: "Fotoğraf veya video"
        case .ar: "صورة أو فيديو"
        }
    }

    static func sendDocument(_ l: Language) -> String {
        switch l {
        case .en: "Document"
        case .fa: "سند"
        case .tr: "Belge"
        case .ar: "مستند"
        }
    }

    static func sendingFile(_ l: Language) -> String {
        switch l {
        case .en: "Sending…"
        case .fa: "در حال ارسال…"
        case .tr: "Gönderiliyor…"
        case .ar: "جارٍ الإرسال…"
        }
    }

    static func fileTooLarge(_ l: Language) -> String {
        switch l {
        case .en: "That file is over 25 MB."
        case .fa: "این فایل از ۲۵ مگابایت بزرگ‌تر است."
        case .tr: "Bu dosya 25 MB'tan büyük."
        case .ar: "حجم هذا الملف أكبر من ٢٥ ميغابايت."
        }
    }

    static func fileTypeNotAllowed(_ l: Language) -> String {
        switch l {
        case .en: "That kind of file can't be sent."
        case .fa: "این نوع فایل قابل ارسال نیست."
        case .tr: "Bu tür bir dosya gönderilemez."
        case .ar: "لا يمكن إرسال هذا النوع من الملفات."
        }
    }

    // MARK: - Recording

    static func recording(_ l: Language) -> String {
        switch l {
        case .en: "Recording"
        case .fa: "در حال ضبط"
        case .tr: "Kaydediliyor"
        case .ar: "جارٍ التسجيل"
        }
    }

    /// Shown when the microphone was refused. It points at Settings because
    /// that is the only place the answer can be changed once it is given.
    static func microphoneDenied(_ l: Language) -> String {
        switch l {
        case .en: "Allow microphone access in Settings to record a voice note."
        case .fa: "برای ضبط پیام صوتی، دسترسی به میکروفون را در تنظیمات اجازه دهید."
        case .tr: "Sesli mesaj kaydetmek için Ayarlar'dan mikrofon erişimine izin verin."
        case .ar: "اسمح بالوصول إلى الميكروفون من الإعدادات لتسجيل رسالة صوتية."
        }
    }

    static func recordingFailed(_ l: Language) -> String {
        switch l {
        case .en: "Recording could not start."
        case .fa: "ضبط شروع نشد."
        case .tr: "Kayıt başlatılamadı."
        case .ar: "تعذّر بدء التسجيل."
        }
    }

    static func discard(_ l: Language) -> String {
        switch l {
        case .en: "Discard"
        case .fa: "دور انداختن"
        case .tr: "At"
        case .ar: "تجاهل"
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
        case .ar: "ماذا تريد أن تقول للزائر؟"
        }
    }

    /// The line in the AI composer's tool row, as the Mac app has it: what
    /// happens to the operator's words once they are sent.
    static func sayNowHint(_ l: Language) -> String {
        switch l {
        case .en: "The AI rewrites your words and sends them to the visitor now."
        case .fa: "هوش مصنوعی حرف شما را بازنویسی می‌کند و همین حالا برای بازدیدکننده می‌فرستد."
        case .tr: "Yapay zekâ sözlerinizi yeniden yazar ve ziyaretçiye hemen gönderir."
        case .ar: "يعيد الذكاء الاصطناعي صياغة كلماتك ويرسلها إلى الزائر الآن."
        }
    }

    /// The AI send button, spoken. Its glyph is the AI's sparkles, but a
    /// glyph says nothing to VoiceOver.
    static func sayNowAction(_ l: Language) -> String {
        switch l {
        case .en: "Send with AI"
        case .fa: "ارسال با هوش مصنوعی"
        case .tr: "Yapay zekâ ile gönder"
        case .ar: "الإرسال عبر الذكاء الاصطناعي"
        }
    }

    static func sayNowSent(_ l: Language) -> String {
        switch l {
        case .en: "The AI sent your message to the visitor"
        case .fa: "پیام با هوش مصنوعی برای بازدیدکننده ارسال شد"
        case .tr: "Mesajınız yapay zekâ ile ziyaretçiye gönderildi"
        case .ar: "أرسل الذكاء الاصطناعي رسالتك إلى الزائر"
        }
    }

    static func sayNowFailed(_ l: Language) -> String {
        switch l {
        case .en: "Could not send the message"
        case .fa: "ارسال پیام ممکن نشد"
        case .tr: "Mesaj gönderilemedi"
        case .ar: "تعذّر إرسال الرسالة"
        }
    }

    /// What the voice button picks, for VoiceOver. Its value is read out
    /// separately, so this names the choice and not the current answer.
    static func sayNowVoice(_ l: Language) -> String {
        switch l {
        case .en: "Voice"
        case .fa: "زبان پیام"
        case .tr: "Mesajın dili"
        case .ar: "أسلوب الرسالة"
        }
    }

    static func sayNowVoiceSpecialist(_ l: Language) -> String {
        switch l {
        case .en: "In a specialist's voice"
        case .fa: "از زبان کارشناس"
        case .tr: "Uzman dilinden"
        case .ar: "بأسلوب أخصائي"
        }
    }

    static func sayNowVoiceAssistant(_ l: Language) -> String {
        switch l {
        case .en: "In the AI's voice"
        case .fa: "از زبان هوش مصنوعی"
        case .tr: "Yapay zekâ dilinden"
        case .ar: "بأسلوب الذكاء الاصطناعي"
        }
    }

    // MARK: - Take over

    static func takeOver(_ l: Language) -> String {
        switch l {
        case .en: "Take over"
        case .fa: "در دست گرفتن"
        case .tr: "Devral"
        case .ar: "تولّي المحادثة"
        }
    }

    static func takenOver(_ l: Language) -> String {
        switch l {
        case .en: "The conversation is yours — the AI has stopped replying."
        case .fa: "مکالمه در اختیار شما قرار گرفت — هوش مصنوعی دیگر پاسخ خودکار نمی‌دهد."
        case .tr: "Görüşme sizde — yapay zekâ artık otomatik yanıt vermiyor."
        case .ar: "المحادثة لك الآن — توقف الذكاء الاصطناعي عن الرد."
        }
    }

    static func takeOverFailed(_ l: Language) -> String {
        switch l {
        case .en: "Take-over failed"
        case .fa: "در دست گرفتن ناموفق بود"
        case .tr: "Devralma başarısız oldu"
        case .ar: "تعذّر تولّي المحادثة"
        }
    }

    // MARK: - Online visitors

    /// The Visitors tab. Short, because it shares the bar with four others.
    static func tabVisitors(_ l: Language) -> String {
        switch l {
        case .en: "Visitors"
        case .fa: "بازدیدکنندگان"
        case .tr: "Ziyaretçiler"
        case .ar: "الزوار"
        }
    }

    static func visitorsTitle(_ l: Language) -> String {
        switch l {
        case .en: "Online Visitors"
        case .fa: "بازدیدکنندگان آنلاین"
        case .tr: "Çevrimiçi Ziyaretçiler"
        case .ar: "الزوار المتصلون"
        }
    }

    static func visitorsSubtitle(_ l: Language) -> String {
        switch l {
        case .en: "Real-time visitor intelligence"
        case .fa: "هوش لحظه‌ای بازدیدکنندگان"
        case .tr: "Gerçek zamanlı ziyaretçi zekâsı"
        case .ar: "معلومات الزوار لحظة بلحظة"
        }
    }

    static func visitorsSearchPrompt(_ l: Language) -> String {
        switch l {
        case .en: "Search by page, country, browser…"
        case .fa: "جست‌وجو بر اساس صفحه، کشور، مرورگر…"
        case .tr: "Sayfa, ülke, tarayıcı ile ara…"
        case .ar: "ابحث بالصفحة أو الدولة أو المتصفح…"
        }
    }

    /// The list half of the list / map switch.
    static func visitorsList(_ l: Language) -> String {
        switch l {
        case .en: "List"
        case .fa: "فهرست"
        case .tr: "Liste"
        case .ar: "قائمة"
        }
    }

    static func visitorsMap(_ l: Language) -> String {
        switch l {
        case .en: "Map"
        case .fa: "نقشه"
        case .tr: "Harita"
        case .ar: "خريطة"
        }
    }

    static func visitorsFilters(_ l: Language) -> String {
        switch l {
        case .en: "Filters"
        case .fa: "فیلترها"
        case .tr: "Filtreler"
        case .ar: "عوامل التصفية"
        }
    }

    static func visitorsFilterOnline(_ l: Language) -> String {
        switch l {
        case .en: "Online only"
        case .fa: "فقط آنلاین"
        case .tr: "Yalnızca çevrimiçi"
        case .ar: "المتصلون فقط"
        }
    }

    static func visitorsFilterInChat(_ l: Language) -> String {
        switch l {
        case .en: "Has conversation"
        case .fa: "دارای گفت‌وگو"
        case .tr: "Sohbeti olan"
        case .ar: "لديه محادثة"
        }
    }

    static func visitorsFilterCountry(_ l: Language) -> String {
        switch l {
        case .en: "Country"
        case .fa: "کشور"
        case .tr: "Ülke"
        case .ar: "الدولة"
        }
    }

    static func visitorsAllCountries(_ l: Language) -> String {
        switch l {
        case .en: "All countries"
        case .fa: "همه کشورها"
        case .tr: "Tüm ülkeler"
        case .ar: "كل الدول"
        }
    }

    static func visitorsIncludeOffline(_ l: Language) -> String {
        switch l {
        case .en: "Include offline"
        case .fa: "نمایش آفلاین‌ها"
        case .tr: "Çevrimdışıları göster"
        case .ar: "تضمين غير المتصلين"
        }
    }

    static func visitorsClearFilters(_ l: Language) -> String {
        switch l {
        case .en: "Clear filters"
        case .fa: "پاک کردن فیلترها"
        case .tr: "Filtreleri temizle"
        case .ar: "مسح عوامل التصفية"
        }
    }

    static func visitorsStatOnline(_ l: Language) -> String {
        switch l {
        case .en: "Online"
        case .fa: "آنلاین"
        case .tr: "Çevrimiçi"
        case .ar: "متصلون"
        }
    }

    static func visitorsStatActive(_ l: Language) -> String {
        switch l {
        case .en: "Active now"
        case .fa: "فعال"
        case .tr: "Şu an aktif"
        case .ar: "نشطون الآن"
        }
    }

    static func visitorsStatCountries(_ l: Language) -> String {
        switch l {
        case .en: "Countries"
        case .fa: "کشورها"
        case .tr: "Ülkeler"
        case .ar: "الدول"
        }
    }

    static func visitorsStatPages(_ l: Language) -> String {
        switch l {
        case .en: "Pages"
        case .fa: "صفحات"
        case .tr: "Sayfalar"
        case .ar: "الصفحات"
        }
    }

    static func visitorsEmptyTitle(_ l: Language) -> String {
        switch l {
        case .en: "No visitors right now"
        case .fa: "بازدیدکننده‌ای حضور ندارد"
        case .tr: "Şu anda ziyaretçi yok"
        case .ar: "لا يوجد زوار الآن"
        }
    }

    static func visitorsEmptyBody(_ l: Language) -> String {
        switch l {
        case .en: "Live visitors browsing your site will appear here."
        case .fa: "بازدیدکنندگانی که همین حالا در سایت شما هستند اینجا نمایش داده می‌شوند."
        case .tr: "Sitenizdeki canlı ziyaretçiler burada görünecek."
        case .ar: "سيظهر هنا الزوار الذين يتصفحون موقعك مباشرةً."
        }
    }

    static func visitorsNoResults(_ l: Language) -> String {
        switch l {
        case .en: "No visitors match your filters"
        case .fa: "بازدیدکننده‌ای با این فیلترها یافت نشد"
        case .tr: "Filtrelerinizle eşleşen ziyaretçi yok"
        case .ar: "لا يوجد زوار يطابقون عوامل التصفية"
        }
    }

    static func visitorsErrorTitle(_ l: Language) -> String {
        switch l {
        case .en: "Could not load visitors"
        case .fa: "بارگذاری بازدیدکنندگان ناموفق بود"
        case .tr: "Ziyaretçiler yüklenemedi"
        case .ar: "تعذّر تحميل الزوار"
        }
    }

    static func visitorsJustNow(_ l: Language) -> String {
        switch l {
        case .en: "just now"
        case .fa: "هم‌اکنون"
        case .tr: "şimdi"
        case .ar: "الآن"
        }
    }

    /// A template: `{n}` is replaced with the number in the reader's digits.
    static func visitorsMinutesAgo(_ l: Language) -> String {
        switch l {
        case .en: "{n}m ago"
        case .fa: "{n} دقیقه پیش"
        case .tr: "{n} dk önce"
        case .ar: "منذ {n} د"
        }
    }

    /// A template: `{n}` is replaced with the number in the reader's digits.
    static func visitorsHoursAgo(_ l: Language) -> String {
        switch l {
        case .en: "{n}h ago"
        case .fa: "{n} ساعت پیش"
        case .tr: "{n} sa önce"
        case .ar: "منذ {n} س"
        }
    }

    static func visitorsUnknownLocation(_ l: Language) -> String {
        switch l {
        case .en: "Unknown location"
        case .fa: "موقعیت نامشخص"
        case .tr: "Bilinmeyen konum"
        case .ar: "موقع غير معروف"
        }
    }

    /// Under the map. A template: `{n}` is replaced with the number.
    static func visitorsWithoutLocation(_ l: Language) -> String {
        switch l {
        case .en: "{n} without a known location"
        case .fa: "{n} نفر بدون موقعیت مشخص"
        case .tr: "Konumu bilinmeyen {n} kişi"
        case .ar: "{n} بلا موقع معروف"
        }
    }

    static func visitorStatusOnline(_ l: Language) -> String {
        switch l {
        case .en: "Online"
        case .fa: "آنلاین"
        case .tr: "Çevrimiçi"
        case .ar: "متصل"
        }
    }

    static func visitorStatusIdle(_ l: Language) -> String {
        switch l {
        case .en: "Idle"
        case .fa: "غیرفعال"
        case .tr: "Boşta"
        case .ar: "خامل"
        }
    }

    static func visitorStatusOffline(_ l: Language) -> String {
        switch l {
        case .en: "Offline"
        case .fa: "آفلاین"
        case .tr: "Çevrimdışı"
        case .ar: "غير متصل"
        }
    }

    static func visitorInChat(_ l: Language) -> String {
        switch l {
        case .en: "In chat"
        case .fa: "در گفت‌وگو"
        case .tr: "Sohbette"
        case .ar: "في محادثة"
        }
    }

    static func visitorDetails(_ l: Language) -> String {
        switch l {
        case .en: "Visitor details"
        case .fa: "جزئیات بازدیدکننده"
        case .tr: "Ziyaretçi detayları"
        case .ar: "تفاصيل الزائر"
        }
    }

    static func visitorCurrentPage(_ l: Language) -> String {
        switch l {
        case .en: "Current page"
        case .fa: "صفحه فعلی"
        case .tr: "Mevcut sayfa"
        case .ar: "الصفحة الحالية"
        }
    }

    static func visitorLocation(_ l: Language) -> String {
        switch l {
        case .en: "Location"
        case .fa: "موقعیت"
        case .tr: "Konum"
        case .ar: "الموقع الجغرافي"
        }
    }

    static func visitorIPAddress(_ l: Language) -> String {
        switch l {
        case .en: "IP address"
        case .fa: "آدرس IP"
        case .tr: "IP adresi"
        case .ar: "عنوان IP"
        }
    }

    static func visitorBrowserOS(_ l: Language) -> String {
        switch l {
        case .en: "Browser · OS"
        case .fa: "مرورگر · سیستم‌عامل"
        case .tr: "Tarayıcı · İşletim sistemi"
        case .ar: "المتصفح · نظام التشغيل"
        }
    }

    static func visitorDevice(_ l: Language) -> String {
        switch l {
        case .en: "Device"
        case .fa: "دستگاه"
        case .tr: "Cihaz"
        case .ar: "الجهاز"
        }
    }

    static func visitorReferrer(_ l: Language) -> String {
        switch l {
        case .en: "Referrer"
        case .fa: "ارجاع‌دهنده"
        case .tr: "Yönlendiren"
        case .ar: "المصدر المُحيل"
        }
    }

    static func visitorDirect(_ l: Language) -> String {
        switch l {
        case .en: "Direct visit"
        case .fa: "ورود مستقیم"
        case .tr: "Doğrudan ziyaret"
        case .ar: "زيارة مباشرة"
        }
    }

    static func visitorLastActivity(_ l: Language) -> String {
        switch l {
        case .en: "Last activity"
        case .fa: "آخرین فعالیت"
        case .tr: "Son etkinlik"
        case .ar: "آخر نشاط"
        }
    }

    static func visitorPageHistory(_ l: Language) -> String {
        switch l {
        case .en: "Page history"
        case .fa: "تاریخچه صفحات"
        case .tr: "Sayfa geçmişi"
        case .ar: "سجل الصفحات"
        }
    }

    static func visitorPageHistoryEmpty(_ l: Language) -> String {
        switch l {
        case .en: "No page history yet"
        case .fa: "هنوز تاریخچه‌ای ثبت نشده"
        case .tr: "Henüz sayfa geçmişi yok"
        case .ar: "لا يوجد سجل صفحات بعد"
        }
    }

    static func visitorEntryPoint(_ l: Language) -> String {
        switch l {
        case .en: "Entry point"
        case .fa: "نقطه ورود"
        case .tr: "Giriş noktası"
        case .ar: "نقطة الدخول"
        }
    }

    static func visitorJourney(_ l: Language) -> String {
        switch l {
        case .en: "Journey"
        case .fa: "مسیر بازدید"
        case .tr: "Gezinti"
        case .ar: "المسار"
        }
    }

    static func visitorCurrentlyOn(_ l: Language) -> String {
        switch l {
        case .en: "Currently on"
        case .fa: "هم‌اکنون در"
        case .tr: "Şu anda"
        case .ar: "موجود حاليًا في"
        }
    }

    static func visitorStartChat(_ l: Language) -> String {
        switch l {
        case .en: "Start chat"
        case .fa: "شروع گفت‌وگو"
        case .tr: "Sohbet başlat"
        case .ar: "بدء محادثة"
        }
    }

    static func visitorOpenChat(_ l: Language) -> String {
        switch l {
        case .en: "Open chat"
        case .fa: "باز کردن گفت‌وگو"
        case .tr: "Sohbeti aç"
        case .ar: "فتح المحادثة"
        }
    }

    static func visitorCopySession(_ l: Language) -> String {
        switch l {
        case .en: "Copy session ID"
        case .fa: "کپی شناسه نشست"
        case .tr: "Oturum kimliğini kopyala"
        case .ar: "نسخ معرّف الجلسة"
        }
    }

    static func visitorCopied(_ l: Language) -> String {
        switch l {
        case .en: "Copied"
        case .fa: "کپی شد"
        case .tr: "Kopyalandı"
        case .ar: "تم النسخ"
        }
    }

    static func visitorChatFailed(_ l: Language) -> String {
        switch l {
        case .en: "The chat could not be opened. Try again in a moment."
        case .fa: "باز کردن گفت‌وگو ممکن نشد. کمی بعد دوباره امتحان کنید."
        case .tr: "Sohbet açılamadı. Birazdan tekrar deneyin."
        case .ar: "تعذّر فتح المحادثة. حاول مرة أخرى بعد قليل."
        }
    }

    /// Over a visitor's page when they dropped off the live list while it was open.
    static func visitorLeft(_ l: Language) -> String {
        switch l {
        case .en: "This visitor has left the site."
        case .fa: "این بازدیدکننده سایت را ترک کرده است."
        case .tr: "Bu ziyaretçi siteden ayrıldı."
        case .ar: "غادر هذا الزائر الموقع."
        }
    }

    // MARK: - Website analytics

    /// The Analytics tab. Short, because it shares the bar with four others.
    static func tabAnalytics(_ l: Language) -> String {
        switch l {
        case .en: "Analytics"
        case .fa: "آمار"
        case .tr: "Analitik"
        case .ar: "التحليلات"
        }
    }

    static func analyticsTitle(_ l: Language) -> String {
        switch l {
        case .en: "Website analytics"
        case .fa: "تحلیل وب‌سایت"
        case .tr: "Web sitesi analitiği"
        case .ar: "تحليلات الموقع"
        }
    }

    static func analyticsSubtitle(_ l: Language) -> String {
        switch l {
        case .en: "Visits recorded by the chat widget on your site"
        case .fa: "بازدیدهایی که ویجت گفت‌وگو در سایت شما ثبت می‌کند"
        case .tr: "Sohbet widget'ının sitenizde kaydettiği ziyaretler"
        case .ar: "الزيارات التي تسجّلها أداة الدردشة على موقعك"
        }
    }

    /// A template: `{count}` is replaced with the number in the reader's digits.
    static func analyticsLiveNow(_ l: Language) -> String {
        switch l {
        case .en: "{count} on the site now"
        case .fa: "{count} نفر هم‌اکنون در سایت"
        case .tr: "Şu an sitede {count} kişi"
        case .ar: "{count} في الموقع الآن"
        }
    }

    static func analyticsRange7(_ l: Language) -> String {
        switch l {
        case .en: "7 days"
        case .fa: "۷ روز"
        case .tr: "7 gün"
        case .ar: "٧ أيام"
        }
    }

    static func analyticsRange28(_ l: Language) -> String {
        switch l {
        case .en: "28 days"
        case .fa: "۲۸ روز"
        case .tr: "28 gün"
        case .ar: "٢٨ يومًا"
        }
    }

    static func analyticsRange90(_ l: Language) -> String {
        switch l {
        case .en: "90 days"
        case .fa: "۹۰ روز"
        case .tr: "90 gün"
        case .ar: "٩٠ يومًا"
        }
    }

    static func analyticsOverview(_ l: Language) -> String {
        switch l {
        case .en: "Overview"
        case .fa: "نمای کلی"
        case .tr: "Genel bakış"
        case .ar: "نظرة عامة"
        }
    }

    static func analyticsOverviewHint(_ l: Language) -> String {
        switch l {
        case .en: "Visitors, visits and time on site"
        case .fa: "بازدیدکننده‌ها، بازدیدها و زمان حضور"
        case .tr: "Ziyaretçiler, ziyaretler ve sitede geçen süre"
        case .ar: "الزوار والزيارات ومدة البقاء في الموقع"
        }
    }

    static func analyticsSources(_ l: Language) -> String {
        switch l {
        case .en: "Traffic sources"
        case .fa: "منابع ترافیک"
        case .tr: "Trafik kaynakları"
        case .ar: "مصادر الزيارات"
        }
    }

    static func analyticsSourcesHint(_ l: Language) -> String {
        switch l {
        case .en: "Where your visitors come from"
        case .fa: "بازدیدکننده‌ها از کجا می‌آیند"
        case .tr: "Ziyaretçileriniz nereden geliyor"
        case .ar: "من أين يأتي زوارك"
        }
    }

    static func analyticsPages(_ l: Language) -> String {
        switch l {
        case .en: "Pages"
        case .fa: "صفحات"
        case .tr: "Sayfalar"
        case .ar: "الصفحات"
        }
    }

    static func analyticsPagesHint(_ l: Language) -> String {
        switch l {
        case .en: "Most viewed, entry and exit pages"
        case .fa: "پربازدیدترین، صفحات ورود و خروج"
        case .tr: "En çok görüntülenen, giriş ve çıkış sayfaları"
        case .ar: "الأكثر مشاهدة وصفحات الدخول والخروج"
        }
    }

    static func analyticsGeography(_ l: Language) -> String {
        switch l {
        case .en: "Geography"
        case .fa: "جغرافیا"
        case .tr: "Coğrafya"
        case .ar: "الجغرافيا"
        }
    }

    static func analyticsGeographyHint(_ l: Language) -> String {
        switch l {
        case .en: "Countries, cities and languages"
        case .fa: "کشورها، شهرها و زبان‌ها"
        case .tr: "Ülkeler, şehirler ve diller"
        case .ar: "الدول والمدن واللغات"
        }
    }

    static func analyticsTechnology(_ l: Language) -> String {
        switch l {
        case .en: "Devices & browsers"
        case .fa: "دستگاه و مرورگر"
        case .tr: "Cihaz ve tarayıcı"
        case .ar: "الأجهزة والمتصفحات"
        }
    }

    static func analyticsTechnologyHint(_ l: Language) -> String {
        switch l {
        case .en: "Device, operating system and browser"
        case .fa: "نوع دستگاه، سیستم‌عامل و مرورگر"
        case .tr: "Cihaz, işletim sistemi ve tarayıcı"
        case .ar: "الجهاز ونظام التشغيل والمتصفح"
        }
    }

    static func analyticsEvents(_ l: Language) -> String {
        switch l {
        case .en: "Events"
        case .fa: "رویدادها"
        case .tr: "Olaylar"
        case .ar: "الأحداث"
        }
    }

    static func analyticsEventsHint(_ l: Language) -> String {
        switch l {
        case .en: "Custom events from your site"
        case .fa: "رویدادهای سفارشی سایت شما"
        case .tr: "Sitenizden özel olaylar"
        case .ar: "أحداث مخصصة من موقعك"
        }
    }

    static func analyticsVisitors(_ l: Language) -> String {
        switch l {
        case .en: "Visitors"
        case .fa: "بازدیدکننده"
        case .tr: "Ziyaretçi"
        case .ar: "الزوار"
        }
    }

    static func analyticsSessions(_ l: Language) -> String {
        switch l {
        case .en: "Visits"
        case .fa: "بازدید"
        case .tr: "Ziyaret"
        case .ar: "الزيارات"
        }
    }

    static func analyticsPageviews(_ l: Language) -> String {
        switch l {
        case .en: "Page views"
        case .fa: "بازدید صفحه"
        case .tr: "Sayfa görüntüleme"
        case .ar: "مشاهدات الصفحات"
        }
    }

    static func analyticsPagesPerVisit(_ l: Language) -> String {
        switch l {
        case .en: "Pages per visit"
        case .fa: "صفحه در هر بازدید"
        case .tr: "Ziyaret başına sayfa"
        case .ar: "صفحات لكل زيارة"
        }
    }

    static func analyticsBounceRate(_ l: Language) -> String {
        switch l {
        case .en: "Bounce rate"
        case .fa: "نرخ پرش"
        case .tr: "Hemen çıkma oranı"
        case .ar: "معدل الارتداد"
        }
    }

    static func analyticsAvgDuration(_ l: Language) -> String {
        switch l {
        case .en: "Avg. time on site"
        case .fa: "میانگین زمان حضور"
        case .tr: "Ort. sitede kalma"
        case .ar: "متوسط مدة البقاء"
        }
    }

    /// A template: `{count}` is replaced with the number in the reader's digits.
    static func analyticsVsPrevious(_ l: Language) -> String {
        switch l {
        case .en: "Compared with the {count} days before"
        case .fa: "در مقایسه با {count} روز قبل از آن"
        case .tr: "Önceki {count} günle karşılaştırıldığında"
        case .ar: "مقارنةً بالأيام الـ{count} السابقة"
        }
    }

    static func analyticsTrend(_ l: Language) -> String {
        switch l {
        case .en: "Traffic over time"
        case .fa: "روند ترافیک"
        case .tr: "Zaman içinde trafik"
        case .ar: "الزيارات عبر الزمن"
        }
    }

    static func analyticsTopChannels(_ l: Language) -> String {
        switch l {
        case .en: "Top channels"
        case .fa: "کانال‌های برتر"
        case .tr: "En iyi kanallar"
        case .ar: "أهم القنوات"
        }
    }

    static func analyticsTopPages(_ l: Language) -> String {
        switch l {
        case .en: "Top pages"
        case .fa: "صفحات برتر"
        case .tr: "En iyi sayfalar"
        case .ar: "أهم الصفحات"
        }
    }

    static func analyticsVisitsUnit(_ l: Language) -> String {
        switch l {
        case .en: "visits"
        case .fa: "بازدید"
        case .tr: "ziyaret"
        case .ar: "زيارة"
        }
    }

    static func analyticsViewsUnit(_ l: Language) -> String {
        switch l {
        case .en: "views"
        case .fa: "بازدید"
        case .tr: "görüntüleme"
        case .ar: "مشاهدة"
        }
    }

    static func analyticsChannel(_ l: Language) -> String {
        switch l {
        case .en: "Channel"
        case .fa: "کانال"
        case .tr: "Kanal"
        case .ar: "القناة"
        }
    }

    static func analyticsSource(_ l: Language) -> String {
        switch l {
        case .en: "Source"
        case .fa: "منبع"
        case .tr: "Kaynak"
        case .ar: "المصدر"
        }
    }

    static func analyticsCampaign(_ l: Language) -> String {
        switch l {
        case .en: "Campaign"
        case .fa: "کمپین"
        case .tr: "Kampanya"
        case .ar: "الحملة"
        }
    }

    static func analyticsCountry(_ l: Language) -> String {
        switch l {
        case .en: "Country"
        case .fa: "کشور"
        case .tr: "Ülke"
        case .ar: "الدولة"
        }
    }

    static func analyticsCity(_ l: Language) -> String {
        switch l {
        case .en: "City"
        case .fa: "شهر"
        case .tr: "Şehir"
        case .ar: "المدينة"
        }
    }

    static func analyticsLanguage(_ l: Language) -> String {
        switch l {
        case .en: "Language"
        case .fa: "زبان"
        case .tr: "Dil"
        case .ar: "اللغة"
        }
    }

    static func analyticsPagesTop(_ l: Language) -> String {
        switch l {
        case .en: "Most viewed"
        case .fa: "پربازدیدترین"
        case .tr: "En çok görüntülenen"
        case .ar: "الأكثر مشاهدة"
        }
    }

    static func analyticsPagesEntry(_ l: Language) -> String {
        switch l {
        case .en: "Entry"
        case .fa: "ورود"
        case .tr: "Giriş"
        case .ar: "الدخول"
        }
    }

    static func analyticsPagesExit(_ l: Language) -> String {
        switch l {
        case .en: "Exit"
        case .fa: "خروج"
        case .tr: "Çıkış"
        case .ar: "الخروج"
        }
    }

    static func analyticsDevice(_ l: Language) -> String {
        switch l {
        case .en: "Device"
        case .fa: "دستگاه"
        case .tr: "Cihaz"
        case .ar: "الجهاز"
        }
    }

    static func analyticsOS(_ l: Language) -> String {
        switch l {
        case .en: "Operating system"
        case .fa: "سیستم‌عامل"
        case .tr: "İşletim sistemi"
        case .ar: "نظام التشغيل"
        }
    }

    static func analyticsBrowser(_ l: Language) -> String {
        switch l {
        case .en: "Browser"
        case .fa: "مرورگر"
        case .tr: "Tarayıcı"
        case .ar: "المتصفح"
        }
    }

    static func analyticsEventCount(_ l: Language) -> String {
        switch l {
        case .en: "Times"
        case .fa: "تعداد"
        case .tr: "Adet"
        case .ar: "العدد"
        }
    }

    static func analyticsEventVisits(_ l: Language) -> String {
        switch l {
        case .en: "Visits"
        case .fa: "بازدید"
        case .tr: "Ziyaret"
        case .ar: "الزيارات"
        }
    }

    static func analyticsConversion(_ l: Language) -> String {
        switch l {
        case .en: "Conversion"
        case .fa: "نرخ تبدیل"
        case .tr: "Dönüşüm"
        case .ar: "التحويل"
        }
    }

    static func analyticsNoData(_ l: Language) -> String {
        switch l {
        case .en: "No visits in this range yet"
        case .fa: "در این بازه هنوز بازدیدی نیست"
        case .tr: "Bu aralıkta henüz ziyaret yok"
        case .ar: "لا توجد زيارات في هذه الفترة بعد"
        }
    }

    static func analyticsNoDataHint(_ l: Language) -> String {
        switch l {
        case .en: "The chat widget's snippet records every page view on your site; they show up here."
        case .fa: "اسکریپت ویجت گفت‌وگو هر بازدید صفحه در سایت شما را ثبت می‌کند و اینجا نمایش داده می‌شود."
        case .tr: "Sohbet widget'ının kodu sitenizdeki her sayfa görüntülemeyi kaydeder; burada görünür."
        case .ar: "تسجّل شيفرة أداة الدردشة كل مشاهدة صفحة على موقعك، وتظهر هنا."
        }
    }

    static func analyticsNoEvents(_ l: Language) -> String {
        switch l {
        case .en: "No custom events yet"
        case .fa: "هنوز رویداد سفارشی‌ای نیست"
        case .tr: "Henüz özel olay yok"
        case .ar: "لا توجد أحداث مخصصة بعد"
        }
    }

    static func analyticsNoEventsHint(_ l: Language) -> String {
        switch l {
        case .en: "Send them from your site with window.gsAnalytics.track('name')."
        case .fa: "از سایت خود با window.gsAnalytics.track('name') رویداد بفرستید."
        case .tr: "Sitenizden window.gsAnalytics.track('ad') ile gönderin."
        case .ar: "أرسلها من موقعك باستخدام window.gsAnalytics.track('name')."
        }
    }

    static func analyticsLocked(_ l: Language) -> String {
        switch l {
        case .en: "Website analytics is not in your plan"
        case .fa: "تحلیل وب‌سایت در پلن شما نیست"
        case .tr: "Web sitesi analitiği planınızda yok"
        case .ar: "تحليلات الموقع غير مشمولة في باقتك"
        }
    }

    static func analyticsLockedHint(_ l: Language) -> String {
        switch l {
        case .en: "Ask the workspace owner about access to website analytics."
        case .fa: "برای دسترسی به تحلیل وب‌سایت با مالک فضای کاری هماهنگ کنید."
        case .tr: "Web sitesi analitiğine erişim için çalışma alanı sahibine danışın."
        case .ar: "اسأل مالك مساحة العمل عن الوصول إلى تحليلات الموقع."
        }
    }

    static func analyticsLoadFailed(_ l: Language) -> String {
        switch l {
        case .en: "This report could not be loaded."
        case .fa: "این گزارش بارگذاری نشد."
        case .tr: "Bu rapor yüklenemedi."
        case .ar: "تعذّر تحميل هذا التقرير."
        }
    }

    static func analyticsTruncated(_ l: Language) -> String {
        switch l {
        case .en: "This range is very busy, so these numbers are from a sample of it."
        case .fa: "این بازه خیلی پرترافیک است؛ اعداد از نمونه‌ای از آن محاسبه شده‌اند."
        case .tr: "Bu aralık çok yoğun; rakamlar bir örneklemden hesaplandı."
        case .ar: "هذه الفترة مزدحمة جدًا، لذا هذه الأرقام مأخوذة من عيّنة منها."
        }
    }

    static func analyticsUnknown(_ l: Language) -> String {
        switch l {
        case .en: "Unknown"
        case .fa: "نامشخص"
        case .tr: "Bilinmiyor"
        case .ar: "غير معروف"
        }
    }

    static func analyticsTotal(_ l: Language) -> String {
        switch l {
        case .en: "Total"
        case .fa: "مجموع"
        case .tr: "Toplam"
        case .ar: "الإجمالي"
        }
    }

    static func analyticsLeader(_ l: Language) -> String {
        switch l {
        case .en: "Top"
        case .fa: "در صدر"
        case .tr: "Zirvede"
        case .ar: "في الصدارة"
        }
    }

    static func analyticsDistinct(_ l: Language) -> String {
        switch l {
        case .en: "Different items"
        case .fa: "تعداد موارد"
        case .tr: "Farklı öğe"
        case .ar: "عدد العناصر"
        }
    }

    /// After a number of minutes in a duration: 2m 14s.
    static func analyticsMinutesShort(_ l: Language) -> String {
        switch l {
        case .en: "m"
        case .fa: "دقیقه"
        case .tr: "dk"
        case .ar: "د"
        }
    }

    /// After a number of seconds in a duration: 2m 14s.
    static func analyticsSecondsShort(_ l: Language) -> String {
        switch l {
        case .en: "s"
        case .fa: "ثانیه"
        case .tr: "sn"
        case .ar: "ث"
        }
    }

    static func analyticsChannelDirect(_ l: Language) -> String {
        switch l {
        case .en: "Direct"
        case .fa: "مستقیم"
        case .tr: "Doğrudan"
        case .ar: "مباشر"
        }
    }

    static func analyticsChannelOrganicSearch(_ l: Language) -> String {
        switch l {
        case .en: "Organic search"
        case .fa: "جست‌وجوی ارگانیک"
        case .tr: "Organik arama"
        case .ar: "بحث طبيعي"
        }
    }

    static func analyticsChannelOrganicSocial(_ l: Language) -> String {
        switch l {
        case .en: "Organic social"
        case .fa: "شبکه‌های اجتماعی"
        case .tr: "Organik sosyal"
        case .ar: "تواصل اجتماعي طبيعي"
        }
    }

    static func analyticsChannelReferral(_ l: Language) -> String {
        switch l {
        case .en: "Referral"
        case .fa: "ارجاع از سایت‌ها"
        case .tr: "Yönlendirme"
        case .ar: "إحالة"
        }
    }

    static func analyticsChannelPaidSearch(_ l: Language) -> String {
        switch l {
        case .en: "Paid search"
        case .fa: "جست‌وجوی پولی"
        case .tr: "Ücretli arama"
        case .ar: "بحث مدفوع"
        }
    }

    static func analyticsChannelPaidSocial(_ l: Language) -> String {
        switch l {
        case .en: "Paid social"
        case .fa: "تبلیغات شبکه‌های اجتماعی"
        case .tr: "Ücretli sosyal"
        case .ar: "تواصل اجتماعي مدفوع"
        }
    }

    static func analyticsChannelEmail(_ l: Language) -> String {
        switch l {
        case .en: "Email"
        case .fa: "ایمیل"
        case .tr: "E-posta"
        case .ar: "البريد الإلكتروني"
        }
    }

    static func analyticsChannelOther(_ l: Language) -> String {
        switch l {
        case .en: "Other"
        case .fa: "سایر"
        case .tr: "Diğer"
        case .ar: "أخرى"
        }
    }

    static func analyticsDeviceMobile(_ l: Language) -> String {
        switch l {
        case .en: "Mobile"
        case .fa: "موبایل"
        case .tr: "Mobil"
        case .ar: "جوال"
        }
    }

    static func analyticsDeviceDesktop(_ l: Language) -> String {
        switch l {
        case .en: "Desktop"
        case .fa: "دسکتاپ"
        case .tr: "Masaüstü"
        case .ar: "حاسوب"
        }
    }

    static func analyticsDeviceTablet(_ l: Language) -> String {
        switch l {
        case .en, .tr: "Tablet"
        case .ar: "جهاز لوحي"
        case .fa: "تبلت"
        }
    }
}
