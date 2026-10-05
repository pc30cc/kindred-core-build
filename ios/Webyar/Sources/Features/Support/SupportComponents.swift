import SwiftUI

// The pieces every support screen shares: who the team is and whether it is
// there, and the transcript — the same bubbles as every other conversation in
// the app, the team on the left with their faces, the operator on the right.

enum SupportLook {
    /// Green for a team that is there now, as a presence dot is everywhere.
    static let online = Color(red: 0x1E / 255, green: 0x9E / 255, blue: 0x5A / 255)
    /// The stars of a rating, in the colour stars are.
    static let star = Color(red: 0xF2 / 255, green: 0xA9 / 255, blue: 0)
}

/// A dot and a word: green while the team is there, quiet while it is not.
struct SupportPresenceLine: View {
    let online: Bool
    let language: Language
    var font: Font = .app(.footnote, .medium)

    var body: some View {
        HStack(spacing: Theme.Space.xs) {
            Circle()
                .fill(online ? SupportLook.online : Theme.Palette.labelTertiary)
                .frame(width: 8, height: 8)
            Text(SupportStr.presence(language, online: online))
                .font(font)
                .foregroundStyle(online ? SupportLook.online : Theme.Palette.labelSecondary)
                .lineLimit(1)
        }
        .accessibilityElement(children: .combine)
    }
}

/// The team's face: the support workspace's own logo, as its inbox and its
/// website widget show it — a headset while it has none — with its presence
/// on it.
struct SupportTeamMark: View {
    let online: Bool?
    let avatarURL: String?
    var size: CGFloat = 34

    var body: some View {
        ZStack(alignment: .bottomTrailing) {
            if let avatarURL, !avatarURL.isEmpty {
                Avatar(name: SupportStr.title(.en), imageURL: avatarURL, size: size, subject: .organisation)
            } else {
                Circle()
                    .fill(Theme.Palette.brand.opacity(0.14))
                    .frame(width: size, height: size)
                    .overlay {
                        Image(systemName: "headset")
                            .font(.system(size: size * 0.48, weight: .medium))
                            .foregroundStyle(Theme.Palette.brand)
                    }
            }
            if let online {
                Circle()
                    .fill(online ? SupportLook.online : Theme.Palette.labelTertiary)
                    .frame(width: size * 0.3, height: size * 0.3)
                    .overlay(Circle().stroke(Theme.Palette.background, lineWidth: 2))
            }
        }
        .frame(width: size, height: size)
        .environment(\.layoutDirection, .leftToRight)
        .accessibilityHidden(true)
    }
}

/// A title and a line under it, for a navigation bar.
struct SupportBarTitle: View {
    let title: String
    let subtitle: String?
    var online: Bool?
    var avatarURL: String?
    var showsMark = false
    let language: Language

