import Foundation

/// The mailbox's words — its folders, its composer, its trail. The same
/// words as the Android app's `StrEmail`; a file of their own because none
/// of them is used anywhere else.
enum EmailStr {
    static func folderInbox(_ l: Language) -> String {
        switch l {
        case .en: "Inbox"
        case .fa: "صندوق"
        case .tr: "Gelen kutusu"
        case .ar: "صندوق الوارد"
        }
    }

    static func folderUnread(_ l: Language) -> String {
        switch l {
        case .en: "Unread"
        case .fa: "خوانده‌نشده"
        case .tr: "Okunmamış"
        case .ar: "غير المقروءة"
        }
    }

    static func folderStarred(_ l: Language) -> String {
        switch l {
        case .en: "Starred"
        case .fa: "ستاره‌دار"
        case .tr: "Yıldızlı"
        case .ar: "المميّزة بنجمة"
        }
    }

    static func filterAll(_ l: Language) -> String {
        switch l {
        case .en: "All"
        case .fa: "همه"
        case .tr: "Tümü"
        case .ar: "الكل"
        }
    }

    static func folders(_ l: Language) -> String {
        switch l {
        case .en: "Folders"
        case .fa: "پوشه‌ها"
        case .tr: "Klasörler"
        case .ar: "المجلدات"
        }
    }

    static func labels(_ l: Language) -> String {
        switch l {
        case .en: "Labels"
        case .fa: "برچسب‌ها"
        case .tr: "Etiketler"
        case .ar: "التصنيفات"
        }
    }

    static func mailboxes(_ l: Language) -> String {
        switch l {
        case .en: "Mailboxes"
        case .fa: "صندوق‌های ایمیل"
        case .tr: "Posta kutuları"
        case .ar: "صناديق البريد"
        }
    }

    static func folderEmpty(_ l: Language) -> String {
        switch l {
        case .en: "Nothing in this folder"
        case .fa: "این پوشه خالی است"
        case .tr: "Bu klasör boş"
        case .ar: "لا يوجد شيء في هذا المجلد"
        }
    }

    static func loadingMail(_ l: Language) -> String {
        switch l {
        case .en: "Loading mail…"
        case .fa: "در حال دریافت ایمیل‌ها…"
        case .tr: "E-postalar yükleniyor…"
        case .ar: "جارٍ تحميل البريد…"
        }
    }

    static func openingMail(_ l: Language) -> String {
        switch l {
        case .en: "Opening the email…"
        case .fa: "در حال باز کردن ایمیل…"
        case .tr: "E-posta açılıyor…"
        case .ar: "جارٍ فتح الرسالة…"
        }
    }

    static func downloadingFile(_ l: Language) -> String {
        switch l {
        case .en: "Downloading the file…"
        case .fa: "در حال دریافت فایل…"
        case .tr: "Dosya indiriliyor…"
        case .ar: "جارٍ تنزيل الملف…"
        }
    }

    static func draft(_ l: Language) -> String {
        switch l {
        case .en: "Draft"
        case .fa: "پیش‌نویس"
        case .tr: "Taslak"
        case .ar: "مسودة"
        }
    }

    static func compose(_ l: Language) -> String {
        switch l {
        case .en: "Compose"
        case .fa: "نوشتن"
        case .tr: "Yeni e-posta"
        case .ar: "كتابة"
        }
    }

    static func newMessage(_ l: Language) -> String {
        switch l {
        case .en: "New message"
        case .fa: "ایمیل جدید"
        case .tr: "Yeni ileti"
        case .ar: "رسالة جديدة"
        }
    }

    static func markRead(_ l: Language) -> String {
        switch l {
        case .en: "Mark as read"
        case .fa: "علامت خوانده‌شده"
        case .tr: "Okundu olarak işaretle"
        case .ar: "تعليم كمقروءة"
        }
    }

    static func markUnread(_ l: Language) -> String {
        switch l {
        case .en: "Mark as unread"
        case .fa: "علامت خوانده‌نشده"
        case .tr: "Okunmadı olarak işaretle"
        case .ar: "تعليم كغير مقروءة"
        }
    }

