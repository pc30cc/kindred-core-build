import Foundation

/// Who is asking — the card at the top of a platform-support conversation in
/// the support team's inbox (docs/PLATFORM_SUPPORT.md). The Android app's
/// `requester*` words, and the plan's dates beside them.
enum RequesterStr {
    static func title(_ l: Language) -> String {
        switch l {
        case .en: "Who is asking"
        case .fa: "مشخصات درخواست‌کننده"
        case .tr: "Talep eden"
        }
    }

    static func teamOnly(_ l: Language) -> String {
        switch l {
        case .en: "Only your team sees this"
        case .fa: "فقط تیم شما این را می‌بیند"
        case .tr: "Bunu yalnızca ekibiniz görür"
        }
    }

    static func memberSince(_ l: Language, _ date: String) -> String {
        switch l {
        case .en: "Member since \(date)"
        case .fa: "عضو از \(date)"
        case .tr: "\(date) tarihinden beri üye"
        }
    }

    static func via(_ l: Language, _ app: String) -> String {
        switch l {
        case .en: "Wrote from \(app)"
        case .fa: "از \(app) نوشته"
        case .tr: "\(app) üzerinden yazdı"
        }
    }

    static func from(_ l: Language, _ workspace: String) -> String {
        switch l {
        case .en: "From \(workspace)"
        case .fa: "از \(workspace)"
        case .tr: "\(workspace) çalışma alanından"
        }
    }

    static func workspaces(_ l: Language, _ count: Int) -> String {
        let n = Format.number(count, language: l)
        switch l {
        case .en: return count == 1 ? "1 workspace" : "\(n) workspaces"
        case .fa: return "\(n) ورک‌اسپیس"
        case .tr: return "\(n) çalışma alanı"
        }
    }

    static func more(_ l: Language, _ count: Int) -> String {
        let n = Format.number(count, language: l)
        switch l {
        case .en: return "and \(n) more"
        case .fa: return "و \(n) مورد دیگر"
        case .tr: return "ve \(n) tane daha"
        }
    }

    static func noPlan(_ l: Language) -> String {
        switch l {
        case .en: "No plan"
        case .fa: "بدون پلن"
        case .tr: "Plan yok"
        }
    }

    static func free(_ l: Language) -> String {
        switch l {
        case .en: "Free"
        case .fa: "رایگان"
        case .tr: "Ücretsiz"
        }
    }

    /// A member's role in their workspace; an unknown one as the server named it.
    static func role(_ l: Language, _ role: String) -> String {
        switch (role, l) {
        case ("owner", .en): "Owner"
        case ("owner", .fa): "مالک"
        case ("owner", .tr): "Sahip"
        case ("admin", .en): "Admin"
        case ("admin", .fa): "مدیر"
        case ("admin", .tr): "Yönetici"
        case ("agent", .en): "Operator"
        case ("agent", .fa): "اپراتور"
        case ("agent", .tr): "Operatör"
        default: role
        }
    }

    /// A subscription's state in a word; an unknown one as the server named it.
    static func status(_ l: Language, _ status: String) -> String {
        switch (status, l) {
        case ("active", .en): "Active"
        case ("active", .fa): "فعال"
        case ("active", .tr): "Aktif"
        case ("trialing", .en): "Trial"
        case ("trialing", .fa): "آزمایشی"
        case ("trialing", .tr): "Deneme"
        case ("past_due", .en): "Past due"
        case ("past_due", .fa): "معوق"
        case ("past_due", .tr): "Gecikmiş"
        case ("canceled", .en), ("cancelled", .en): "Canceled"
        case ("canceled", .fa), ("cancelled", .fa): "لغوشده"
        case ("canceled", .tr), ("cancelled", .tr): "İptal edildi"
        case ("expired", .en): "Expired"
        case ("expired", .fa): "منقضی"
        case ("expired", .tr): "Süresi doldu"
        default: status
        }
    }

    static func interval(_ l: Language, _ interval: String) -> String? {
        switch (interval, l) {
        case ("monthly", .en), ("month", .en): "Monthly"
        case ("monthly", .fa), ("month", .fa): "ماهانه"
        case ("monthly", .tr), ("month", .tr): "Aylık"
        case ("yearly", .en), ("annual", .en), ("year", .en): "Yearly"
        case ("yearly", .fa), ("annual", .fa), ("year", .fa): "سالانه"
        case ("yearly", .tr), ("annual", .tr), ("year", .tr): "Yıllık"
        case ("quarterly", .en): "Quarterly"
        case ("quarterly", .fa): "سه‌ماهه"
        case ("quarterly", .tr): "Üç aylık"
        default: nil
        }
    }

