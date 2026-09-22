import SwiftUI

struct ChatView: View {
    let conversation: Conversation

    @Environment(AppState.self) private var appState
    @Environment(\.locale) private var locale
    @State private var model: ChatViewModel
    @State private var actions: ConversationActionsModel
    /// The AI's side of the composer on a thread it answers. Owned here so
    /// the chosen voice survives the composer being rebuilt.
    @State private var sayNow: SayNowModel
    /// Whether the composer has the keyboard. Here rather than in the
    /// composer because tapping the transcript has to be able to clear it.
    @FocusState private var isWriting: Bool
    @State private var sheet: ConversationSheet?

    init(conversation: Conversation) {
        self.conversation = conversation
        _model = State(initialValue: ChatViewModel(conversation: conversation))
        _actions = State(initialValue: ConversationActionsModel(conversation: conversation))
        _sayNow = State(initialValue: SayNowModel(conversationID: conversation.id))
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

    /// The saved replies, and what their placeholders resolve against.
    ///
    /// Withheld while the AI owns the thread, for the same reason the
    /// attachment and voice controls are: the operator is steering the AI
    /// there, not writing to the visitor, so a reply addressed to the visitor
    /// would go to the wrong reader.
    private var shortcuts: ShortcutSource? {
        guard !capabilities.isAIManaged else { return nil }
        return ShortcutSource(
            workspaceID: appState.selectedWorkspace?.id,
            context: CannedText.Context(
                contactName: conversation.contact?.name,
                contactEmail: conversation.contact?.email,
                workspaceName: appState.selectedWorkspace?.name,
                agentName: appState.session.user?.displayName,
                agentEmail: appState.session.user?.email
            ),
            onUsed: { id in
                model.recordShortcutUse(id, workspaceID: appState.selectedWorkspace?.id)
            }
        )
    }

    var body: some View {
        @Bindable var model = model

        transcript
            // Tapping the transcript puts the keyboard away. `simultaneous`
            // rather than `onTapGesture` so it rides alongside the taps the
            // rows have of their own — opening a photo, opening a document —
            // instead of swallowing them.
            .simultaneousGesture(TapGesture().onEnded { isWriting = false })
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
            // A banner for the thread that is already on screen would cover
            // the message it is announcing with a copy of it.
            .onAppear { PushController.shared.viewing = conversation.id }
            .onDisappear {
                guard PushController.shared.viewing == conversation.id else { return }
                PushController.shared.viewing = nil
            }
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
                        },
                        // Gone the moment the take-over lands, so the row
                        // cannot be pressed twice on a thread that is already
                        // in this operator's hands.
                        isAIManaged: AIState.resolve(conversation) == .aiManaged && !actions.didTakeOver,
                        onTakeOver: {
                            Task { await actions.takeOver(appState: appState) }
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
                    sayNow: sayNow,
                    isWriting: $isWriting,
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
                    },
                    shortcuts: shortcuts
                )
            }
            .task {
                await model.load(appState: appState)
            }
            .alert(sayNow.notice ?? "", isPresented: Binding(
                get: { sayNow.notice != nil },
                set: { if !$0 { sayNow.notice = nil } }
            )) {
                Button(Str.ok(language), role: .cancel) {
                    sayNow.notice = nil
                    // What the AI just sent belongs in the transcript before
                    // the operator decides what to do next.
                    Task { await model.load(appState: appState) }
                }
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
                Str.takeOverFailed(language),
                isPresented: $actions.takeOverFailed
            ) {
                Button(Str.ok(language), role: .cancel) {}
            }
            .alert(
                Str.takenOver(language),
                isPresented: $actions.takeOverConfirmed
            ) {
                Button(Str.ok(language), role: .cancel) {}
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
                PinnedScrollView(
                    conversationKey: conversation.id,
                    // Not the message count: a thread whose newest message is
                    // replaced — an edit, a delivery receipt — has to re-pin
                    // too, and two conversations can have the same count.
                    revision: revisionOf(days)
                ) {
                    LazyVStack(spacing: Theme.Space.xxs) {
                        ForEach(days) { day in
                            Section {
                                ForEach(Array(day.messages.enumerated()), id: \.element.id) { index, message in
                                    MessageRow(
                                        message: message,
                                        // An avatar is drawn only on the last
                                        // message of a run, the way every chat
                                        // app does it: repeating it beside each
                                        // line of a three-line reply is noise.
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
                    }
                    .padding(.horizontal, Theme.screenInset)
                    .padding(.vertical, Theme.Space.md)
                }
                .scrollDismissesKeyboard(.interactively)
            }
        }
    }

    /// Whether this message is the last of a consecutive run from the same
    /// sender — the one that gets the avatar and the timestamp.
    private static func endsRun(_ messages: [Message], at index: Int) -> Bool {
        guard index + 1 < messages.count else { return true }
        return messages[index + 1].senderType != messages[index].senderType
    }

    /// Changes whenever the transcript does — a message arriving, or the
    /// newest one being replaced. A plain count is not enough: an edit or a
    /// delivery receipt leaves the count alone and still moves the bottom.
    private func revisionOf(_ days: [MessageDay]) -> Int {
        var hasher = Hasher()
        hasher.combine(days.reduce(0) { $0 + $1.messages.count })
        hasher.combine(days.last?.messages.last?.id)
        return hasher.finalize()
    }
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

    var body: some View {
        if message.senderType == .system {
            systemNote
        } else {
            VStack(alignment: isOutgoing ? .trailing : .leading, spacing: Theme.Space.xxs) {
                // The face sits at the foot of the last bubble in a run,
                // whatever that bubble is — a line of text, a photo, a voice
                // note, a document. What made this hard to get right is that
                // the timestamp used to live inside this stack: bottom
                // alignment then lined the avatar up with the bottom of the
                // *timestamp*, pushing the picture below the bubble. It is
                // outside now, so "bottom" means the bubble's bottom.
                HStack(alignment: .bottom, spacing: Theme.Space.xs) {
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

                if showsAvatar { metaLine }
            }
            // Which side a bubble sits on is not a reading-order question, so
            // it does not mirror with the interface. An operator console puts
            // you on the right and the visitor on the left, and it does that
            // in every language — the operator is answering from one side of
            // the conversation all day, and having that side swap because the
            // interface is Persian makes the transcript harder to scan, not
            // easier. The text inside each bubble still reads in its own
            // direction; only the arrangement is fixed.
            .environment(\.layoutDirection, .leftToRight)
            .padding(.vertical, Theme.Space.xxs)
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier(A11y.messageRow(message.id))
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

    /// The bubble and everything stacked under it.
    ///
    /// The row above pins the side; this puts the reader's own direction back
    /// for the contents, so Persian text is still laid out right-to-left
    /// inside a bubble that happens to sit on the left.
    private var bubbleColumn: some View {
        // The column's own alignment stays physical — it inherits the row's
        // pinned left-to-right. Setting the language's direction *here* was
        // the bug behind a voice note captioned "یسبسیب": the caption is the
        // narrower of the two bubbles, `.trailing` resolved to left under
        // Persian, and the operator's own words ended up hugging the middle of
        // the screen instead of the face beside them. Each bubble puts the
        // reader's direction back for its own contents.
        VStack(alignment: isOutgoing ? .trailing : .leading, spacing: Theme.Space.xxs) {
            // Files first, then whatever was typed with them. A message can
            // be only files — a photo, a voice note, a document — and its
            // body is then empty, which is why the text bubble is skipped
            // rather than drawn empty. An empty rounded rectangle beside a
            // photo was exactly how this looked before.
            ForEach(Array(attachments.enumerated()), id: \.element.id) { index, attachment in
                AttachmentView(
                    attachment: attachment,
                    isOutgoing: isOutgoing,
                    language: language,
                    hasBeak: index == beakedAttachment
                )
                .environment(\.layoutDirection, language.layoutDirection)
            }

            if !message.isAttachmentOnly {
                textBubble
            }
        }
    }

    private var attachments: [MessageAttachment] { message.attachments ?? [] }

    /// Which attachment, if any, carries the beak.
    ///
    /// Only the last thing drawn in the last message of a run gets one, and
    /// when the message also has text that last thing is the text.
    private var beakedAttachment: Int {
        guard showsAvatar, message.isAttachmentOnly else { return -1 }
        return attachments.count - 1
    }

    private var textBubble: some View {
        Text(message.body)
            .font(Theme.Typo.message)
            .foregroundStyle(isOutgoing ? Theme.Palette.bubbleOutgoingText : Theme.Palette.bubbleIncomingText)
            .multilineTextAlignment(.leading)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.horizontal, Theme.Space.md)
            .padding(.vertical, Theme.Space.sm + 2)
            // Inside the bubble the words read in their own direction; the
            // bubble's shape and its place in the column do not.
            .environment(\.layoutDirection, language.layoutDirection)
            .chatBubble(
                isOutgoing ? Theme.Palette.bubbleOutgoing : Theme.Palette.bubbleIncoming,
                hasBeak: showsAvatar,
                pointsRight: isOutgoing
            )
            .textSelection(.enabled)
    }

    /// Who answered and when.
    ///
    /// The operator's own name is not here: on a two-party screen it is the
    /// same name over and over, and the face already says it. An automated
    /// reply is the one thing worth marking, and it reads better as a
    /// footnote than as a heading.
    private var metaLine: some View {
        HStack(spacing: Theme.Space.xxs) {
            if isAI {
                Text(Str.aiReply(language))
                Text(verbatim: "·")
            }
            Text(Format.bubbleTime(message.createdAt, locale: locale))
        }
        .font(.caption2)
        .foregroundStyle(Theme.Palette.labelTertiary)
        .padding(.horizontal, Theme.Space.xs)
        // Clears the avatar's gutter so the time sits under the bubble rather
        // than under the picture.
        .padding(isOutgoing ? .trailing : .leading, avatarGutter)
        .environment(\.layoutDirection, language.layoutDirection)
    }

    /// The width the avatar column takes, including the gap after it.
    private var avatarGutter: CGFloat {
        (Theme.Size.avatarSmall - 4) + Theme.Space.xs
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