    static func star(_ l: Language) -> String {
        switch l {
        case .en: "Star"
        case .fa: "ستاره زدن"
        case .tr: "Yıldızla"
        case .ar: "تمييز بنجمة"
        }
    }

    static func unstar(_ l: Language) -> String {
        switch l {
        case .en: "Remove star"
        case .fa: "برداشتن ستاره"
        case .tr: "Yıldızı kaldır"
        case .ar: "إزالة النجمة"
        }
    }

    static func reply(_ l: Language) -> String {
        switch l {
        case .en: "Reply"
        case .fa: "پاسخ"
        case .tr: "Yanıtla"
        case .ar: "رد"
        }
    }

    static func replyAll(_ l: Language) -> String {
        switch l {
        case .en: "Reply all"
        case .fa: "پاسخ به همه"
        case .tr: "Tümünü yanıtla"
        case .ar: "رد على الكل"
        }
    }

    static func forward(_ l: Language) -> String {
        switch l {
        case .en: "Forward"
        case .fa: "ارسال به دیگری"
        case .tr: "İlet"
        case .ar: "إعادة توجيه"
        }
    }

    static func to(_ l: Language) -> String {
        switch l {
        case .en: "To"
        case .fa: "به"
        case .tr: "Kime"
        case .ar: "إلى"
        }
    }

    static func ccBcc(_ l: Language) -> String {
        switch l {
        case .en: "Cc / Bcc"
        case .fa: "رونوشت (Cc / Bcc)"
        case .tr: "Bilgi (Cc / Bcc)"
        case .ar: "نسخة / نسخة مخفية"
        }
    }

    static func subject(_ l: Language) -> String {
        switch l {
        case .en: "Subject"
        case .fa: "موضوع"
        case .tr: "Konu"
        case .ar: "الموضوع"
        }
    }

    static func body(_ l: Language) -> String {
        switch l {
        case .en: "Write your message"
        case .fa: "متن ایمیل را بنویسید"
        case .tr: "İletinizi yazın"
        case .ar: "اكتب رسالتك"
        }
    }

    static func addressesHint(_ l: Language) -> String {
        switch l {
        case .en: "Separate addresses with a comma"
        case .fa: "نشانی‌ها را با ویرگول جدا کنید"
        case .tr: "Adresleri virgülle ayırın"
        case .ar: "افصل بين العناوين بفاصلة"
        }
    }

    static func needsRecipient(_ l: Language) -> String {
        switch l {
        case .en: "Add at least one recipient"
        case .fa: "دست‌کم یک گیرنده وارد کنید"
        case .tr: "En az bir alıcı ekleyin"
        case .ar: "أضف مستلمًا واحدًا على الأقل"
        }
    }

    static func needsSubject(_ l: Language) -> String {
        switch l {
        case .en: "Add a subject"
        case .fa: "موضوع را وارد کنید"
        case .tr: "Bir konu ekleyin"
        case .ar: "أضف موضوعًا"
        }
    }

    static func addAttachment(_ l: Language) -> String {
        switch l {
        case .en: "Attach a file"
        case .fa: "افزودن پیوست"
        case .tr: "Dosya ekle"
        case .ar: "إرفاق ملف"
        }
    }

    static func removeAttachment(_ l: Language) -> String {
        switch l {
        case .en: "Remove attachment"
        case .fa: "حذف پیوست"
        case .tr: "Eki kaldır"
        case .ar: "إزالة المرفق"
        }
    }

    static func uploading(_ l: Language) -> String {
        switch l {
        case .en: "Uploading…"
        case .fa: "در حال بارگذاری…"
        case .tr: "Yükleniyor…"
        case .ar: "جارٍ الرفع…"
        }
    }

    static func uploadFailed(_ l: Language) -> String {
        switch l {
        case .en: "The file could not be attached"
        case .fa: "پیوست بارگذاری نشد"
        case .tr: "Dosya eklenemedi"
        case .ar: "تعذّر إرفاق الملف"
        }
    }

    static func openFailed(_ l: Language) -> String {
        switch l {
        case .en: "No app on this phone can open this file"
        case .fa: "برنامه‌ای برای باز کردن این فایل روی گوشی نیست"
        case .tr: "Bu telefonda dosyayı açabilecek bir uygulama yok"
        case .ar: "لا يوجد تطبيق على هذا الهاتف يمكنه فتح هذا الملف"
        }
    }