    var body: some View {
        HStack(spacing: Theme.Space.sm) {
            if showsMark {
                SupportTeamMark(online: online, avatarURL: avatarURL, size: 32)
            }
            VStack(alignment: showsMark ? .leading : .center, spacing: 0) {
                Text(title)
                    .font(.app(.subheadline, .semibold))
                    .foregroundStyle(Theme.Palette.label)
                    .lineLimit(1)
                if let online, showsMark {
                    SupportPresenceLine(online: online, language: language, font: .app(.caption2, .medium))
                } else if let subtitle {
                    Text(subtitle)
                        .font(.app(.caption2))
                        .foregroundStyle(Theme.Palette.labelSecondary)
                        .lineLimit(1)
                }
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
    }
}

// MARK: - Transcript

/// `conversations` as bubbles, each ended one closed by its line and its
/// rating, then what is still on its way: the chat's open conversation, or a
/// closed one read back.
struct SupportTranscript: View {
    let conversations: [SupportConversation]
    let items: [SupportItem]
    let pending: [PendingSupportItem]
    let language: Language
    /// Conversations whose rating is on its way.
    let ratingBusy: Set<String>
    /// What keeps the scroll pinned: a different value is a different chat.
    let scrollKey: String
    let onRetry: (String) -> Void
    let onRate: (String, Int, String?) -> Void

    @Environment(\.locale) private var locale

    private var rows: [SupportRow] {
        supportTimeline(conversations: conversations, items: items, pending: pending, calendar: Format.workingCalendar(locale))
    }

    var body: some View {
        let rows = rows
        PinnedScrollView(conversationKey: scrollKey, revision: revision(rows)) {
            LazyVStack(spacing: Theme.Space.xxs) {
                ForEach(rows) { row in
                    rowView(row)
                }
            }
            .padding(.horizontal, Theme.screenInset)
            .padding(.vertical, Theme.Space.md)
        }
        .accessibilityIdentifier(A11y.supportTranscript)
    }

    @ViewBuilder
    private func rowView(_ row: SupportRow) -> some View {
        switch row.kind {
        case .newConversation(let startedAt):
            SupportNewConversationLine(
                text: SupportStr.newConversation(language, date: startedAt.map { Format.dayHeader($0, locale: locale) })
            )
        case .joined(let name, let dayHeader):
            VStack(spacing: 0) {
                if let dayHeader { DayHeader(text: Format.dayHeader(dayHeader, locale: locale)) }
                SupportCenteredPill(text: SupportStr.joined(language, name: name))
            }
        case .bubble(let bubble):
            VStack(spacing: 0) {
                if let dayHeader = bubble.dayHeader { DayHeader(text: Format.dayHeader(dayHeader, locale: locale)) }
                SupportBubbleRow(bubble: bubble, language: language, onRetry: onRetry)
            }
        case .ended(let conversation):
            SupportEndedLine(conversation: conversation, language: language)
        case .rating(let conversation):
            SupportRatingCard(
                conversation: conversation,
                isBusy: ratingBusy.contains(conversation.id),
                language: language,
                onRate: { score, comment in onRate(conversation.id, score, comment) }
            )
            .padding(.vertical, Theme.Space.sm)
        }
    }

    /// Enough to notice a new, changed or settled row without depending on
    /// the count alone.
    private func revision(_ rows: [SupportRow]) -> Int {
        var hasher = Hasher()
        hasher.combine(rows.count)
        hasher.combine(rows.last?.id ?? "")
        for row in rows.suffix(3) {
            if case .bubble(let bubble) = row.kind {
                hasher.combine(bubble.pending?.failed)
                hasher.combine(bubble.item?.id)
            }
            if case .rating(let conversation) = row.kind { hasher.combine(conversation.rating?.score) }
        }
        return hasher.finalize()
    }
}

/// One message: the operator's on the right, the team's on the left with the
/// agent's face, in every language — the same physical sides as the other
/// transcripts.
private struct SupportBubbleRow: View {
    let bubble: SupportBubble
    let language: Language
    let onRetry: (String) -> Void

    @Environment(AppState.self) private var appState
    @Environment(\.locale) private var locale

    private var size: CGFloat { Theme.Size.avatarSmall - 4 }
    private var mine: Bool { bubble.mine }
    private var attachments: [MessageAttachment] { bubble.item?.attachments.map(\.messageAttachment) ?? [] }
    /// The agent's name over the first of their run: two people answering in
    /// turn are told apart by more than their faces.
    private var name: String? {
        guard !mine, bubble.startsRun, let name = bubble.item?.senderName, !name.isEmpty else { return nil }
        return name
    }
    private var text: String { bubble.body.trimmingCharacters(in: .whitespacesAndNewlines) }

    var body: some View {
        VStack(alignment: mine ? .trailing : .leading, spacing: Theme.Space.xxs) {
            if let name {
                Text(name)
                    .font(.app(.caption, .semibold))
                    .foregroundStyle(Theme.Palette.brand)
                    .padding(.leading, size + Theme.Space.xs + Theme.Space.sm)
                    .environment(\.layoutDirection, language.layoutDirection)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .environment(\.layoutDirection, .leftToRight)
            }

            HStack(alignment: .bottom, spacing: Theme.Space.xs) {
                if mine { Spacer(minLength: Theme.Space.xl) }
                if !mine { avatarSlot }

                VStack(alignment: mine ? .trailing : .leading, spacing: Theme.Space.xxs) {
                    ForEach(attachments) { attachment in
                        AttachmentView(
                            attachment: attachment,
                            isOutgoing: mine,
                            language: language,
                            hasBeak: text.isEmpty && bubble.endsRun
                        )
                        .environment(\.layoutDirection, language.layoutDirection)
                    }
                    if let file = bubble.pending?.file {
                        SupportPendingFile(upload: file, language: language, hasBeak: bubble.endsRun)
                    }
                    if !text.isEmpty {
                        Text(text)
                            .font(Theme.Typo.message)
                            .foregroundStyle(mine ? Theme.Palette.bubbleOutgoingText : Theme.Palette.bubbleIncomingText)
                            .multilineTextAlignment(.leading)
                            .fixedSize(horizontal: false, vertical: true)
                            .padding(.horizontal, Theme.Space.md)
                            .padding(.vertical, Theme.Space.sm + 2)
                            .environment(\.layoutDirection, language.layoutDirection)
                            .chatBubble(
                                mine ? Theme.Palette.bubbleOutgoing : Theme.Palette.bubbleIncoming,
                                hasBeak: bubble.endsRun,
                                pointsRight: mine
                            )
                            .opacity(bubble.pending == nil ? 1 : 0.75)
                            .textSelection(.enabled)
                    }
                }

                if mine { avatarSlot }
                if !mine { Spacer(minLength: Theme.Space.xl) }
            }

            footer
        }
        .padding(.top, bubble.startsRun ? Theme.Space.xs : 0)
        // The side is physical, so it does not swap when the interface turns around.
        .environment(\.layoutDirection, .leftToRight)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(A11y.messageRow(bubble.item?.id ?? "pending-\(bubble.pending?.clientMessageID ?? "")"))
    }

    /// One face at the foot of a run; the gutter stays either way, so every
    /// bubble in a run starts on the same line.
    private var avatarSlot: some View {
        Group {
            if bubble.endsRun {
                if mine {
                    Avatar(name: appState.session.user?.displayName ?? "—", imageURL: appState.myAvatarURL, size: size)
                } else {
                    Avatar(name: bubble.item?.senderName ?? SupportStr.team(language), imageURL: bubble.item?.senderAvatar, size: size)
                }
            } else {
                Color.clear
            }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }

    /// The time under the last bubble of a run; under one still on its way,
    /// "Sending", or that it did not go and a way to try again.
    @ViewBuilder
    private var footer: some View {
        if let pending = bubble.pending {
            if pending.failed {
                Button {
                    onRetry(pending.clientMessageID)
                } label: {
                    Label(SupportStr.notSent(language), systemImage: "exclamationmark.circle.fill")
                        .font(.app(.caption2, .medium))
                        .foregroundStyle(Theme.Palette.danger)
                }
                .buttonStyle(.plain)
                .padding(.horizontal, size + Theme.Space.sm)
                .environment(\.layoutDirection, language.layoutDirection)
                .accessibilityIdentifier(A11y.supportRetry(pending.clientMessageID))
            } else {
                HStack(spacing: Theme.Space.xxs) {
                    ProgressView().controlSize(.mini)
                    Text(Str.messageSending(language))
                        .font(.app(.caption2))
                        .foregroundStyle(Theme.Palette.labelTertiary)
                }
                .padding(.horizontal, size + Theme.Space.sm)
                .environment(\.layoutDirection, language.layoutDirection)
            }
        } else if bubble.endsRun, let time = bubble.time {
            Text(Format.bubbleTime(time, locale: locale))
                .font(.app(.caption2))
                .foregroundStyle(Theme.Palette.labelTertiary)
                .padding(.horizontal, size + Theme.Space.sm)
                .environment(\.layoutDirection, language.layoutDirection)
        }
    }
}

/// A file on its way: a photo shows itself from this phone's own bytes, a
/// document is its name and size — nothing to fetch yet.
private struct SupportPendingFile: View {
    let upload: SupportUpload
    let language: Language
    let hasBeak: Bool

    @State private var preview: UIImage?

    var body: some View {
        Group {
            if upload.isImage, let preview {
                Image(uiImage: preview)
                    .resizable()
                    .scaledToFit()
                    .frame(maxWidth: 220, maxHeight: 260)
                    .chatBubbleClip(hasBeak: hasBeak, pointsRight: true)
                    .opacity(0.75)
            } else {
                HStack(spacing: Theme.Space.md) {
                    Image(systemName: upload.isImage ? "photo" : "doc.fill")
                        .font(.system(size: 15))
                        .foregroundStyle(Theme.Palette.bubbleOutgoingText)
                        .frame(width: 32, height: 32)
                        .background(Circle().fill(Theme.Palette.bubbleOutgoingText.opacity(0.14)))
                    VStack(alignment: .leading, spacing: 1) {
                        Text(upload.fileName)
                            .font(Theme.Typo.rowTitle)
                            .foregroundStyle(Theme.Palette.bubbleOutgoingText)
                            .lineLimit(1)
                            .truncationMode(.middle)
                        Text(Format.fileSize(upload.data.count, language: language))
                            .font(.app(.caption2))
                            .foregroundStyle(Theme.Palette.bubbleOutgoingText.opacity(0.7))
                    }
                }
                .padding(.horizontal, Theme.Space.md)
                .padding(.vertical, Theme.Space.sm)
                .frame(maxWidth: 236, alignment: .leading)
                .chatBubble(Theme.Palette.bubbleOutgoing.opacity(0.75), hasBeak: hasBeak, pointsRight: true)
            }
        }
        .task(id: ObjectIdentifier(upload)) {
            guard upload.isImage, preview == nil else { return }
            preview = await AttachmentPreviews.decode(upload.data, maxPixel: CachePolicy.attachmentPreviewPixels)
        }
    }
}

/// «گفتگوی تازه · ‹date›», between one conversation and the next.
private struct SupportNewConversationLine: View {
    let text: String

    var body: some View {
        HStack(spacing: Theme.Space.md) {
            Rectangle().fill(Theme.Palette.separator).frame(height: 0.5)
            Text(text)
                .font(.app(.footnote, .semibold))
                .foregroundStyle(Theme.Palette.brand)
                .lineLimit(1)
                .layoutPriority(1)
            Rectangle().fill(Theme.Palette.separator).frame(height: 0.5)
        }
        .padding(.vertical, Theme.Space.lg)
    }
}

/// A line in the middle of the transcript, in a quiet pill.
private struct SupportCenteredPill: View {
    let text: String

    var body: some View {
        Text(text)
            .font(.app(.caption, .medium))
            .foregroundStyle(Theme.Palette.labelSecondary)
            .multilineTextAlignment(.center)
            .padding(.horizontal, Theme.Space.md)
            .padding(.vertical, Theme.Space.xs)
            .background(Capsule().fill(Theme.Palette.surfaceElevated))
            .frame(maxWidth: .infinity)
            .padding(.vertical, Theme.Space.sm)
    }
}

/// «این گفتگو حل شد · ‹date›», under a conversation that ended.
private struct SupportEndedLine: View {
    let conversation: SupportConversation
    let language: Language

    @Environment(\.locale) private var locale

    var body: some View {
        let sentence = SupportStr.ended(language, status: conversation.status)
        let text = conversation.endedAt.map { "\(sentence) · \(Format.dayHeader($0, locale: locale))" } ?? sentence
        Text(text)
            .font(.app(.footnote))
            .foregroundStyle(Theme.Palette.labelTertiary)
            .multilineTextAlignment(.center)
            .frame(maxWidth: .infinity)
            .padding(.top, Theme.Space.lg)
            .padding(.bottom, Theme.Space.sm)
    }
}

/// Stars for an ended conversation the team answered: five to tap, a comment
/// if the operator has one, and a button. Once rated, what they gave.
struct SupportRatingCard: View {
    let conversation: SupportConversation
    let isBusy: Bool
    let language: Language
    let onRate: (Int, String?) -> Void

    @State private var score = 0
    @State private var comment = ""
    @FocusState private var isWriting: Bool

    var body: some View {
        VStack(spacing: Theme.Space.sm) {
            if let given = conversation.rating {
                VStack(spacing: Theme.Space.sm) {
                    Text(SupportStr.yourRating(language))
                        .font(.app(.subheadline, .semibold))
                    SupportStars(score: given.score, language: language)
                    if let text = given.comment, !text.isEmpty {
                        Text(text)
                            .font(.app(.subheadline))
                            .foregroundStyle(Theme.Palette.labelSecondary)
                            .multilineTextAlignment(.center)
                    }
                }
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier(A11y.supportRatingGiven(conversation.id))
            } else {
                Text(SupportStr.rateTitle(language))
                    .font(.app(.subheadline, .semibold))
                SupportStarPicker(conversationID: conversation.id, score: $score, language: language)
                TextField(SupportStr.rateComment(language), text: $comment, axis: .vertical)
                    .font(.app(.subheadline))
                    .lineLimit(2...4)
                    .focused($isWriting)
                    .padding(.horizontal, Theme.Space.md)
                    .padding(.vertical, Theme.Space.sm)
                    .background(
                        RoundedRectangle(cornerRadius: Theme.Radius.md, style: .continuous)
                            .fill(Theme.Palette.background)
                    )
                    .onChange(of: comment) { _, value in
                        if value.count > SupportLimits.maxComment { comment = String(value.prefix(SupportLimits.maxComment)) }
                    }
                    .accessibilityIdentifier(A11y.supportRatingComment(conversation.id))
                PrimaryButton(title: SupportStr.rateSubmit(language), isLoading: isBusy, isEnabled: score > 0) {
                    isWriting = false
                    onRate(score, comment)
                }
                .accessibilityIdentifier(A11y.supportRatingSubmit(conversation.id))
            }
        }
        .padding(Theme.Space.lg)
        .frame(maxWidth: .infinity)
        .background(
            RoundedRectangle(cornerRadius: Theme.Radius.xl, style: .continuous)
                .fill(Theme.Palette.surface)
        )
        .environment(\.layoutDirection, language.layoutDirection)
    }
}

/// The rating as given, read out once as a whole.
struct SupportStars: View {
    let score: Int
    let language: Language
    var size: CGFloat = 20

    var body: some View {
        HStack(spacing: 2) {
            ForEach(1...5, id: \.self) { star in
                Image(systemName: star <= score ? "star.fill" : "star")
                    .font(.system(size: size))
                    .foregroundStyle(star <= score ? SupportLook.star : Theme.Palette.labelTertiary)
            }
        }
        .environment(\.layoutDirection, .leftToRight)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(SupportStr.stars(language, score))
    }
}

/// Five stars, each a button of its own, named by its count.
private struct SupportStarPicker: View {
    let conversationID: String
    @Binding var score: Int
    let language: Language

    var body: some View {
        HStack(spacing: 0) {
            ForEach(1...5, id: \.self) { star in
                Button {
                    score = star
                } label: {
                    Image(systemName: star <= score ? "star.fill" : "star")
                        .font(.system(size: 28))
                        .foregroundStyle(star <= score ? SupportLook.star : Theme.Palette.labelTertiary)
                        .frame(width: Theme.Size.minTouchTarget, height: Theme.Size.minTouchTarget)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(SupportStr.stars(language, star))
                .accessibilityAddTraits(star == score ? .isSelected : [])
                .accessibilityIdentifier(A11y.supportRatingStar(conversationID, star))
            }
        }
        .environment(\.layoutDirection, .leftToRight)
        .sensoryFeedback(.selection, trigger: score)
    }
}

/// Nobody is online: leave a message. Under it, when the team keeps hours,
/// when it opens next and its week — which folds away, since a keyboard and
/// seven lines of hours do not share a phone screen well.
struct SupportOfflineBanner: View {
    let status: SupportStatus
    let language: Language

    @Environment(\.locale) private var locale
    @State private var isExpanded = true

    private var lines: [String] { status.hours.map { SupportHoursText.lines($0, language: language) } ?? [] }
    private var zone: String? {
        guard let id = status.hours?.timezone, SupportHoursText.zoneDiffers(id) else { return nil }
        return Format.zoneName(id, language: language)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Space.xs) {
            HStack(alignment: .top, spacing: Theme.Space.sm) {
                Image(systemName: "moon.zzz.fill")
                    .font(.app(.subheadline))
                    .foregroundStyle(Theme.Palette.brand)
                Text(SupportStr.offlineBanner(language))
                    .font(.app(.subheadline))
                    .foregroundStyle(Theme.Palette.label)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let at = status.nextOpenAt {
                Text(SupportStr.nextOpen(
                    language,
                    day: Format.comingDay(at, language: language),
                    time: Format.bubbleTime(at, locale: locale)
                ))
                .font(.app(.subheadline, .semibold))
                .foregroundStyle(Theme.Palette.label)
            }
            if !lines.isEmpty {
                Button {
                    withAnimation(Theme.Motion.standard) { isExpanded.toggle() }
                } label: {
                    HStack {
                        Text(SupportStr.hoursTitle(language))
                            .font(.app(.footnote, .semibold))
                        Spacer()
                        Image(systemName: "chevron.down")
                            .font(.app(.caption, .semibold))
                            .rotationEffect(.degrees(isExpanded ? 180 : 0))
                    }
                    .foregroundStyle(Theme.Palette.labelSecondary)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .padding(.top, Theme.Space.xs)
                .accessibilityAddTraits(.isHeader)

                if isExpanded {
                    ForEach(lines, id: \.self) { line in
                        Text(line)
                            .font(.app(.footnote))
                            .foregroundStyle(Theme.Palette.label)
                    }
                    if let zone {
                        Text(SupportStr.timeZone(language, zone))
                            .font(.app(.caption))
                            .foregroundStyle(Theme.Palette.labelSecondary)
                    }
                }
            }
        }
        .padding(Theme.Space.md)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: Theme.Radius.lg, style: .continuous)
                .fill(Theme.Palette.brand.opacity(0.09))
        )
        .padding(.horizontal, Theme.screenInset)
        .padding(.vertical, Theme.Space.sm)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(A11y.supportOfflineBanner)
    }
}

/// Where the composer was, once the conversation has ended: how it ended,
/// that it cannot be continued, and the one way on — a new conversation.
struct SupportEndedPanel: View {
    let conversation: SupportConversation?
    let language: Language
    let onStartNew: () -> Void

    var body: some View {
        let status = conversation?.status == SupportConversation.closed ? SupportConversation.closed : SupportConversation.resolved
        VStack(spacing: Theme.Space.sm) {
            HStack(spacing: Theme.Space.sm) {
                Image(systemName: "checkmark.circle.fill")
                    .foregroundStyle(SupportLook.online)
                Text(SupportStr.ended(language, status: status))
                    .font(.app(.subheadline, .semibold))
                    .accessibilityAddTraits(.isHeader)
            }
            Text(SupportStr.endedPanelBody(language))
                .font(.app(.footnote))
                .foregroundStyle(Theme.Palette.labelSecondary)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
            PrimaryButton(title: SupportStr.startNew(language), action: onStartNew)
                .padding(.top, Theme.Space.xs)
                .accessibilityIdentifier(A11y.supportStartNew)
        }
        .padding(.horizontal, Theme.screenInset)
        .padding(.top, Theme.Space.lg)
        .padding(.bottom, Theme.Space.md)
        .frame(maxWidth: .infinity)
        .background(.bar)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(A11y.supportEndedPanel)
    }
}