    /// When the plan (or this period of it) was bought.
    static func purchased(_ l: Language) -> String {
        switch l {
        case .en: "Purchased"
        case .fa: "تاریخ خرید"
        case .tr: "Satın alma"
        }
    }

    /// When it runs out.
    static func expires(_ l: Language) -> String {
        switch l {
        case .en: "Expires"
        case .fa: "تاریخ اتمام"
        case .tr: "Bitiş"
        }
    }

    static func trialEnds(_ l: Language) -> String {
        switch l {
        case .en: "Trial ends"
        case .fa: "پایان دورهٔ آزمایشی"
        case .tr: "Deneme bitişi"
        }
    }

    static func renewsAutomatically(_ l: Language) -> String {
        switch l {
        case .en: "Renews automatically"
        case .fa: "تمدید خودکار"
        case .tr: "Otomatik yenilenir"
        }
    }

    static func wontRenew(_ l: Language) -> String {
        switch l {
        case .en: "Won't renew"
        case .fa: "تمدید نمی‌شود"
        case .tr: "Yenilenmeyecek"
        }
    }

    static func daysLeft(_ l: Language, _ days: Int) -> String {
        let n = Format.number(days, language: l)
        switch l {
        case .en: return days == 1 ? "1 day left" : "\(n) days left"
        case .fa: return "\(n) روز مانده"
        case .tr: return "\(n) gün kaldı"
        }
    }

    static func endsToday(_ l: Language) -> String {
        switch l {
        case .en: "Ends today"
        case .fa: "امروز تمام می‌شود"
        case .tr: "Bugün bitiyor"
        }
    }

    static func expiredAgo(_ l: Language, _ days: Int) -> String {
        let n = Format.number(days, language: l)
        switch l {
        case .en: return days == 1 ? "Expired 1 day ago" : "Expired \(n) days ago"
        case .fa: return "\(n) روز پیش تمام شده"
        case .tr: return "\(n) gün önce sona erdi"
        }
    }

    static func customerSince(_ l: Language, _ date: String) -> String {
        switch l {
        case .en: "Customer since \(date)"
        case .fa: "مشتری از \(date)"
        case .tr: "\(date) tarihinden beri müşteri"
        }
    }

    static func usageThisMonth(_ l: Language) -> String {
        switch l {
        case .en: "This month"
        case .fa: "مصرف این ماه"
        case .tr: "Bu ay"
        }
    }

    static func operators(_ l: Language) -> String {
        switch l {
        case .en: "Operators"
        case .fa: "اپراتورها"
        case .tr: "Operatörler"
        }
    }

    static func conversations(_ l: Language) -> String {
        switch l {
        case .en: "Conversations"
        case .fa: "گفتگوها"
        case .tr: "Görüşmeler"
        }
    }

    static func visitors(_ l: Language) -> String {
        switch l {
        case .en: "Visitors"
        case .fa: "بازدیدکنندگان"
        case .tr: "Ziyaretçiler"
        }
    }

    static func contacts(_ l: Language) -> String {
        switch l {
        case .en: "Contacts"
        case .fa: "مخاطبان"
        case .tr: "Kişiler"
        }
    }

    static func aiCredits(_ l: Language) -> String {
        switch l {
        case .en: "AI credits"
        case .fa: "اعتبار هوش مصنوعی"
        case .tr: "Yapay zekâ kredisi"
        }
    }

    static func messages(_ l: Language) -> String {
        switch l {
        case .en: "Messages"
        case .fa: "پیام‌ها"
        case .tr: "Mesajlar"
        }
    }

    static func storage(_ l: Language) -> String {
        switch l {
        case .en: "Storage"
        case .fa: "فضای ذخیره‌سازی"
        case .tr: "Depolama"
        }
    }

    static func asOf(_ l: Language, _ date: String) -> String {
        switch l {
        case .en: "As of \(date)"
        case .fa: "در تاریخ \(date)"
        case .tr: "\(date) itibarıyla"
        }
    }
}
