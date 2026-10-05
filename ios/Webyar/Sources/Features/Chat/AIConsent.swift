import Foundation

/// Whether the operator on this phone has agreed to "Send with AI".
///
/// That button sends what the operator wrote, with the conversation's recent
/// messages, to the AI service the platform uses, which writes the reply the
/// visitor receives. App Review asks for the operator's permission before
/// personal data goes to a third-party AI, so the first send asks, once.
///
/// Forgotten when the session ends, so the next operator to sign in on this
/// phone is asked for their own.
enum AIConsent {
    private static let key = "ai.sendWithAIConsent"

    static var hasAgreed: Bool {
        UserDefaults.standard.bool(forKey: key)
    }

    static func agree() {
        UserDefaults.standard.set(true, forKey: key)
    }

    static func reset() {
        UserDefaults.standard.removeObject(forKey: key)
    }
}

enum AIConsentStr {
    static func title(_ l: Language) -> String {
        switch l {
        case .en: "Send with AI?"
        case .fa: "ارسال با هوش مصنوعی؟"
        case .tr: "Yapay zekâ ile gönderilsin mi?"
        case .ar: "الإرسال عبر الذكاء الاصطناعي؟"
        }
    }

    static func body(_ l: Language) -> String {
        switch l {
        case .en: "To write this reply, what you typed and the recent messages of this conversation are sent to the third-party AI service the platform uses. The visitor receives the AI's reply. The Privacy Policy, at the foot of Settings, explains how this data is handled."
        case .fa: "برای نوشتن این پاسخ، آنچه نوشته‌اید و پیام‌های اخیر این گفتگو به سرویس هوش مصنوعی شخص ثالثی که پلتفرم از آن استفاده می‌کند فرستاده می‌شود. بازدیدکننده پاسخ هوش مصنوعی را دریافت می‌کند. سیاست حفظ حریم خصوصی، در پایین صفحهٔ تنظیمات، توضیح می‌دهد این داده‌ها چگونه نگهداری می‌شوند."
        case .tr: "Bu yanıtı yazmak için yazdıklarınız ve bu konuşmanın son mesajları, platformun kullandığı üçüncü taraf yapay zekâ hizmetine gönderilir. Ziyaretçi yapay zekânın yanıtını alır. Bu verilerin nasıl işlendiği, Ayarlar'ın en altındaki Gizlilik Politikası'nda açıklanır."
        case .ar: "لكتابة هذا الرد، يُرسَل ما كتبته والرسائل الأخيرة في هذه المحادثة إلى خدمة الذكاء الاصطناعي الخارجية التي تستخدمها المنصة. ويتلقى الزائر رد الذكاء الاصطناعي. توضح سياسة الخصوصية، في أسفل صفحة الإعدادات، كيفية التعامل مع هذه البيانات."
        }
    }

    static func allow(_ l: Language) -> String {
        switch l {
        case .en: "Allow and send"
        case .fa: "اجازه می‌دهم و ارسال"
        case .tr: "İzin ver ve gönder"
        case .ar: "السماح والإرسال"
        }
    }
}
