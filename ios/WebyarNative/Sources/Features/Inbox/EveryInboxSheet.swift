import SwiftUI

/// An icon on the strip, after the inboxes, as the Android app has them: the
/// envelope that opens the mailbox, and the three lines that open every
/// inbox — with a red dot when something behind it is unread.
///
/// Buttons rather than segments: neither is an inbox of the strip's own. The
/// mailbox is a screen of its own that Back comes home from, and the three
/// lines open a list. The three lines are lit while the list on screen is one
/// of theirs — a channel, or a queue not on the strip.
struct StripIconButton: View {
    let systemImage: String
    let label: String
    var lit = false
    var unread = 0
    let language: Language
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(lit ? Theme.Palette.brand : Theme.Palette.labelSecondary)
                .frame(width: 44, height: 34)
                .background(Capsule().fill(lit ? Theme.Palette.brand.opacity(0.14) : Theme.Palette.surfaceElevated))
                // On the glyph's corner, as a badge sits on an icon; ringed in
                // the screen's colour so it reads as cut out of the button.
                .overlay(alignment: .topTrailing) {
                    if unread > 0 {
                        Circle()
                            .fill(Theme.Palette.danger)
                            .frame(width: 8, height: 8)
                            .overlay(Circle().stroke(Theme.Palette.background, lineWidth: 1.5))
                            .padding(.top, 6)
                            .padding(.trailing, 10)
                            .transition(.scale(scale: 0.3).combined(with: .opacity))
                    }
                }
                .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .animation(.spring(response: 0.3, dampingFraction: 0.7), value: unread > 0)
        .accessibilityLabel(label)
        .accessibilityValue(
            unread > 0
                ? Str.tabUnread(language).filling("count", with: Format.number(unread, language: language))
                : ""
        )
        .accessibilityAddTraits(lit ? [.isButton, .isSelected] : .isButton)
    }
}

/// Every inbox, in one sheet — what the strip's three lines open: the queues
/// with their counts, the channel inboxes, and the two that are not queues —
/// the colleagues' chats, shown in the inbox like a queue, and the mailbox
/// (one row per mailbox when a Gmail and a Yahoo are both connected), a
/// screen of its own. The one on screen carries a tick.
struct EveryInboxSheet: View {
    let language: Language
    let filters: [InboxFilter]
    let selectedFilter: InboxFilter
    let counts: InboxCounts?
    let channels: [ChannelInbox]
    let selectedChannel: ChannelInbox?
    let colleaguesShown: Bool
    /// Nil when team chat is not offered here.
    let colleaguesUnread: Int?
    /// Open conversations nobody has read: a red dot on Open.
    let openUnread: Int
    /// Empty when the mailbox is not offered here.
    let emailEntries: [EmailEntry]
    let onSelectFilter: (InboxFilter) -> Void
    let onSelectChannel: (ChannelInbox) -> Void
    let onOpenColleagues: () -> Void
    let onOpenEmail: (String?) -> Void

    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        NavigationStack {
            List {
                Section(Str.tabInbox(language)) {
                    ForEach(filters) { filter in
                        row(
                            label: filter.title(language),
                            selected: !colleaguesShown && selectedChannel == nil && filter == selectedFilter,
                            count: counts?.count(for: filter),
                            unread: filter == .open ? openUnread : 0
                        ) {
                            icon(Image(systemName: filter.icon), tint: Theme.Palette.labelSecondary)
                        } action: {
                            onSelectFilter(filter)
                        }
                        .accessibilityIdentifier(A11y.everyInboxRow(filter.rawValue))
                    }
                }

                if !channels.isEmpty {
                    Section(Str.otherInboxes(language)) {
                        ForEach(channels) { channel in
                            row(
                                label: channel.title(language),
                                selected: !colleaguesShown && selectedChannel == channel,
                                count: nil,
                                unread: 0
                            ) {
                                icon(
                                    ChannelMark(key: channel.key, size: 15),
                                    tint: ChannelLook.of(channel.key).color(colorScheme)
                                )
                            } action: {
                                onSelectChannel(channel)
                            }
                            .accessibilityIdentifier(A11y.everyInboxRow(channel.key))
                        }
                    }
                }

                if colleaguesUnread != nil || !emailEntries.isEmpty {
                    Section(EmailStr.teamAndMail(language)) {
                        if let colleaguesUnread {
                            row(
                                label: Str.colleagues(language),
                                selected: colleaguesShown,
                                count: colleaguesUnread,
                                unread: 0
                            ) {
                                icon(Image(systemName: "person.2.fill"), tint: Theme.Palette.labelSecondary)
                            } action: {
                                onOpenColleagues()
                            }
                            .accessibilityIdentifier(A11y.everyInboxRow("colleagues"))
                        }
                        ForEach(emailEntries, id: \.label) { entry in
                            row(label: entry.label, selected: false, count: entry.unread, unread: 0) {
                                icon(Image(systemName: "envelope.fill"), tint: Theme.Palette.labelSecondary)
                            } action: {
                                onOpenEmail(entry.provider)
                            }
                            .accessibilityIdentifier(A11y.everyInboxRow("email.\(entry.provider ?? "default")"))
                        }
                    }
                }
            }
            .listStyle(.insetGrouped)
            .navigationTitle(EmailStr.everyInbox(language))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button {
                        dismiss()
                    } label: {
                        Image(systemName: "xmark")
                    }
                    .accessibilityLabel(Str.cancel(language))
                }
            }
        }
        .presentationDetents([.large])
        .presentationDragIndicator(.visible)
        // A sheet is presented in a hosting controller of its own and does
        // not inherit the screen's direction: Persian reads from the right
        // here too.
        .environment(\.layoutDirection, language.layoutDirection)
        .accessibilityIdentifier(A11y.everyInboxSheet)
    }

    /// An inbox's mark in a circle, as the Android sheet draws it.
    private func icon(_ mark: some View, tint: Color) -> some View {
        mark
            .font(.system(size: 15, weight: .semibold))
            .foregroundStyle(tint)
            .frame(width: 34, height: 34)
            .background(Circle().fill(Theme.Palette.surfaceElevated))
    }

    /// One inbox: its mark, its name, a red dot when something in it is
    /// unread, its count, and a tick when it is the one open.
    private func row(
        label: String,
        selected: Bool,
        count: Int?,
        unread: Int,
        @ViewBuilder mark: () -> some View,
        action: @escaping () -> Void
    ) -> some View {
        Button {
            dismiss()
            action()
        } label: {
            HStack(spacing: Theme.Space.md) {
                mark()
                Text(label)
                    .font(.app(.body, selected ? .semibold : .regular))
                    .foregroundStyle(Theme.Palette.label)
                    .lineLimit(1)
                if unread > 0 {
                    Circle()
                        .fill(Theme.Palette.danger)
                        .frame(width: 7, height: 7)
                }
                Spacer(minLength: Theme.Space.sm)
                if let count, count > 0 {
                    Text(Format.number(count, language: language))
                        .font(.app(.footnote, .semibold))
                        .foregroundStyle(Theme.Palette.labelSecondary)
                }
                if selected {
                    Image(systemName: "checkmark")
                        .font(.system(size: 14, weight: .bold))
                        .foregroundStyle(Theme.Palette.brand)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityValue(
            unread > 0
                ? Str.tabUnread(language).filling("count", with: Format.number(unread, language: language))
                : ""
        )
        .accessibilityAddTraits(selected ? [.isButton, .isSelected] : .isButton)
    }
}
