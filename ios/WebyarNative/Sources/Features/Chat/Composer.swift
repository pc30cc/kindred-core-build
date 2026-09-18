import SwiftUI

/// The message field, its send button, and whichever extra controls the plan
/// and the conversation's state allow.
///
/// When the AI owns the thread the controls are not merely disabled but
/// replaced by a line saying so. A greyed-out paperclip invites tapping and
/// explains nothing; a sentence explains the state in the place the operator
/// is already looking.
struct Composer: View {
    @Binding var text: String
    let placeholder: String
    let sendLabel: String
    let canSend: Bool
    let isSending: Bool
    let capabilities: ComposerCapabilities
    let language: Language
    /// Shown in place of the controls while the AI is answering.
    let aiNotice: String
    let onSend: () -> Void

    @State private var isShowingEmoji = false

    var body: some View {
        VStack(spacing: Theme.Space.sm) {
            if capabilities.isAIManaged {
                aiBanner
            }

            HStack(alignment: .bottom, spacing: Theme.Space.sm) {
                if capabilities.hasAnyControl {
                    controls
                }

                field

                sendButton
            }

            if isShowingEmoji, capabilities.canUseEmoji {
                EmojiStrip { emoji in
                    text.append(emoji)
                }
                .transition(.opacity.combined(with: .move(edge: .bottom)))
            }
        }
        .padding(.horizontal, Theme.screenInset)
        .padding(.vertical, Theme.Space.sm)
        .background(.bar)
        .animation(Theme.Motion.standard, value: isShowingEmoji)
        .animation(Theme.Motion.standard, value: capabilities)
    }

    /// Says why the composer is plain right now.
    private var aiBanner: some View {
        HStack(spacing: Theme.Space.sm) {
            Image(systemName: "sparkles")
                .font(.caption)
                .foregroundStyle(Theme.Palette.brand)

            Text(aiNotice)
                .font(.caption)
                .foregroundStyle(Theme.Palette.labelSecondary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .multilineTextAlignment(.leading)
        }
        .padding(.horizontal, Theme.Space.md)
        .padding(.vertical, Theme.Space.sm)
        .background(
            RoundedRectangle(cornerRadius: Theme.Radius.md, style: .continuous)
                .fill(Theme.Palette.brand.opacity(0.10))
        )
    }

    private var controls: some View {
        HStack(spacing: Theme.Space.xxs) {
            if capabilities.canAttach {
                ComposerButton(icon: "paperclip", label: Str.attachFile(language)) {
                    // Attachment upload is a larger piece of work than this
                    // screen; the control appears only where the plan allows
                    // it so the placement and gating can be reviewed first.
                }
            }
            if capabilities.canRecordVoice {
                ComposerButton(icon: "mic", label: Str.voiceNote(language)) {}
            }
            if capabilities.canUseEmoji {
                ComposerButton(
                    icon: isShowingEmoji ? "keyboard" : "face.smiling",
                    label: Str.emoji(language)
                ) {
                    isShowingEmoji.toggle()
                }
            }
        }
    }

    private var field: some View {
        ZStack(alignment: .leading) {
            if text.isEmpty {
                Text(placeholder)
                    .font(.body)
                    .foregroundStyle(Theme.Palette.labelTertiary)
                    .padding(.horizontal, Theme.Space.md)
                    .allowsHitTesting(false)
            }

            TextField("", text: $text, axis: .vertical)
                .font(.body)
                .lineLimit(1...6)
                .padding(.horizontal, Theme.Space.md)
                .padding(.vertical, Theme.Space.sm + 2)
        }
        .background(
            RoundedRectangle(cornerRadius: Theme.Radius.xl, style: .continuous)
                .fill(Theme.Palette.surface)
        )
        .overlay(
            RoundedRectangle(cornerRadius: Theme.Radius.xl, style: .continuous)
                .strokeBorder(Theme.Palette.separator.opacity(0.6), lineWidth: 0.5)
        )
    }

    private var sendButton: some View {
        Button(action: onSend) {
            Group {
                if isSending {
                    ProgressView().tint(.white)
                } else {
                    Image(systemName: "arrow.up")
                        .font(.system(size: 17, weight: .bold))
                        .foregroundStyle(.white)
                }
            }
            .frame(width: Theme.Size.minTouchTarget, height: Theme.Size.minTouchTarget)
            .background(Circle().fill(Theme.Palette.brand.opacity(canSend ? 1 : 0.4)))
        }
        .buttonStyle(.plain)
        .disabled(!canSend)
        .accessibilityLabel(sendLabel)
        .animation(Theme.Motion.standard, value: canSend)
    }
}

/// One of the small round controls beside the field.
struct ComposerButton: View {
    let icon: String
    let label: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: icon)
                .font(.system(size: 19))
                .foregroundStyle(Theme.Palette.labelSecondary)
                .frame(width: Theme.Size.minTouchTarget - 6, height: Theme.Size.minTouchTarget)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }
}

/// A compact row of the emoji an operator actually reaches for.
///
/// A full picker is a screen of its own; this covers the handful that appear
/// in support replies and keeps the composer in one place.
struct EmojiStrip: View {
    let onPick: (String) -> Void

    private let emoji = ["👍", "🙏", "😊", "🎉", "✅", "❤️", "😅", "🔥", "👌", "🙌", "😔", "⏳"]

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: Theme.Space.xs) {
                ForEach(emoji, id: \.self) { character in
                    Button {
                        onPick(character)
                    } label: {
                        Text(character)
                            .font(.system(size: 26))
                            .frame(width: Theme.Size.minTouchTarget, height: Theme.Size.minTouchTarget)
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, Theme.Space.xxs)
        }
        // Emoji are not mirrored, and neither is the order they are offered in.
        .environment(\.layoutDirection, .leftToRight)
        .frame(height: Theme.Size.minTouchTarget)
    }
}
