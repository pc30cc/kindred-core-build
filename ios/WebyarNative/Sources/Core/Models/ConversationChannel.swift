import Foundation

/// Where a visitor is writing from — the website's chat, Telegram, WhatsApp…
///
/// The inbound pipeline stamps the provider on the conversation
/// (`metadata.channel`, `server/services/channels/inboundProcessing.ts`) and
/// on the contact; a thread from the site's own widget carries none. So the
/// answer is the conversation's, then the contact's, then "the website" —
/// the order `resolveChannelKey` in `ChannelBadge.tsx` reads them in, and
/// like it only a channel it knows counts: `metadata.source` also says how a
/// thread began (`ai_agent_intro`, an import…), which is not where anyone
/// writes from, so such a value is passed over, not shown.
///
/// The same rules as the Android app's `ConversationChannel`.
enum ConversationChannel {
    static let web = "widget"

    /// An operator of the platform writing to its support team, from Settings
    /// in one of the apps (docs/PLATFORM_SUPPORT.md) — only ever in the
    /// support workspace's own inbox.
    static let platformSupport = "platform_support"

    /// Every channel a label is drawn for; the rest read as the website.
    static let known: Set<String> = [
        "telegram", "bale", "whatsapp", "instagram", "x", "email", "phone", "messenger", "sms", platformSupport,
    ]

    static func of(_ conversation: Conversation?) -> String {
        guard let conversation else { return web }
        for meta in [conversation.metadata, conversation.contact?.metadata] {
            let raw = meta?["channel"]?.stringValue ?? meta?["source"]?.stringValue
            let key = normalize(raw)
            if known.contains(key) { return key }
        }
        return web
    }

    /// The app a support conversation was written from — "Android", "iOS",
    /// "macOS", "Windows" or "Web" — as the server stamps it
    /// (`client_platform`) on the conversation, and on the contact as well.
    /// Nil for any other channel, and for a value it does not know.
    static func clientPlatform(_ conversation: Conversation?) -> String? {
        guard let conversation, of(conversation) == platformSupport else { return nil }
        for meta in [conversation.metadata, conversation.contact?.metadata] {
            switch meta?["client_platform"]?.stringValue?.trimmingCharacters(in: .whitespaces).lowercased() {
            case "android": return "Android"
            case "ios": return "iOS"
            case "macos": return "macOS"
            case "windows": return "Windows"
            case "web": return "Web"
            default: continue
            }
        }
        return nil
    }

    /// Lower-cased and trimmed, with a provider's other names folded into one.
    static func normalize(_ raw: String?) -> String {
        let key = (raw ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        switch key {
        case "", "widget", "web", "website", "chat", "livechat": return web
        case "twitter": return "x"
        case "facebook": return "messenger"
        default: return key
        }
    }

    /// The channel's name as it writes itself. Product names are not
    /// translated; the website is, because "the website" is not a product.
    static func title(_ key: String, language: Language) -> String {
        switch key {
        case platformSupport:
            switch language {
            case .en: return "Site user"
            case .fa: return "کاربر سایت"
            case .tr: return "Site kullanıcısı"
            }
        case web:
            switch language {
            case .en: return "Website"
            case .fa: return "وب‌سایت"
            case .tr: return "Web sitesi"
            }
        case "email":
            switch language {
            case .en: return "Email"
            case .fa: return "ایمیل"
            case .tr: return "E-posta"
            }
        case "phone":
            switch language {
            case .en: return "Phone"
            case .fa: return "تلفن"
            case .tr: return "Telefon"
            }
        default:
            return ChannelInbox(key: key).title(language)
        }
    }

    /// The label's words: the channel's name, and for a support conversation
    /// the app it came from — "Site user · Android". Product names are not
    /// translated.
    static func label(_ key: String, language: Language, platform: String? = nil) -> String {
        let title = title(key, language: language)
        guard key == platformSupport, let platform, !platform.isEmpty else { return title }
        return "\(title) · \(platform)"
    }
}
