import SwiftUI

struct ChatView: View {
    let conversation: Conversation

    @Environment(AppState.self) private var appState
    @Environment(\.locale) private var locale
    @State private var model: ChatViewModel
    @State private var actions: ConversationActionsModel
    @State private var sheet: ConversationSheet?

    init(conversation: Conversation) {
        self.conversation = conversation
        _model = State(initialValue: ChatViewModel(conversation: conversation))
        _actions = State(initialValue: ConversationActionsModel(conversation: conversation))
    }

    private var language: Language { appState.language }

    private var calendar: Calendar { Format.workingCalendar(locale) }

    private var title: String {
        Format.contactName(
            name: conversation.contact?.name,
            email: conversation.contact?.email,
            visitorCode: conversation.contact?.visitorCode,
            language: language
        )
    }

    /// Which call channels this plan actually offers, read the same way the
    /// web's sidebar card reads them.
    private var channels: CallChannels {
        CallChannels.resolve(appState.entitlements.value)
    }

    private var capabilities: ComposerCapabilities {
        ComposerCapabilities.resolve(
            conversation: conversation,
            entitlements: appState.entitlements.value
        )
    }

    var body: some View {
        @Bindable var model = model

        transcript
            // The call takes the whole screen from the moment the invitation
            // goes out: waiting for the visitor, connecting, talking and the
            // outcome are one continuous thing to the operator, and a banner
            // would make the first two look like nothing was happening.
            //
            // Attached here rather than alongside the conversation sheets
            // because SwiftUI honours one presentation per view — a second
            // one on the same view is silently ignored.
            .fullScreenCover(item: $actions.pendingInvitation) { invitation in
                CallHost(
                    invitation: invitation,
                    contactName: title,
                    contactAvatarURL: conversation.contact?.avatarURL,
                    visitor: model.visitor,
                    language: language,
                    onClose: { actions.pendingInvitation = nil }
                )
            }
            .background(Theme.Palette.background)
            .navigationBarTitleDisplayMode(.inline)
            // A custom principal item rather than `navigationTitle`: the
            // header carries the visitor's avatar, which is what tells an
            // operator at a glance which device and country they are talking
            // to without opening the contact.
            .toolbar {
                ToolbarItem(placement: .principal) {
                    ChatHeader(
                        title: title,
                        avatarURL: conversation.contact?.avatarURL,
                        visitor: model.visitor,
                        aiState: AIState.resolve(conversation),
                        language: language
                    )
                }

                ToolbarItem(placement: .topBarTrailing) {
                    ConversationMenu(
                        model: actions,
                        channels: channels,
                        language: language,
                        sheet: $sheet,
                        onStatus: { status in
                            Task { await actions.setStatus(status, appState: appState) }
                        },
                        onPriority: { priority in
                            Task { await actions.setPriority(priority, appState: appState) }
                        },
                        onInvite: { channel in
                            Task { await actions.invite(channel, appState: appState) }
                        }
                    )
                }
            }
            .sheet(item: $sheet) { which in
                switch which {
                case .transfer:
                    TransferSheet(
                        model: actions,
                        language: language,
                        currentUserID: appState.session.user?.id
                    )
                case .tags:
                    TagsSheet(model: actions, language: language)
                case .notes:
                    NotesSheet(model: actions, language: language, locale: locale)
                }
            }
            // A transcript is a full-screen task.
            .toolbar(.hidden, for: .tabBar)
            .safeAreaInset(edge: .bottom, spacing: 0) {
                Composer(
                    text: $model.draft,
                    placeholder: Str.messagePlaceholder(language),
                    sendLabel: Str.send(language),
                    canSend: model.canSend,
                    isSending: model.isSending,
                    capabilities: capabilities,
                    language: language,
                    aiNotice: Str.aiOwnsThread(language),
                    onSend: { Task { await model.send(appState: appState) } },
                    onAttach: { data, name, mime in
                        Task {
                            await model.sendAttachment(
                                data: data,
                                fileName: name,
                                mimeType: mime,
                                appState: appState
                            )
                        }
                    }
                )
            }
            .task {
                await model.load(appState: appState)
            }
            .task {
                await actions.load(appState: appState)
                #if DEBUG
                // A Debug run can ask to land straight on the call screen, so
                // its phases can be laid out and screenshotted without
                // driving the menu by hand every time.
                //
                // Sample data only, deliberately. Against the real server
                // this would put a genuine call offer in front of a genuine
                // visitor every time somebody took a screenshot, which is not
                // a thing a screenshot should be able to do.
                if Backend.isSample {
                    switch SampleRoute.current {
                    case .call: await actions.invite(.audio, appState: appState)
                    case .videoCall: await actions.invite(.video, appState: appState)
                    default: break
                    }
                }
                #endif
            }
            .alert(
                Str.inviteFailed(language),
                isPresented: $actions.inviteFailed
            ) {
                Button(Str.cancel(language), role: .cancel) {}
            }
            .alert(
                Str.saveFailed(language),
                isPresented: $actions.saveFailed
            ) {
                Button(Str.cancel(language), role: .cancel) {}
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
                        LazyVStack(spacing: Theme.Space.xxs) {
                            ForEach(days) { day in
                                Section {
                                    ForEach(Array(day.messages.enumerated()), id: \.element.id) { index, message in
                                        MessageRow(
                                            message: message,
                                            // An avatar is drawn only on the
                                            // last message of a run, the way
                                            // every chat app does it: repeating
                                            // it beside each line of a
                                            // three-line reply is visual noise.
                                            showsAvatar: Self.endsRun(day.messages, at: index),
                                            contactAvatarURL: conversation.contact?.avatarURL,
                                            contactName: title,
                                            visitor: model.visitor,
                                            language: language,
                                            locale: locale
                                        )
                                        .id(message.id)
                                    }
                                } header: {
                                    DayHeader(text: Format.dayHeader(day.id, locale: locale))
                                }
                            }

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

    /// Whether this message is the last of a consecutive run from the same
    /// sender — the one that gets the avatar and the timestamp.
    private static func endsRun(_ messages: [Message], at index: Int) -> Bool {
        guard index + 1 < messages.count else { return true }
        return messages[index + 1].senderType != messages[index].senderType
    }

    private static let bottomAnchor = "chat.bottom"
}

// MARK: - Header

/// The visitor's identity in the navigation bar.
struct ChatHeader: View {
    let title: String
    let avatarURL: String?
    let visitor: VisitorProfile?
    let aiState: AIState?
    let language: Language

    /// Where they are and what they are on, when the server resolved it.
    private var subtitle: String? {
        var parts: [String] = []
        if let city = visitor?.geo?.city, !city.isEmpty { parts.append(city) }
        else if let country = visitor?.geo?.country, !country.isEmpty { parts.append(country) }
        if let os = visitor?.device?.os, !os.isEmpty { parts.append(os) }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    var body: some View {
        HStack(spacing: Theme.Space.sm) {
            Avatar(
                name: title,
                imageURL: avatarURL,
                size: Theme.Size.avatarSmall,
                os: visitor?.device?.os,
                device: visitor?.device?.device,
                countryCode: visitor?.geo?.countryCode
            )

            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: Theme.Space.xs) {
                    Text(title)
                        .font(.subheadline.weight(.semibold))
                        .lineLimit(1)

                    if aiState == .aiManaged {
                        Image(systemName: "sparkles")
                            .font(.caption2)
                            .foregroundStyle(Theme.Palette.brand)
                    }
                }

                if let subtitle {
                    Text(subtitle)
                        .font(.caption2)
                        .foregroundStyle(Theme.Palette.labelSecondary)
                        .lineLimit(1)
                }
            }
        }
        .accessibilityElement(children: .combine)
    }
}

// MARK: - Day header

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

// MARK: - Message row

/// One message plus, on the last of a run, the sender's avatar.
///
/// The avatar is the whole point of this row: an operator scanning a thread
/// needs to tell at a glance which replies came from a colleague and which the
/// AI sent on their behalf, and a name in small grey text does not carry that
/// as fast as a face does.
struct MessageRow: View {
    let message: Message
    let showsAvatar: Bool
    let contactAvatarURL: String?
    let contactName: String
    let visitor: VisitorProfile?
    let language: Language
    let locale: Locale

    private var isOutgoing: Bool { message.senderType.isOutgoing }

    private var isAI: Bool {
        message.senderType == .ai || message.senderType == .bot
    }

    private var senderLabel: String {
        switch message.senderType {
        case .ai, .bot: Str.aiReply(language)
        case .agent: message.senderName ?? ""
        case .contact, .system: contactName
        }
    }

    var body: some View {
        if message.senderType == .system {
            systemNote
        } else {
            HStack(alignment: .bottom, spacing: Theme.Space.sm) {
                if isOutgoing {
                    Spacer(minLength: Theme.Space.xl)
                    bubbleColumn
                    avatarSlot
                } else {
                    avatarSlot
                    bubbleColumn
                    Spacer(minLength: Theme.Space.xl)
                }
            }
            .padding(.vertical, Theme.Space.xxs)
            .accessibilityElement(children: .combine)
        }
    }

    /// Keeps a fixed-width gutter whether or not an avatar is drawn, so every
    /// bubble in a run starts on the same vertical line instead of stepping in
    /// and out.
    @ViewBuilder
    private var avatarSlot: some View {
        Group {
            if showsAvatar {
                if isAI {
                    AIAvatar(size: Theme.Size.avatarSmall - 4)
                } else if isOutgoing {
                    // The operator's own uploaded photo when there is one.
                    Avatar(
                        name: message.senderName ?? "—",
                        imageURL: message.senderAvatar,
                        size: Theme.Size.avatarSmall - 4
                    )
                } else {
                    Avatar(
                        name: contactName,
                        imageURL: contactAvatarURL,
                        size: Theme.Size.avatarSmall - 4,
                        os: visitor?.device?.os,
                        device: visitor?.device?.device,
                        countryCode: visitor?.geo?.countryCode
                    )
                }
            } else {
                Color.clear
            }
        }
        .frame(width: Theme.Size.avatarSmall - 4, height: Theme.Size.avatarSmall - 4)
    }

    private var bubbleColumn: some View {
        VStack(alignment: isOutgoing ? .trailing : .leading, spacing: Theme.Space.xxs) {
            if showsAvatar, !senderLabel.isEmpty, message.senderType != .contact {
                Text(senderLabel)
                    .font(Theme.Typo.meta)
                    .foregroundStyle(Theme.Palette.labelSecondary)
                    .padding(.horizontal, Theme.Space.xs)
            }

            // Files first, then whatever was typed with them. A message can
            // be only files — a photo, a voice note, a document — and its
            // body is then empty, which is why the text bubble is skipped
            // rather than drawn empty. An empty rounded rectangle beside a
            // photo was exactly how this looked before.
            ForEach(message.attachments ?? []) { attachment in
                AttachmentView(
                    attachment: attachment,
                    isOutgoing: isOutgoing,
                    language: language
                )
            }

            if !message.isAttachmentOnly {
                Text(message.body)
                    .font(Theme.Typo.message)
                    .foregroundStyle(isOutgoing ? Theme.Palette.bubbleOutgoingText : Theme.Palette.bubbleIncomingText)
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, Theme.Space.md)
                    .padding(.vertical, Theme.Space.sm + 2)
                    .background(
                        RoundedRectangle(cornerRadius: Theme.Radius.xl, style: .continuous)
                            .fill(isOutgoing ? Theme.Palette.bubbleOutgoing : Theme.Palette.bubbleIncoming)
                    )
                    .textSelection(.enabled)
            }

            if showsAvatar {
                Text(Format.bubbleTime(message.createdAt, locale: locale))
                    .font(.caption2)
                    .foregroundStyle(Theme.Palette.labelTertiary)
                    .padding(.horizontal, Theme.Space.xs)
            }
        }
    }

    private var systemNote: some View {
        // Rebuilt from metadata, not read from the row: the body is the
        // English sentence the server wrote when the notice happened. An
        // unrecognised kind still shows that body rather than nothing.
        Text(SystemMessage.text(message.metadata, language: language) ?? message.body)
            .font(Theme.Typo.meta)
            .foregroundStyle(Theme.Palette.labelSecondary)
            .multilineTextAlignment(.center)
            .frame(maxWidth: .infinity)
            .padding(.vertical, Theme.Space.xs)
    }
}

/// The AI's own mark.
///
/// Deliberately not a letter: an automated reply should never be mistakable
/// for a colleague's, and a distinct glyph reads faster than the word "AI".
struct AIAvatar: View {
    var size: CGFloat = Theme.Size.avatarSmall

    var body: some View {
        ZStack {
            LinearGradient(
                colors: [
                    Color(hue: 262 / 360, saturation: 0.72, brightness: 0.68),
                    Color(hue: 232 / 360, saturation: 0.80, brightness: 0.52),
                ],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
            Image(systemName: "sparkles")
                .font(.system(size: size * 0.46, weight: .medium))
                .foregroundStyle(.white)
        }
        .frame(width: size, height: size)
        .clipShape(Circle())
        .accessibilityHidden(true)
    }
}
