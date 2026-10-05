import Foundation

/// Settings → Online support's copy: the chat with the platform's own team
/// (docs/PLATFORM_SUPPORT.md).
///
/// The same words the Android app uses (`StrAndroid.support*`), so an
/// operator who has both phones reads one product. Apart from `Str` because
/// `Strings.swift` is the source the Android app's `Strings.kt` is generated
/// from, and Android keeps these in its own file already.
enum SupportStr {

    /// Settings: the section that reaches the platform's own team.
    static func section(_ l: Language) -> String {
        switch l {
        case .en: "Online support"
        case .fa: "پشتیبانی آنلاین"
        case .tr: "Canlı destek"
        }
    }

    /// The chat's title when the team's workspace has no name.
    static func title(_ l: Language) -> String {
        switch l {
        case .en: "Support"
        case .fa: "پشتیبانی"
        case .tr: "Destek"
        }
    }

    static func chat(_ l: Language) -> String {
        switch l {
        case .en: "Chat with support"
        case .fa: "گفتگو با پشتیبانی"
        case .tr: "Destekle sohbet et"
        }
    }

    static func online(_ l: Language) -> String {
        switch l {
        case .en: "Online"
        case .fa: "آنلاین"
        case .tr: "Çevrimiçi"
        }
    }

    /// Nobody on the team now: a message still reaches them.
    static func offlineLeaveMessage(_ l: Language) -> String {
        switch l {
        case .en: "Offline · Leave a message"
        case .fa: "آفلاین · پیغام بگذارید"
        case .tr: "Çevrimdışı · Mesaj bırakın"
        }
    }

    /// "Online", or "Offline · Leave a message": who is there, in a word.
    static func presence(_ l: Language, online: Bool) -> String {
        online ? self.online(l) : offlineLeaveMessage(l)
    }

    /// The chat's banner while nobody on the team is online.
    static func offlineBanner(_ l: Language) -> String {
        switch l {
        case .en: "Nobody is online right now. Leave a message — we'll answer right here as soon as we can."
        case .fa: "الان کسی آنلاین نیست. پیغام بگذارید؛ در اولین فرصت همین‌جا پاسخ می‌دهیم."
        case .tr: "Şu anda kimse çevrimiçi değil. Mesaj bırakın; en kısa sürede buradan yanıt vereceğiz."
        }
    }

    /// Over the team's week, in the offline banner.
    static func hoursTitle(_ l: Language) -> String {
        switch l {
        case .en: "Hours"
        case .fa: "ساعات پاسخگویی"
        case .tr: "Çalışma saatleri"
        }
    }

    /// A day of the team's week, by the key `/status` files it under (`sat`…`fri`).
    static func weekday(_ l: Language, _ key: String) -> String {
        switch key {
        case "sat":
            switch l {
            case .en: "Saturday"
            case .fa: "شنبه"
            case .tr: "Cumartesi"
            }
        case "sun":
            switch l {
            case .en: "Sunday"
            case .fa: "یکشنبه"
            case .tr: "Pazar"
            }
        case "mon":
            switch l {
            case .en: "Monday"
            case .fa: "دوشنبه"
            case .tr: "Pazartesi"
            }
        case "tue":
            switch l {
            case .en: "Tuesday"
            case .fa: "سه‌شنبه"
            case .tr: "Salı"
            }
        case "wed":
            switch l {
            case .en: "Wednesday"
            case .fa: "چهارشنبه"
            case .tr: "Çarşamba"
            }
        case "thu":
            switch l {
            case .en: "Thursday"
            case .fa: "پنجشنبه"
            case .tr: "Perşembe"
            }
        default:
            switch l {
            case .en: "Friday"
            case .fa: "جمعه"
            case .tr: "Cuma"
            }
        }
    }

    /// Several days in a row with the same hours: "Saturday–Wednesday".
    static func dayRange(_ l: Language, _ first: String, _ last: String) -> String {
        switch l {
        case .en, .tr: "\(first)–\(last)"
        case .fa: "\(first) تا \(last)"
        }
    }

    /// One opening: "9:00–17:00".
    static func interval(_ l: Language, _ from: String, _ to: String) -> String {
        switch l {
        case .en, .tr: "\(from)–\(to)"
        case .fa: "\(from) تا \(to)"
        }
    }

    /// A line of the week: the days, then their hours.
    static func hoursLine(_ l: Language, days: String, times: String) -> String {
        switch l {
        case .en, .tr: "\(days): \(times)"
        case .fa: "\(days) \(times)"
        }
    }

    static func closedDays(_ l: Language, _ days: String) -> String {
        switch l {
        case .en: "\(days): closed"
        case .fa: "\(days) تعطیل"
        case .tr: "\(days): kapalı"
        }
    }

