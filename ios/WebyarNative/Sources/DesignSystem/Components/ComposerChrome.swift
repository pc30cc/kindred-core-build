import SwiftUI

/// The shape every composer in the app is drawn in, and the one size its
/// controls are drawn at.
///
/// There were three composers and no two matched. The chat one put its
/// paperclip, emoji and saved-replies buttons OUTSIDE a rounded rectangle and
/// its microphone inside; the mail one was a capsule with nothing but text
/// and a send button; the internal-note one was a capsule with its send
/// button outside it altogether. Three corner radii, two fills, three
/// paddings, and glyphs at 15, 17 and 19 points depending on which side of
/// which field they happened to be on.
///
/// An operator moves between those three in a single conversation. They
/// should be the same object.

// MARK: - The pill

/// The container: one radius, one fill, one border, one inset.
struct ComposerPill: ViewModifier {
    func body(content: Content) -> some View {
        content
            .padding(Theme.Space.xs)
            .background(
                RoundedRectangle(cornerRadius: Theme.Radius.xl, style: .continuous)
                    .fill(Theme.Palette.surface)
            )
            .overlay(
                RoundedRectangle(cornerRadius: Theme.Radius.xl, style: .continuous)
                    .strokeBorder(Theme.Palette.separator.opacity(0.6), lineWidth: 0.5)
            )
            // The whole pill is the tap target. Tapping the padding beside the
            // text used to do nothing at all, which reads as a field that will
            // not open.
            .contentShape(RoundedRectangle(cornerRadius: Theme.Radius.xl, style: .continuous))
    }
}

extension View {
    func composerPill() -> some View { modifier(ComposerPill()) }
}

// MARK: - The controls inside it

/// One auxiliary control in a composer: attach, saved replies, emoji, the
/// microphone, the voice picker, the discard beside a recording.
///
/// Everything except send, which is the one control that is filled and
/// therefore has its own component. These are quiet by design — four tinted
/// circles either side of a text field is a toolbar, not a composer.
struct ComposerGlyph: View {
    let icon: String
    /// Drawn in the brand tint rather than as secondary text. For a control
    /// that is currently doing something — the emoji strip open, a voice
    /// other than the default picked — so that state is visible without
    /// reading a label.
    var isActive = false
    /// A filled backing, for a control that carries a value rather than
    /// performing an action.
    var isTinted = false
    /// Overrides the colour. For the one control in any composer that throws
    /// something away, which has to be red and cannot be the brand tint.
    var tint: Color?

    /// 17pt is the system's own body-symbol size, and the size every control
    /// in this row is now drawn at: the old 15/17/19 spread made the row look
    /// like three different apps' buttons pushed together.
    private static let glyph: CGFloat = 17
    /// Comfortably tappable inside a pill without making the pill tall, and
    /// the box the send button lays out in too, so that everything in the row
    /// shares one baseline. Only hit areas differ from it, and only outwards.
    static let box: CGFloat = 36

    var body: some View {
        Image(systemName: icon)
            // One size whatever the control is carrying. The tinted variant
            // used to shrink to 14pt to stay clear of its own circle, which
            // made the one control that shows a chosen value the smallest
            // thing in the row. The circle gives way instead.
            .font(.system(size: Self.glyph, weight: .regular))
            .foregroundStyle(tint ?? (isActive || isTinted ? Theme.Palette.brand : Theme.Palette.labelSecondary))
            .frame(width: Self.box, height: Self.box)
            .background {
                if isTinted {
                    Circle()
                        .fill(Theme.Palette.brand.opacity(0.12))
                        .padding(1)
                }
            }
            .contentShape(Rectangle())
    }
}

/// A `ComposerGlyph` that does something on tap.
struct ComposerGlyphButton: View {
    let icon: String
    let label: String
    var isActive = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            ComposerGlyph(icon: icon, isActive: isActive)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }
}

// MARK: - The composer with nothing in it but words

/// A field and a send button, in the pill, at the sizes above.
///
/// The mail reply bar and the internal-note sheet are this and nothing else.
/// Each carried its own copy of the row, and they matched only for as long as
/// somebody kept them matching — one had `.textFieldStyle(.plain)` and the
/// other did not, one allowed five lines and the other five, by coincidence.
/// The chat composer is not this type because it has controls to place; it
/// shares the pill and the glyph sizes instead.
struct PlainComposer: View {
    @Binding var text: String
    let placeholder: String
    /// What this sends, spoken, for the send button's accessibility label.
    let sendLabel: String
    let isEnabled: Bool
    var isSending: Bool = false
    @FocusState.Binding var isWriting: Bool
    let onSend: () -> Void

    var body: some View {
        HStack(alignment: .bottom, spacing: 0) {
            TextField(placeholder, text: $text, axis: .vertical)
                .textFieldStyle(.plain)
                .font(.app(.body))
                .lineLimit(1...5)
                .focused($isWriting)
                .padding(.horizontal, Theme.Space.xs)
                // Sized to match the send button beside it, so a one-line
                // draft makes a pill exactly as tall as the chat's.
                .padding(.vertical, Theme.Space.sm - 1)

            SendButton(
                isEnabled: isEnabled,
                isSending: isSending,
                label: sendLabel,
                action: onSend
            )
        }
        .composerPill()
        // The pill's inset is part of the field, as it is in the chat.
        .onTapGesture { isWriting = true }
    }
}
