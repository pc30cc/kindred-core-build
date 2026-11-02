import SwiftUI

// The call in the chat (owner, 2026-11-02; docs/operations/TEAM_CALLS.md,
// "The call in the chat"): every colleague call leaves one line in the two
// members' team chat, as WhatsApp does. The server writes it, once, when the
// call is over (`TeamChatCall`); this is how the thread draws it and how the
// colleagues list previews it — the same rules as the web panel's
// `src/features/teamCalls/teamCallLog.ts` and Android's call line.

/// The rules a call line is drawn by, as pure functions of the call and of
/// who is looking at it.
enum TeamCallLog {

    /// The line's title, by who is looking (the contract's table):
    ///
    /// | outcome   | caller sees               | callee sees                |
    /// |-----------|---------------------------|----------------------------|
    /// | completed | voice / video + duration  | the same                   |
    /// | missed    | no answer                 | missed voice / video call  |
    /// | cancelled | cancelled                 | missed voice / video call  |
    /// | declined  | declined                  | declined                   |
    /// | failed    | call failed               | call failed                |
    enum Title: Equatable, Sendable {
        case voice, video, missedVoice, missedVideo, noAnswer, declined, cancelled, failed

        func text(_ language: Language) -> String {
            switch self {
            case .voice: Str.teamCallLogVoice(language)
            case .video: Str.teamCallLogVideo(language)
            case .missedVoice: Str.teamCallLogMissedVoice(language)
            case .missedVideo: Str.teamCallLogMissedVideo(language)
            case .noAnswer: Str.teamCallLogNoAnswer(language)
            case .declined: Str.teamCallLogDeclined(language)
            case .cancelled: Str.teamCallLogCancelled(language)
            case .failed: Str.teamCallLogFailed(language)
            }
        }
    }

    /// Whether the member looking placed the call. The line is the caller's
    /// (the server sends it from the caller to the callee, and shows `call`
    /// on no other line), so in a thread with `peerID` the member placed it
    /// exactly when the colleague did not.
    static func viewerIsCaller(_ call: TeamChatCall, peerID: String) -> Bool {
        call.callerID != peerID
    }

    static func title(_ call: TeamChatCall, viewerIsCaller: Bool) -> Title {
        let video = call.channel == .video
        switch call.outcome {
        case .completed:
            return video ? .video : .voice
        case .missed:
            if viewerIsCaller { return .noAnswer }
            return video ? .missedVideo : .missedVoice
        case .cancelled:
            if viewerIsCaller { return .cancelled }
            return video ? .missedVideo : .missedVoice
        case .declined:
            return .declined
        case .failed:
            return .failed
        }
    }

    /// Drawn in the danger colour: a missed call, on either side, and a
    /// cancelled one for the callee — for whom it is a missed call too.
    static func isMissed(_ call: TeamChatCall, viewerIsCaller: Bool) -> Bool {
        call.outcome == .missed || (call.outcome == .cancelled && !viewerIsCaller)
    }

    /// A call's length as the line shows it: `m:ss`, or `h:mm:ss` from an
    /// hour on — minutes (or hours) unpadded, as the server's body and the
    /// web write it — in the reader's own digits (`Format.number`).
    static func duration(_ seconds: Int, locale: Locale) -> String {
        let total = max(0, seconds)
        let hours = total / 3600
        let minutes = (total % 3600) / 60
        let secs = total % 60
        let fields = hours > 0 ? [hours, minutes, secs] : [minutes, secs]
        // Padded with the locale's own zero, never "%02d" and a swap of
        // glyphs afterwards (`Format.clock` says why).
        let zero = Format.number(0, locale: locale)
        return fields.enumerated().map { index, value -> String in
            let text = Format.number(value, locale: locale)
            return index > 0 && value < 10 ? zero + text : text
        }
        .joined(separator: ":")
    }

    /// The duration of a completed call, or nil: any other outcome has none,
    /// and a completed call whose length the server did not know shows none.
    static func duration(of call: TeamChatCall, locale: Locale) -> String? {
        guard call.outcome == .completed, let seconds = call.durationSeconds else { return nil }
        return Self.duration(seconds, locale: locale)
    }

    /// The title with a completed call's duration, as the colleagues list
    /// previews the line: "Voice call · 4:05", "Missed video call".
    static func headline(_ call: TeamChatCall, viewerIsCaller: Bool, language: Language) -> String {
        let title = Self.title(call, viewerIsCaller: viewerIsCaller).text(language)
        guard let duration = Self.duration(of: call, locale: language.locale) else { return title }
        return "\(title) · \(duration)"
    }

    /// The phone, or the video camera.
    static func channelSymbol(_ channel: CallChannel) -> String {
        channel == .video ? "video.fill" : "phone.fill"
    }

    /// Out ↗ for the caller, in ↙ for the callee. Drawn mirrored in a
    /// right-to-left language (`flipsForRightToLeftLayoutDirection`), as the
    /// web mirrors its own.
    static func arrowSymbol(viewerIsCaller: Bool) -> String {
        viewerIsCaller ? "arrow.up.right" : "arrow.down.left"
    }

    /// What the screen reader says for the line: the title (with a completed
    /// call's duration), the direction and the time.
    static func accessibilityLabel(
        _ call: TeamChatCall, viewerIsCaller: Bool, time: String, language: Language
    ) -> String {
        let title = Self.title(call, viewerIsCaller: viewerIsCaller).text(language)
        let direction = viewerIsCaller ? Str.teamCallLogOutgoing(language) : Str.teamCallLogIncoming(language)
        var parts = [title]
        if let duration = Self.duration(of: call, locale: language.locale) { parts.append(duration) }
        parts.append(direction)
        if !time.isEmpty { parts.append(time) }
        return parts.joined(separator: language.listSeparator)
    }
}