    /// Under the week, when the team keeps another clock than this phone's.
    static func timeZone(_ l: Language, _ zone: String) -> String {
        switch l {
        case .en: "Time zone: \(zone)"
        case .fa: "منطقهٔ زمانی: \(zone)"
        case .tr: "Saat dilimi: \(zone)"
        }
    }

    /// When the hours open again. `day` is "tomorrow", a weekday or a date,
    /// and nil for later today.
    static func nextOpen(_ l: Language, day: String?, time: String) -> String {
        switch l {
        case .en:
            guard let day else { return "We'll be back at \(time)" }
            return "We'll be back \(day) at \(time)"
        case .fa:
            guard let day else { return "از ساعت \(time) پاسخگو هستیم" }
            return "از \(day) ساعت \(time) پاسخگو هستیم"
        case .tr:
            guard let day else { return "Saat \(time) itibarıyla yanıt veriyoruz" }
            let capitalised = day.prefix(1).uppercased(with: l.locale) + day.dropFirst()
            return "\(capitalised) saat \(time) itibarıyla yanıt veriyoruz"
        }
    }

    /// Before each conversation after the first, with the day it began.
    static func newConversation(_ l: Language, date: String?) -> String {
        let label = switch l {
        case .en: "New conversation"
        case .fa: "گفتگوی تازه"
        case .tr: "Yeni görüşme"
        }
        guard let date, !date.isEmpty else { return label }
        return "\(label) · \(date)"
    }

    /// An agent was assigned, or the conversation transferred to them.
    static func joined(_ l: Language, name: String?) -> String {
        let who = name.flatMap { $0.trimmingCharacters(in: .whitespaces).isEmpty ? nil : $0 } ?? team(l)
        switch l {
        case .en: return "\(who) joined the conversation"
        case .fa: return "\(who) به گفتگو پیوست"
        case .tr: return "\(who) görüşmeye katıldı"
        }
    }

    /// Who joined, when the join names nobody.
    static func team(_ l: Language) -> String {
        switch l {
        case .en: "Support team"
        case .fa: "تیم پشتیبانی"
        case .tr: "Destek ekibi"
        }
    }

    /// The line under an ended conversation, by its status.
    static func ended(_ l: Language, status: String) -> String {
        if status == SupportConversation.closed {
            switch l {
            case .en: "This conversation was closed"
            case .fa: "این گفتگو بسته شد"
            case .tr: "Bu görüşme kapatıldı"
            }
        } else {
            switch l {
            case .en: "This conversation was resolved"
            case .fa: "این گفتگو حل شد"
            case .tr: "Bu görüşme çözüldü"
            }
        }
    }

    /// The screen of conversations that ended.
    static func closedTitle(_ l: Language) -> String {
        switch l {
        case .en: "Closed conversations"
        case .fa: "گفتگوهای بسته‌شده"
        case .tr: "Kapanan görüşmeler"
        }
    }

    /// The chat bar's button to the closed conversations, in a word.
    static func closedAction(_ l: Language) -> String {
        switch l {
        case .en: "Closed"
        case .fa: "بسته‌شده‌ها"
        case .tr: "Kapananlar"
        }
    }

    static func closedEmpty(_ l: Language) -> String {
        switch l {
        case .en: "No closed conversations yet"
        case .fa: "هنوز گفتگوی بسته‌شده‌ای ندارید"
        case .tr: "Henüz kapanan görüşme yok"
        }
    }

    /// How a conversation ended, in a word: a closed conversation's row.
    static func statusWord(_ l: Language, status: String) -> String {
        if status == SupportConversation.closed {
            switch l {
            case .en: "Closed"
            case .fa: "بسته شد"
            case .tr: "Kapatıldı"
            }
        } else {
            switch l {
            case .en: "Resolved"
            case .fa: "حل شد"
            case .tr: "Çözüldü"
            }
        }
    }

    /// A closed conversation's row, while it waits for its stars.
    static func rateAction(_ l: Language) -> String {
        switch l {
        case .en: "Rate"
        case .fa: "امتیاز دهید"
        case .tr: "Değerlendir"
        }
    }

    /// A closed conversation with nothing to name it by.
    static func conversationUntitled(_ l: Language) -> String {
        switch l {
        case .en: "Conversation with support"
        case .fa: "گفتگو با پشتیبانی"
        case .tr: "Destekle görüşme"
        }
    }

    /// Under an ended conversation, in place of the composer.
    static func endedPanelBody(_ l: Language) -> String {
        switch l {
        case .en: "It can't be continued. Need more help? Start a new conversation."
        case .fa: "ادامهٔ این گفتگو ممکن نیست. اگر باز هم کمک لازم دارید، گفتگوی جدیدی شروع کنید."
        case .tr: "Bu görüşme sürdürülemez. Yardıma mı ihtiyacınız var? Yeni bir görüşme başlatın."
        }
    }