    static func downloadFailed(_ l: Language) -> String {
        switch l {
        case .en: "The attachment could not be downloaded"
        case .fa: "پیوست دریافت نشد"
        case .tr: "Ek indirilemedi"
        case .ar: "تعذّر تنزيل المرفق"
        }
    }

    static func sent(_ l: Language) -> String {
        switch l {
        case .en: "Sent"
        case .fa: "ارسال شد"
        case .tr: "Gönderildi"
        case .ar: "تم الإرسال"
        }
    }

    static func showQuoted(_ l: Language) -> String {
        switch l {
        case .en: "Show quoted text"
        case .fa: "نمایش متن نقل‌قول"
        case .tr: "Alıntıyı göster"
        case .ar: "إظهار النص المقتبس"
        }
    }

    static func hideQuoted(_ l: Language) -> String {
        switch l {
        case .en: "Hide quoted text"
        case .fa: "پنهان کردن متن نقل‌قول"
        case .tr: "Alıntıyı gizle"
        case .ar: "إخفاء النص المقتبس"
        }
    }

    static func me(_ l: Language) -> String {
        switch l {
        case .en: "me"
        case .fa: "من"
        case .tr: "ben"
        case .ar: "أنا"
        }
    }

    static func notDelivered(_ l: Language) -> String {
        switch l {
        case .en: "Not delivered"
        case .fa: "تحویل نشد"
        case .tr: "Teslim edilmedi"
        case .ar: "لم يتم التسليم"
        }
    }

    static func forwardedHeader(_ l: Language) -> String {
        switch l {
        case .en: "---------- Forwarded message ----------"
        case .fa: "---------- پیام ارسال‌شده ----------"
        case .tr: "---------- İletilen ileti ----------"
        case .ar: "---------- رسالة مُعاد توجيهها ----------"
        }
    }

    static func from(_ l: Language) -> String {
        switch l {
        case .en: "From"
        case .fa: "از"
        case .tr: "Kimden"
        case .ar: "من"
        }
    }

    static func date(_ l: Language) -> String {
        switch l {
        case .en: "Date"
        case .fa: "تاریخ"
        case .tr: "Tarih"
        case .ar: "التاريخ"
        }
    }

    static func discardDraft(_ l: Language) -> String {
        switch l {
        case .en: "Discard this draft?"
        case .fa: "این پیش‌نویس دور ریخته شود؟"
        case .tr: "Bu taslak silinsin mi?"
        case .ar: "هل تريد تجاهل هذه المسودة؟"
        }
    }

    static func discard(_ l: Language) -> String {
        switch l {
        case .en: "Discard"
        case .fa: "دور ریختن"
        case .tr: "Sil"
        case .ar: "تجاهل"
        }
    }

    static func keepEditing(_ l: Language) -> String {
        switch l {
        case .en: "Keep editing"
        case .fa: "ادامهٔ نوشتن"
        case .tr: "Düzenlemeye devam et"
        case .ar: "متابعة التحرير"
        }
    }

    static func endOfList(_ l: Language) -> String {
        switch l {
        case .en: "That's everything"
        case .fa: "همه همین بود"
        case .tr: "Hepsi bu kadar"
        case .ar: "هذا كل شيء"
        }
    }

    static func cc(_ l: Language) -> String { "Cc" }

    static func bcc(_ l: Language) -> String { "Bcc" }

