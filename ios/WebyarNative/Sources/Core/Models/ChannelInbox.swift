import SwiftUI

/// A messaging channel the workspace has actually installed — Telegram, Bale,
/// WhatsApp and the rest.
///
/// These are inboxes in the operator's sense but not queues in the server's:
/// the conversations endpoint has no `channel` parameter, and the console
/// narrows its own list the same way. So a channel is a filter laid over
/// whichever queue is open, exactly as `?channel=` is on the web.
struct ChannelInbox: Identifiable, Hashable, Sendable {
    /// The plugin slug, which is also what a conversation carries in
    /// `metadata.channel`.
    let key: String

    var id: String { key }

    /// Written the way the channel writes itself. A product name is not
    /// translated — except Bale, which is Persian to begin with.
    func title(_ language: Language) -> String {
        switch key {
        case "telegram": return "Telegram"
        case "bale": return language == .fa ? "بله" : "Bale"
        case "whatsapp": return "WhatsApp"
        case "instagram": return "Instagram"
        case "x", "twitter": return "X"
        case "messenger", "facebook": return "Messenger"
        case "sms": return language == .fa ? "پیامک" : "SMS"
        // Not plugins, so never in the switcher -- but a conversation can
        // arrive on any of them, and the inbox row names where it came from.
        case "widget": return Str.channelWidget(language)
        case "email": return Str.emailLabel(language)
        case "phone": return Str.channelPhone(language)
        default: return key.prefix(1).uppercased() + key.dropFirst()
        }
    }

    var icon: String {
        switch key {
        case "telegram", "bale", "messenger", "facebook": "paperplane"
        case "whatsapp": "bubble.left.and.bubble.right"
        case "instagram": "camera"
        case "x", "twitter": "at"
        case "sms": "text.bubble"
        case "widget": "bubble.left"
        case "email": "envelope"
        case "phone": "phone"
        default: "square.grid.2x2"
        }
    }

    /// The colour the console gives this channel, so a thread is the same
    /// shade of blue on a phone as on a desk.
    @MainActor
    var tint: Color {
        switch key {
        case "telegram": Color(hue: 200 / 360, saturation: 0.90, brightness: 0.78)
        case "bale": Color(hue: 150 / 360, saturation: 0.60, brightness: 0.62)
        case "whatsapp": Theme.Palette.success
        case "instagram": Color(hue: 330 / 360, saturation: 0.75, brightness: 0.78)
        case "x", "twitter": Theme.Palette.label
        case "widget": Theme.Palette.brand
        default: Theme.Palette.labelSecondary
        }
    }
}

/// One row of `GET /api/plugins/catalog`.
///
/// Only the fields that decide whether a channel belongs in the switcher are
/// decoded; the catalog carries a great deal more that only the marketplace
/// needs.
struct PluginCatalogItem: Decodable, Sendable {
    let slug: String?
    let installed: Bool?
    let supportsInbox: Bool?
    let planAllowed: Bool?
    let installationStatus: String?

    /// Installed, inbox-capable, and still inside the plan.
    ///
    /// `planAllowed` matters as much as `installed`: a workspace that
    /// downgrades keeps its installation row, and an inbox it can no longer
    /// use should not be offered.
    var isUsableInbox: Bool {
        installed == true && supportsInbox == true && planAllowed != false
    }
}

struct PluginCatalogResponse: Decodable, Sendable {
    let items: [PluginCatalogItem]?
}

extension Conversation {
    /// Which channel a thread came in on.
    ///
    /// `metadata.channel`, then `metadata.source`, then the widget — the same
    /// order and the same default as `resolveChannelKey` in the console, so a
    /// conversation is never filed under a different channel on the two
    /// surfaces.
    var channelKey: String {
        if let channel = metadata?["channel"]?.stringValue, !channel.isEmpty { return channel }
        if let source = metadata?["source"]?.stringValue, !source.isEmpty { return source }
        return "widget"
    }
}
