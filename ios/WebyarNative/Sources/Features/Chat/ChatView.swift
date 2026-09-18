import SwiftUI

struct ChatView: View {
    let conversation: Conversation

    @Environment(AppState.self) private var appState
    @Environment(\.locale) private var locale
    @State private var model: ChatViewModel

    init(conversation: Conversation) {
        self.conversation = conversation
        _model = State(initialValue: ChatViewModel(conversation: conversation))
    }

    private var language: Language { appState.language }

    private var calendar: Calendar {
        var calendar = Calendar.current
        calendar.locale = locale
        return calendar
    }

    private var title: String {
        Format.contactName(
            name: conversation.contact?.name,
            email: conversation.contact?.email,
            visitorCode: conversation.contact?.visitorCode,
            language: language
        )
    }

    var body: some View {
        @Bindable var model = model

        transcript
            .background(Theme.Palette.background)
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            // The composer is a safe-area inset, not a stacked view: that is
            // what makes the transcript scroll *behind* it and what lets the
            // keyboard push it up without covering the last message.
            .safeAreaInset(edge: .bottom, spacing: 0) {
                Composer(
                    text: $model.draft,
                    placeholder: Str.messagePlaceholder(language),
                    sendLabel: Str.send(language),
                    canSend: model.canSend,
                    isSending: model.isSending,
                    onSend: { Task { await model.send(appState: appState) } }
                )
            }
            .task {
                await model.load(appState: appState)
            }
            .alert(
                Str.offlineTitle(language),
                isPresented: Binding(
                    get: { model.sendFailed },
                    set: { if !$0 { model.dismissSendError() } }
                )
            ) {
                Button(Str.cancel(language), role: .cancel) { model.dismissSendError() }
            } message: {
                Text(Str.offlineBody(language))
            }
    }

    @ViewBuilder
    private var transcript: some View {
        switch model.state {
        case .loading:
            ProgressView()
                .frame(maxWidth: .infinity, maxHeight: .infinity)

        case .failed:
            ScrollView {
                ErrorStateView(
                    title: Str.offlineTitle(language),
                    message: Str.offlineBody(language),
                    retryTitle: Str.retry(language),
                    onRetry: { Task { await model.load(appState: appState) } }
                )
            }

        case .loaded:
            let days = model.days(calendar: calendar)
            if days.isEmpty {
                EmptyStateView(
                    systemImage: "bubble.left.and.bubble.right",
                    title: Str.chatEmpty(language),
                    message: ""
                )
                .frame(maxHeight: .infinity)
            } else {
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(spacing: Theme.Space.md) {
                            ForEach(days) { day in
                                Section {
                                    ForEach(day.messages) { message in
                                        MessageBubble(
                                            message: message,
                                            language: language,
                                            locale: locale
                                        )
                                        .id(message.id)
                                    }
                                } header: {
                                    DayHeader(
                                        text: Format.dayHeader(day.id, locale: locale)
                                    )
                                }
                            }

                            // A zero-height anchor is a more reliable scroll
                            // target than the last bubble, whose height is not
                            // known until it lays out.
                            Color.clear
                                .frame(height: 1)
                                .id(Self.bottomAnchor)
                        }
                        .padding(.horizontal, Theme.screenInset)
                        .padding(.vertical, Theme.Space.md)
                    }
                    .scrollDismissesKeyboard(.interactively)
                    .onAppear {
                        proxy.scrollTo(Self.bottomAnchor, anchor: .bottom)
                    }
                    .onChange(of: days.last?.messages.last?.id) {
                        withAnimation(Theme.Motion.bubble) {
                            proxy.scrollTo(Self.bottomAnchor, anchor: .bottom)
                        }
                    }
                }
            }
        }
    }

    private static let bottomAnchor = "chat.bottom"
}

// MARK: - Day header

/// The centred date divider between days of transcript.
struct DayHeader: View {
    let text: String

    var body: some View {
        Text(text)
            .font(Theme.Typo.meta)
            .foregroundStyle(Theme.Palette.labelSecondary)
            .padding(.horizontal, Theme.Space.md)
            .padding(.vertical, Theme.Space.xs)
            .background(Capsule().fill(Theme.Palette.surfaceElevated))
            .frame(maxWidth: .infinity)
            .padding(.vertical, Theme.Space.sm)
    }
}

