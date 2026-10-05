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
        }
    }

    static func folderUnread(_ l: Language) -> String {
        switch l {
        case .en: "Unread"
        case .fa: "خوانده‌نشده"
        case .tr: "Okunmamış"
        }
    }

    static func folderStarred(_ l: Language) -> String {
        switch l {
        case .en: "Starred"
        case .fa: "ستاره‌دار"
        case .tr: "Yıldızlı"
        }
    }

    static func filterAll(_ l: Language) -> String {
        switch l {
        case .en: "All"
        case .fa: "همه"
        case .tr: "Tümü"
        }
    }

    static func folders(_ l: Language) -> String {
        switch l {
        case .en: "Folders"
        case .fa: "پوشه‌ها"
        case .tr: "Klasörler"
        }
    }

    static func labels(_ l: Language) -> String {
        switch l {
        case .en: "Labels"
        case .fa: "برچسب‌ها"
        case .tr: "Etiketler"
        }
    }

    static func mailboxes(_ l: Language) -> String {
        switch l {
        case .en: "Mailboxes"
        case .fa: "صندوق‌های ایمیل"
        case .tr: "Posta kutuları"
        }
    }

    static func folderEmpty(_ l: Language) -> String {
        switch l {
        case .en: "Nothing in this folder"
        case .fa: "این پوشه خالی است"
        case .tr: "Bu klasör boş"
        }
    }

    static func loadingMail(_ l: Language) -> String {
        switch l {
        case .en: "Loading mail…"
        case .fa: "در حال دریافت ایمیل‌ها…"
        case .tr: "E-postalar yükleniyor…"
        }
    }

    static func openingMail(_ l: Language) -> String {
        switch l {
        case .en: "Opening the email…"
        case .fa: "در حال باز کردن ایمیل…"
        case .tr: "E-posta açılıyor…"
        }
    }

    static func downloadingFile(_ l: Language) -> String {
        switch l {
        case .en: "Downloading the file…"
        case .fa: "در حال دریافت فایل…"
        case .tr: "Dosya indiriliyor…"
        }
    }

    static func draft(_ l: Language) -> String {
        switch l {
        case .en: "Draft"
        case .fa: "پیش‌نویس"
        case .tr: "Taslak"
        }
    }

    static func compose(_ l: Language) -> String {
        switch l {
        case .en: "Compose"
        case .fa: "نوشتن"
        case .tr: "Yeni e-posta"
        }
    }

    static func newMessage(_ l: Language) -> String {
        switch l {
        case .en: "New message"
        case .fa: "ایمیل جدید"
        case .tr: "Yeni ileti"
        }
    }

    static func markRead(_ l: Language) -> String {
        switch l {
        case .en: "Mark as read"
        case .fa: "علامت خوانده‌شده"
        case .tr: "Okundu olarak işaretle"
        }
    }

    static func markUnread(_ l: Language) -> String {
        switch l {
        case .en: "Mark as unread"
        case .fa: "علامت خوانده‌نشده"
        case .tr: "Okunmadı olarak işaretle"
        }
    }

    static func star(_ l: Language) -> String {
        switch l {
        case .en: "Star"
        case .fa: "ستاره زدن"
        case .tr: "Yıldızla"
        }
    }

    static func unstar(_ l: Language) -> String {
        switch l {
        case .en: "Remove star"
        case .fa: "برداشتن ستاره"
        case .tr: "Yıldızı kaldır"
        }
    }

    static func reply(_ l: Language) -> String {
        switch l {
        case .en: "Reply"
        case .fa: "پاسخ"
        case .tr: "Yanıtla"
        }
    }

    static func replyAll(_ l: Language) -> String {
        switch l {
        case .en: "Reply all"
        case .fa: "پاسخ به همه"
        case .tr: "Tümünü yanıtla"
        }
    }

    static func forward(_ l: Language) -> String {
        switch l {
        case .en: "Forward"
        case .fa: "ارسال به دیگری"
        case .tr: "İlet"
        }
    }

    static func to(_ l: Language) -> String {
        switch l {
        case .en: "To"
        case .fa: "به"
        case .tr: "Kime"
        }
    }

    static func ccBcc(_ l: Language) -> String {
        switch l {
        case .en: "Cc / Bcc"
        case .fa: "رونوشت (Cc / Bcc)"
        case .tr: "Bilgi (Cc / Bcc)"
        }
    }

    static func subject(_ l: Language) -> String {
        switch l {
        case .en: "Subject"
        case .fa: "موضوع"
        case .tr: "Konu"
        }
    }

    static func body(_ l: Language) -> String {
        switch l {
        case .en: "Write your message"
        case .fa: "متن ایمیل را بنویسید"
        case .tr: "İletinizi yazın"
        }
    }

    static func addressesHint(_ l: Language) -> String {
        switch l {
        case .en: "Separate addresses with a comma"
        case .fa: "نشانی‌ها را با ویرگول جدا کنید"
        case .tr: "Adresleri virgülle ayırın"
        }
    }

    static func needsRecipient(_ l: Language) -> String {
        switch l {
        case .en: "Add at least one recipient"
        case .fa: "دست‌کم یک گیرنده وارد کنید"
        case .tr: "En az bir alıcı ekleyin"
        }
    }

    static func needsSubject(_ l: Language) -> String {
        switch l {
        case .en: "Add a subject"
        case .fa: "موضوع را وارد کنید"
        case .tr: "Bir konu ekleyin"
        }
    }

    static func addAttachment(_ l: Language) -> String {
        switch l {
        case .en: "Attach a file"
        case .fa: "افزودن پیوست"
        case .tr: "Dosya ekle"
        }
    }

    static func removeAttachment(_ l: Language) -> String {
        switch l {
        case .en: "Remove attachment"
        case .fa: "حذف پیوست"
        case .tr: "Eki kaldır"
        }
    }

    static func uploading(_ l: Language) -> String {
        switch l {
        case .en: "Uploading…"
        case .fa: "در حال بارگذاری…"
        case .tr: "Yükleniyor…"
        }
    }

    static func uploadFailed(_ l: Language) -> String {
        switch l {
        case .en: "The file could not be attached"
        case .fa: "پیوست بارگذاری نشد"
        case .tr: "Dosya eklenemedi"
        }
    }

    static func openFailed(_ l: Language) -> String {
        switch l {
        case .en: "No app on this phone can open this file"
        case .fa: "برنامه‌ای برای باز کردن این فایل روی گوشی نیست"
        case .tr: "Bu telefonda dosyayı açabilecek bir uygulama yok"
        }
    }

    static func downloadFailed(_ l: Language) -> String {
        switch l {
        case .en: "The attachment could not be downloaded"
        case .fa: "پیوست دریافت نشد"
        case .tr: "Ek indirilemedi"
        }
    }

    static func sent(_ l: Language) -> String {
        switch l {
        case .en: "Sent"
        case .fa: "ارسال شد"
        case .tr: "Gönderildi"
        }
    }

    static func showQuoted(_ l: Language) -> String {
        switch l {
        case .en: "Show quoted text"
        case .fa: "نمایش متن نقل‌قول"
        case .tr: "Alıntıyı göster"
        }
    }

    static func hideQuoted(_ l: Language) -> String {
        switch l {
        case .en: "Hide quoted text"
        case .fa: "پنهان کردن متن نقل‌قول"
        case .tr: "Alıntıyı gizle"
        }
    }

    static func me(_ l: Language) -> String {
        switch l {
        case .en: "me"
        case .fa: "من"
        case .tr: "ben"
        }
    }

    static func notDelivered(_ l: Language) -> String {
        switch l {
        case .en: "Not delivered"
        case .fa: "تحویل نشد"
        case .tr: "Teslim edilmedi"
        }
    }

    static func forwardedHeader(_ l: Language) -> String {
        switch l {
        case .en: "---------- Forwarded message ----------"
        case .fa: "---------- پیام ارسال‌شده ----------"
        case .tr: "---------- İletilen ileti ----------"
        }
    }

    static func from(_ l: Language) -> String {
        switch l {
        case .en: "From"
        case .fa: "از"
        case .tr: "Kimden"
        }
    }

    static func date(_ l: Language) -> String {
        switch l {
        case .en: "Date"
        case .fa: "تاریخ"
        case .tr: "Tarih"
        }
    }

    static func discardDraft(_ l: Language) -> String {
        switch l {
        case .en: "Discard this draft?"
        case .fa: "این پیش‌نویس دور ریخته شود؟"
        case .tr: "Bu taslak silinsin mi?"
        }
    }

    static func discard(_ l: Language) -> String {
        switch l {
        case .en: "Discard"
        case .fa: "دور ریختن"
        case .tr: "Sil"
        }
    }

    static func keepEditing(_ l: Language) -> String {
        switch l {
        case .en: "Keep editing"
        case .fa: "ادامهٔ نوشتن"
        case .tr: "Düzenlemeye devam et"
        }
    }

    static func endOfList(_ l: Language) -> String {
        switch l {
        case .en: "That's everything"
        case .fa: "همه همین بود"
        case .tr: "Hepsi bu kadar"
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
            }
        case "starred": folderStarred(l)
        case "important":
            switch l {
            case .en: "Important"
            case .fa: "مهم"
            case .tr: "Önemli"
            }
        case "sent":
            switch l {
            case .en: "Sent"
            case .fa: "ارسال‌شده"
            case .tr: "Gönderilmiş"
            }
        case "drafts":
            switch l {
            case .en: "Drafts"
            case .fa: "پیش‌نویس‌ها"
            case .tr: "Taslaklar"
            }
        case "all":
            switch l {
            case .en: "All mail"
            case .fa: "همهٔ نامه‌ها"
            case .tr: "Tüm postalar"
            }
        case "spam":
            switch l {
            case .en, .tr: "Spam"
            case .fa: "هرزنامه"
            }
        case "trash":
            switch l {
            case .en: "Trash"
            case .fa: "سطل زباله"
            case .tr: "Çöp kutusu"
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
        }
    }

    static func toLine(_ l: Language, _ who: String) -> String {
        switch l {
        case .en: "to \(who)"
        case .fa: "به \(who)"
        case .tr: "kime: \(who)"
        }
    }

    static func messagesCount(_ l: Language, _ count: Int) -> String {
        switch l {
        case .en: count == 1 ? "1 message" : "\(count) messages"
        case .fa: "\(Format.number(count, language: l)) پیام"
        case .tr: "\(count) ileti"
        }
    }

    /// The heading over the folded trail: "Earlier messages (3)".
    static func earlierMessages(_ l: Language, _ count: Int) -> String {
        switch l {
        case .en: "Earlier messages (\(count))"
        case .fa: "پیام‌های قبلی (\(Format.number(count, language: l)))"
        case .tr: "Önceki iletiler (\(count))"
        }
    }

    /// The menu of every inbox behind the strip's three lines, and its button.
    static func everyInbox(_ l: Language) -> String {
        switch l {
        case .en: "All inboxes"
        case .fa: "همهٔ صندوق‌ها"
        case .tr: "Tüm gelen kutuları"
        }
    }

    /// The sheet's section for the colleagues' chat and the mailbox.
    static func teamAndMail(_ l: Language) -> String {
        switch l {
        case .en: "Team and email"
        case .fa: "همکاران و ایمیل"
        case .tr: "Ekip ve e-posta"
        }
    }

    static func moreOptions(_ l: Language) -> String {
        switch l {
        case .en: "More options"
        case .fa: "گزینه‌های بیشتر"
        case .tr: "Diğer seçenekler"
        }
    }

    /// A file over what the mailbox takes in one mail.
    static func fileTooLarge(_ l: Language) -> String {
        switch l {
        case .en: "That file is over 20 MB."
        case .fa: "این فایل از ۲۰ مگابایت بزرگ‌تر است."
        case .tr: "Bu dosya 20 MB'tan büyük."
        }
    }

    static func photo(_ l: Language) -> String {
        switch l {
        case .en: "Photo or video"
        case .fa: "عکس یا ویدیو"
        case .tr: "Fotoğraf veya video"
        }
    }

    static func file(_ l: Language) -> String {
        switch l {
        case .en: "File"
        case .fa: "فایل"
        case .tr: "Dosya"
        }
    }
}
