import SwiftUI

/// Where a conversation came in on: the channel's glyph and its name.
///
/// The console has carried this on every inbox row for as long as there have
/// been channels, and without it a phone is the one surface where two threads
/// that look identical are a Telegram message and a website chat. An operator
/// answers those differently -- different tone, different expectations about
/// attachments, a different apology when it takes an hour.
///
/// The key, the name and the colour all come from `ChannelInbox`, which reads
/// the same `metadata.channel` the console's `resolveChannelKey` does and
/// falls back to the widget the same way. One rule, two surfaces.
struct ChannelMark: View {
    let key: String
    let language: Language

    private var channel: ChannelInbox { ChannelInbox(key: key) }

    var body: some View {
        HStack(spacing: Theme.Space.xxs) {
            Image(systemName: channel.icon)
                .font(.system(size: 9, weight: .semibold))

            Text(channel.title(language))
                .font(.app(.caption2, weight: .medium))
                .lineLimit(1)
        }
        .foregroundStyle(channel.tint)
        .padding(.horizontal, Theme.Space.xs)
        .padding(.vertical, 1)
        .background {
            Capsule()
                .fill(channel.tint.opacity(0.10))
                .overlay(Capsule().strokeBorder(channel.tint.opacity(0.20), lineWidth: 0.5))
        }
        // A product name is a product name in every language: "Telegram"
        // reads left to right inside a Persian row.
        .environment(\.layoutDirection, .leftToRight)
    }
}