// MARK: - Bubble

/// One message.
///
/// Outgoing sits against the trailing edge in the brand tint, incoming against
/// the leading edge on a neutral surface — and because "leading" and
/// "trailing" are direction-relative, the whole transcript mirrors correctly
/// in Persian without a single conditional.
struct MessageBubble: View {
    let message: Message
    let language: Language
    let locale: Locale

    private var isOutgoing: Bool { message.senderType.isOutgoing }

    private var bubbleColor: Color {
        isOutgoing ? Theme.Palette.bubbleOutgoing : Theme.Palette.bubbleIncoming
    }

    private var textColor: Color {
        isOutgoing ? Theme.Palette.bubbleOutgoingText : Theme.Palette.bubbleIncomingText
    }

    /// Who sent it, when that is not obvious. An operator's own name is
    /// redundant on their own message; an AI reply is worth labelling.
    private var attribution: String? {
        switch message.senderType {
        case .ai, .bot: Str.aiReply(language)
        case .agent: message.senderName
        case .contact, .system: nil
        }
    }

    var body: some View {
        if message.senderType == .system {
            systemNote
        } else {
            HStack {
                if isOutgoing { Spacer(minLength: Theme.Space.huge) }

                VStack(alignment: isOutgoing ? .trailing : .leading, spacing: Theme.Space.xxs) {
                    if let attribution, !attribution.isEmpty {
                        Text(attribution)
                            .font(Theme.Typo.meta)
                            .foregroundStyle(Theme.Palette.labelSecondary)
                            .padding(.horizontal, Theme.Space.xs)
                    }

                    Text(message.body)
                        .font(Theme.Typo.message)
                        .foregroundStyle(textColor)
                        .multilineTextAlignment(.leading)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.horizontal, Theme.Space.md)
                        .padding(.vertical, Theme.Space.sm + 2)
                        .background(
                            RoundedRectangle(cornerRadius: Theme.Radius.xl, style: .continuous)
                                .fill(bubbleColor)
                        )
                        // Text selection is expected in a transcript — an
                        // operator copies an order number out of it.
                        .textSelection(.enabled)

                    Text(Format.bubbleTime(message.createdAt, locale: locale))
                        .font(.caption2)
                        .foregroundStyle(Theme.Palette.labelTertiary)
                        .padding(.horizontal, Theme.Space.xs)
                }

                if !isOutgoing { Spacer(minLength: Theme.Space.huge) }
            }
            .accessibilityElement(children: .combine)
        }
    }

    /// A state change, not something a person said — so it gets no bubble.
    private var systemNote: some View {
        Text(message.body)
            .font(Theme.Typo.meta)
            .foregroundStyle(Theme.Palette.labelSecondary)
            .multilineTextAlignment(.center)
            .frame(maxWidth: .infinity)
            .padding(.vertical, Theme.Space.xs)
    }
}

// MARK: - Composer

/// The message field and send button.
///
/// The field grows with the text up to a ceiling and then scrolls internally,
/// and the send button is pinned to the bottom of the row so it stays under
/// the thumb as the field grows upward.
struct Composer: View {
    @Binding var text: String
    let placeholder: String
    let sendLabel: String
    let canSend: Bool
    let isSending: Bool
    let onSend: () -> Void

    var body: some View {
        HStack(alignment: .bottom, spacing: Theme.Space.sm) {
            ZStack(alignment: .leading) {
                // TextField's own placeholder disappears under a non-empty
                // axis-vertical field on some iOS versions; drawing it here
                // keeps it reliable.
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
                .background(Circle().fill(Theme.Palette.brand))
                .opacity(canSend ? 1 : 0.4)
            }
            .buttonStyle(.plain)
            .disabled(!canSend)
            .accessibilityLabel(sendLabel)
            .animation(Theme.Motion.standard, value: canSend)
        }
        .padding(.horizontal, Theme.screenInset)
        .padding(.vertical, Theme.Space.sm)
        // `.bar` keeps the composer legible over whatever scrolls beneath it.
        .background(.bar)
    }
}