/// Calling back from a call line: the thread's own entry (the same as its
/// toolbar's buttons), offered only while the plan allows that kind of call.
struct TeamCallBack {
    /// Another call is on: the line stays where it is and does nothing.
    let isDisabled: Bool
    let perform: () -> Void
}

/// A colleague call's line in the thread, on the caller's side: the phone or
/// video-camera icon, the title, the arrow, the time and — for a completed
/// call — its length. Missed (and cancelled, for the callee) in the danger
/// colour.
///
/// A tap calls back with the same channel when `callBack` is given; without
/// it the line is only a line. It is never replied to, quoted, copied or
/// forwarded: no menu, no text selection, and its body — the older apps'
/// fallback — is never drawn.
struct TeamCallLogBubble: View {
    let call: TeamChatCall
    /// The member looking placed the call (`TeamCallLog.viewerIsCaller`).
    let viewerIsCaller: Bool
    /// The bubble's side: ours on the right, the colleague's on the left.
    let isOutgoing: Bool
    /// When the call rang, as the transcript writes a time.
    let time: String
    let language: Language
    let callBack: TeamCallBack?

    /// The icon's disc grows with the text beside it.
    @ScaledMetric(relativeTo: .body) private var disc: CGFloat = 36

    private var missed: Bool { TeamCallLog.isMissed(call, viewerIsCaller: viewerIsCaller) }
    private var title: String { TeamCallLog.title(call, viewerIsCaller: viewerIsCaller).text(language) }
    private var duration: String? { TeamCallLog.duration(of: call, locale: language.locale) }

    /// Not the solid brand fill of a sent message: the danger colour has to
    /// read on the caller's own line too, so ours is the brand's tint, the
    /// colleague's the ordinary incoming bubble — in light and dark alike.
    private var fill: Color {
        isOutgoing ? Theme.Palette.brand.opacity(0.14) : Theme.Palette.bubbleIncoming
    }

    private var label: String {
        TeamCallLog.accessibilityLabel(call, viewerIsCaller: viewerIsCaller, time: time, language: language)
    }

    var body: some View {
        if let callBack {
            Button(action: callBack.perform) { content }
                .buttonStyle(.plain)
                .disabled(callBack.isDisabled)
                .opacity(callBack.isDisabled ? 0.6 : 1)
                .accessibilityLabel(label)
                .accessibilityAction(named: Text(Str.teamCallLogCallBack(language))) {
                    guard !callBack.isDisabled else { return }
                    callBack.perform()
                }
                .accessibilityIdentifier(A11y.teamCallLog(call.id))
        } else {
            content
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(label)
                .accessibilityIdentifier(A11y.teamCallLog(call.id))
        }
    }

    private var content: some View {
        HStack(spacing: Theme.Space.sm) {
            Image(systemName: TeamCallLog.channelSymbol(call.channel))
                .font(.app(.subheadline, .semibold))
                .foregroundStyle(missed ? Theme.Palette.danger : Theme.Palette.brand)
                .frame(width: disc, height: disc)
                .background(
                    Circle().fill((missed ? Theme.Palette.danger : Theme.Palette.brand).opacity(0.14))
                )

            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.app(.subheadline, .semibold))
                    .foregroundStyle(missed ? Theme.Palette.danger : Theme.Palette.label)
                    .fixedSize(horizontal: false, vertical: true)

                HStack(spacing: Theme.Space.xs) {
                    Image(systemName: TeamCallLog.arrowSymbol(viewerIsCaller: viewerIsCaller))
                        .font(.app(.caption2, .semibold))
                        .foregroundStyle(missed ? Theme.Palette.danger : Theme.Palette.labelSecondary)
                        .flipsForRightToLeftLayoutDirection(true)
                    Text(time)
                        .font(.app(.caption))
                        .monospacedDigit()
                    if let duration {
                        Text(verbatim: "·")
                            .font(.app(.caption))
                        Text(duration)
                            .font(.app(.caption))
                            .monospacedDigit()
                    }
                }
                .foregroundStyle(Theme.Palette.labelSecondary)
            }
        }
        .multilineTextAlignment(.leading)
        .padding(.horizontal, Theme.Space.md)
        .padding(.vertical, Theme.Space.sm)
        .frame(minWidth: 150, alignment: .leading)
        // The words in the reader's direction; the bubble's side and beak
        // stay physical (`chatBubble`).
        .environment(\.layoutDirection, language.layoutDirection)
        .chatBubble(fill, hasBeak: true, pointsRight: isOutgoing)
        .contentShape(Rectangle())
    }
}

/// The colleagues list's preview of a call line: its icon and its title
/// (with a completed call's duration), never its body.
struct TeamCallLogPreview: View {
    let call: TeamChatCall
    let viewerIsCaller: Bool
    let language: Language

    var body: some View {
        let missed = TeamCallLog.isMissed(call, viewerIsCaller: viewerIsCaller)
        HStack(spacing: Theme.Space.xs) {
            Image(systemName: TeamCallLog.channelSymbol(call.channel))
                .font(.app(.caption))
                .accessibilityHidden(true)
            Text(TeamCallLog.headline(call, viewerIsCaller: viewerIsCaller, language: language))
                .lineLimit(1)
        }
        .font(Theme.Typo.rowSubtitle)
        .foregroundStyle(missed ? Theme.Palette.danger : Theme.Palette.labelSecondary)
    }
}