    static func startNew(_ l: Language) -> String {
        switch l {
        case .en: "Start a new conversation"
        case .fa: "شروع گفتگوی جدید"
        case .tr: "Yeni görüşme başlat"
        }
    }

    /// The team ended the conversation while a message was on its way to it.
    static func conversationEnded(_ l: Language) -> String {
        switch l {
        case .en: "This conversation has ended, so your message wasn't sent. Start a new conversation to send it."
        case .fa: "این گفتگو بسته شده و پیام شما ارسال نشد. برای ارسال، گفتگوی جدیدی شروع کنید."
        case .tr: "Bu görüşme sona erdi, mesajınız gönderilmedi. Göndermek için yeni bir görüşme başlatın."
        }
    }

    static func rateTitle(_ l: Language) -> String {
        switch l {
        case .en: "Rate this conversation"
        case .fa: "به این گفتگو امتیاز دهید"
        case .tr: "Bu görüşmeyi değerlendirin"
        }
    }

    /// A star's spoken label, or a rating's: "4 stars".
    static func stars(_ l: Language, _ count: Int) -> String {
        switch l {
        case .en: count == 1 ? "1 star" : "\(count) stars"
        case .fa: "\(Format.number(count, language: l)) ستاره"
        case .tr: "\(count) yıldız"
        }
    }

    static func rateComment(_ l: Language) -> String {
        switch l {
        case .en: "Anything to add? (optional)"
        case .fa: "نظر شما (اختیاری)"
        case .tr: "Eklemek istedikleriniz (isteğe bağlı)"
        }
    }

    static func rateSubmit(_ l: Language) -> String {
        switch l {
        case .en: "Submit rating"
        case .fa: "ثبت امتیاز"
        case .tr: "Puanı gönder"
        }
    }

    static func yourRating(_ l: Language) -> String {
        switch l {
        case .en: "Your rating"
        case .fa: "امتیاز شما"
        case .tr: "Puanınız"
        }
    }

    /// An empty chat, before the first message.
    static func greeting(_ l: Language) -> String {
        switch l {
        case .en: "Hi! How can we help?"
        case .fa: "سلام! چطور می‌توانیم کمکتان کنیم؟"
        case .tr: "Merhaba! Size nasıl yardımcı olabiliriz?"
        }
    }

    /// Under the greeting: what happens to a first message.
    static func greetingBody(_ l: Language) -> String {
        switch l {
        case .en: "Write to the Webyar team here. Your message starts a new conversation."
        case .fa: "پیام خود را برای تیم وب‌یار همین‌جا بنویسید؛ با اولین پیام، گفتگوی تازه‌ای شروع می‌شود."
        case .tr: "Webyar ekibine buradan yazın. İlk mesajınız yeni bir görüşme başlatır."
        }
    }

    static func notSent(_ l: Language) -> String {
        switch l {
        case .en: "Not sent — tap to try again"
        case .fa: "ارسال نشد — برای تلاش دوباره بزنید"
        case .tr: "Gönderilmedi — tekrar denemek için dokunun"
        }
    }

    /// A file over the support limit (2 MB), refused before the upload.
    static func fileTooLarge(_ l: Language) -> String {
        switch l {
        case .en: "The file must be 2 MB or smaller"
        case .fa: "حجم فایل باید حداکثر ۲ مگابایت باشد"
        case .tr: "Dosya en fazla 2 MB olmalı"
        }
    }

    static func rateLimited(_ l: Language) -> String {
        switch l {
        case .en: "That's a lot of messages — wait a moment."
        case .fa: "پیام‌ها زیاد شد؛ کمی صبر کنید."
        case .tr: "Çok fazla mesaj; biraz bekleyin."
        }
    }

    static func unavailable(_ l: Language) -> String {
        switch l {
        case .en: "Support isn't available right now."
        case .fa: "پشتیبانی در حال حاضر در دسترس نیست."
        case .tr: "Destek şu anda kullanılamıyor."
        }
    }

    static func messageTooLong(_ l: Language, limit: Int) -> String {
        let count = Format.number(limit, language: l)
        switch l {
        case .en: return "This message is too long — \(count) characters at most."
        case .fa: return "این پیام خیلی طولانی است — حداکثر \(count) نویسه."
        case .tr: return "Bu mesaj çok uzun — en fazla \(count) karakter."
        }
    }

    /// Read aloud on the Settings row: how many of the team's messages wait.
    static func unread(_ l: Language, _ count: Int) -> String {
        let number = Format.number(count, language: l)
        switch l {
        case .en: return count == 1 ? "1 unread message" : "\(number) unread messages"
        case .fa: return "\(number) پیام خوانده‌نشده"
        case .tr: return "\(number) okunmamış mesaj"
        }
    }
}