    /// A mailbox folder by its id (`inbox`, `sent`, …), for the menu and the
    /// title. Nil for a label, which the mailbox names itself.
    static func folderName(_ l: Language, _ id: String) -> String? {
        switch id {
        case "inbox":
            switch l {
            case .en: "Inbox"
            case .fa: "صندوق ورودی"
            case .tr: "Gelen kutusu"
            case .ar: "الوارد"
            }
        case "starred": folderStarred(l)
        case "important":
            switch l {
            case .en: "Important"
            case .fa: "مهم"
            case .tr: "Önemli"
            case .ar: "مهم"
            }
        case "sent":
            switch l {
            case .en: "Sent"
            case .fa: "ارسال‌شده"
            case .tr: "Gönderilmiş"
            case .ar: "المُرسَلة"
            }
        case "drafts":
            switch l {
            case .en: "Drafts"
            case .fa: "پیش‌نویس‌ها"
            case .tr: "Taslaklar"
            case .ar: "المسودات"
            }
        case "all":
            switch l {
            case .en: "All mail"
            case .fa: "همهٔ نامه‌ها"
            case .tr: "Tüm postalar"
            case .ar: "كل البريد"
            }
        case "spam":
            switch l {
            case .en, .tr: "Spam"
            case .ar: "البريد العشوائي"
            case .fa: "هرزنامه"
            }
        case "trash":
            switch l {
            case .en: "Trash"
            case .fa: "سطل زباله"
            case .tr: "Çöp kutusu"
            case .ar: "سلة المهملات"
            }
        default: nil
        }
    }

    /// `bad` is what the operator typed, isolated: at the end of a Persian
    /// line a trailing `.` or `@` — the very typo being reported — would be
    /// laid out on the far side of the address. Inside an isolate it keeps
    /// its place.
    static func invalidAddresses(_ l: Language, _ bad: String) -> String {
        let isolated = "\u{2068}\(bad)\u{2069}"
        switch l {
        case .en: return "Not an email address: \(isolated)"
        case .fa: return "نشانی ایمیل معتبر نیست: \(isolated)"
        case .tr: return "Geçerli bir e-posta adresi değil: \(isolated)"
        case .ar: return "ليس عنوان بريد إلكتروني صالحًا: \(isolated)"
        }
    }

    static func toLine(_ l: Language, _ who: String) -> String {
        switch l {
        case .en: "to \(who)"
        case .fa: "به \(who)"
        case .tr: "kime: \(who)"
        case .ar: "إلى \(who)"
        }
    }

    static func messagesCount(_ l: Language, _ count: Int) -> String {
        switch l {
        case .en: count == 1 ? "1 message" : "\(count) messages"
        case .fa: "\(Format.number(count, language: l)) پیام"
        case .tr: "\(count) ileti"
        case .ar: Format.arabicCount(count, one: "رسالة واحدة", two: "رسالتان", few: "رسائل", many: "رسالة")
        }
    }

    /// The heading over the folded trail: "Earlier messages (3)".
    static func earlierMessages(_ l: Language, _ count: Int) -> String {
        switch l {
        case .en: "Earlier messages (\(count))"
        case .fa: "پیام‌های قبلی (\(Format.number(count, language: l)))"
        case .tr: "Önceki iletiler (\(count))"
        case .ar: "الرسائل السابقة (\(Format.number(count, language: l)))"
        }
    }

    /// The menu of every inbox behind the strip's three lines, and its button.
    static func everyInbox(_ l: Language) -> String {
        switch l {
        case .en: "All inboxes"
        case .fa: "همهٔ صندوق‌ها"
        case .tr: "Tüm gelen kutuları"
        case .ar: "كل صناديق الوارد"
        }
    }

    /// The sheet's section for the colleagues' chat and the mailbox.
    static func teamAndMail(_ l: Language) -> String {
        switch l {
        case .en: "Team and email"
        case .fa: "همکاران و ایمیل"
        case .tr: "Ekip ve e-posta"
        case .ar: "الفريق والبريد"
        }
    }

    static func moreOptions(_ l: Language) -> String {
        switch l {
        case .en: "More options"
        case .fa: "گزینه‌های بیشتر"
        case .tr: "Diğer seçenekler"
        case .ar: "خيارات أخرى"
        }
    }

    /// A file over what the mailbox takes in one mail.
    static func fileTooLarge(_ l: Language) -> String {
        switch l {
        case .en: "That file is over 20 MB."
        case .fa: "این فایل از ۲۰ مگابایت بزرگ‌تر است."
        case .tr: "Bu dosya 20 MB'tan büyük."
        case .ar: "حجم هذا الملف أكبر من ٢٠ ميغابايت."
        }
    }

    static func photo(_ l: Language) -> String {
        switch l {
        case .en: "Photo or video"
        case .fa: "عکس یا ویدیو"
        case .tr: "Fotoğraf veya video"
        case .ar: "صورة أو فيديو"
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
}
