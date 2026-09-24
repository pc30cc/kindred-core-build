import SwiftUI

/// Every inbox this plan grants, in one list the app draws itself.
///
/// This used to be a `Menu` hanging off the screen's title, and it was the
/// one surface in the app that would not take IRANSans. That is not a bug in
/// the app: a SwiftUI `Menu` is rendered by UIKit as a `UIMenu`, outside the
/// app's own view hierarchy, and a `UIAction`'s title is drawn in the system
/// face with no public way to change it. Every custom-typeface app on iOS has
/// system-font menus for the same reason.
///
/// So the menu became a sheet. Three things came with the change and none of
/// them were the point, but all three are better: the rows are in the
/// operator's own typeface, each queue can carry its count — which a menu row
/// has no room for — and a target forty-four points tall beats a menu row on
/// a phone held in one hand.
struct InboxSwitcherSheet: View {

    let filters: [InboxFilter]
    let channels: [ChannelInbox]
    let counts: InboxCounts?
    let language: Language
    /// Which queue is current, when a channel inbox is not.
    let currentFilter: InboxFilter
    let currentChannel: ChannelInbox?
    let showsColleagues: Bool
    let showsEmail: Bool

    let onFilter: (InboxFilter) -> Void
    let onChannel: (ChannelInbox) -> Void
    let onColleagues: () -> Void
    let onEmail: () -> Void

    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                Section {
                    ForEach(filters) { filter in
                        row(
                            title: filter.title(language),
                            icon: filter.icon,
                            count: counts?.count(for: filter),
                            isCurrent: currentChannel == nil && filter == currentFilter
                        ) {
                            onFilter(filter)
                            dismiss()
                        }
                    }
                }

                if !channels.isEmpty {
                    Section(Str.otherInboxes(language)) {
                        ForEach(channels) { channel in
                            row(
                                title: channel.title(language),
                                icon: channel.icon,
                                count: nil,
                                isCurrent: currentChannel == channel
                            ) {
                                onChannel(channel)
                                dismiss()
                            }
                        }
                    }
                }

                if showsColleagues || showsEmail {
                    Section {
                        if showsColleagues {
                            row(
                                title: Str.colleagues(language),
                                icon: "person.2",
                                count: nil,
                                // Its own screen, so it is never "current"
                                // here — the same reason the strip's chip is
                                // never drawn as selected.
                                isCurrent: false
                            ) {
                                onColleagues()
                                dismiss()
                            }
                        }
                        if showsEmail {
                            row(
                                title: Str.emailInbox(language),
                                icon: "envelope",
                                count: nil,
                                isCurrent: false
                            ) {
                                onEmail()
                                dismiss()
                            }
                        }
                    }
                }
            }
            .navigationTitle(Str.tabInbox(language))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button(Str.done(language)) { dismiss() }
                        .font(.app(.body, weight: .semibold))
                }
            }
        }
        // Tall enough for the queues without covering the conversation the
        // operator was looking at, and draggable to full height when a
        // workspace runs enough channels to need it.
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }

    private func row(
        title: String,
        icon: String,
        count: Int?,
        isCurrent: Bool,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            HStack(spacing: Theme.Space.md) {
                Image(systemName: icon)
                    .font(.system(size: 16, weight: .medium))
                    .foregroundStyle(isCurrent ? Theme.Palette.brand : Theme.Palette.labelSecondary)
                    .frame(width: 24)

                Text(title)
                    .font(.app(.body, weight: isCurrent ? .semibold : .regular))
                    .foregroundStyle(Theme.Palette.label)

                Spacer(minLength: Theme.Space.sm)

                if let count, count > 0 {
                    Text(Format.number(count, language: language))
                        .font(Theme.Typo.metaEmphasis)
                        .monospacedDigit()
                        .foregroundStyle(Theme.Palette.labelSecondary)
                }

                // A checkmark rather than a selected row style: a `List`
                // selection would fight the button's own highlight, and the
                // mark is what the menu used to draw here.
                Image(systemName: "checkmark")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(Theme.Palette.brand)
                    .opacity(isCurrent ? 1 : 0)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .frame(minHeight: Theme.Size.minTouchTarget)
        .accessibilityAddTraits(isCurrent ? [.isSelected, .isButton] : .isButton)
    }
}
