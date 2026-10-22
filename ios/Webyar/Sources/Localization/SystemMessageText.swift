import Foundation

/// One place that turns a system notice into text the reader can understand.
///
/// This is the app's half of `shared/systemMessageText.ts`, and it exists for
/// the same reason that file does: the server writes system message bodies in
/// English and freezes them into the row at insert time, so the stored body
/// can never follow the reader's language. `Call ended by operator · 00:39`
/// is what is in the database whoever is looking at it.
///
/// Every surface that shows one therefore has to rebuild the sentence from
/// `metadata`. The web console learned that the hard way — four surfaces each
/// knowing a different subset of kinds, so the thread said one thing and the
/// list beside it said another — which is why the copy here is taken key for
/// key from `src/i18n/locales` rather than written afresh.
enum SystemMessage {

    /// Localized text for a system notice, or `nil` when the kind is unknown —
    /// in which case the caller falls back to the stored body rather than
    /// showing nothing. A kind added server-side after this build shipped
    /// still reads as an English sentence, which beats an empty row.
    static func text(_ meta: [String: JSONValue]?, language: Language) -> String? {
        guard let kind = meta?["kind"]?.stringValue, !kind.isEmpty else { return nil }

        func value(_ key: String) -> String {
            (meta?[key]?.stringValue ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        }

        /// A person's name, or "" for none. The English stand-ins the server
        /// once stored as a name ('a colleague') count as none, so the reader
        /// gets the generic sentence in their own language.
        func person(_ raw: String) -> String {
            let name = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            return placeholderNames.contains(name.lowercased()) ? "" : name
        }

        switch kind {
        case "conversation_transferred":
            let actor = person(value("actor_name"))
            let to = person(value("to_name"))
            if to.isEmpty { return Str.sysTransferredGeneric(language) }
            return actor.isEmpty
                ? Str.sysTransferredTo(language, to: to)
                : Str.sysTransferred(language, actor: actor, to: to)

        case "conversation_unassigned":
            let actor = person(value("actor_name"))
            return actor.isEmpty
                ? Str.sysUnassignedGeneric(language)
                : Str.sysUnassigned(language, actor: actor)

        case "routing_agent_joined":
            let name = person(value("agent_name"))
            return name.isEmpty
                ? Str.sysAgentJoinedGeneric(language)
                : Str.sysAgentJoined(language, name: name)

        case "conversation_closed":
            // The visitor-visible line an operator's close writes.
            let name = person(value("agent_name"))
            return name.isEmpty ? Str.sysClosed(language) : Str.sysClosedBy(language, name: name)

        case "routing_no_agent_available":
            return Str.sysNoAgentAvailable(language)

        case "routing_in_queue":
            // Everyone at capacity (auto routing), or the manual queue.
            return value("reason") == "all_busy" ? Str.sysInQueueAllBusy(language) : Str.sysInQueue(language)

        case "platform_support_requester":
            // The "who is asking" card as one line, where the card is not drawn.
            let name = person(meta?["user"]?["name"]?.stringValue ?? "")
            return name.isEmpty ? RequesterStr.title(language) : "\(RequesterStr.title(language)) · \(name)"

        case "support_rating":
            // Without a whole score from 1 to 5 there is nothing to say; the
            // stored body is better.
            guard let raw = meta?["score"]?.doubleValue, raw == raw.rounded(), (1...5).contains(Int(raw)) else {
                return nil
            }
            let rated = Str.sysSupportRating(language, score: Int(raw))
            let comment = value("comment")
            return comment.isEmpty
                ? rated
                : Str.sysSupportRatingComment(language, rating: rated, comment: comment)

        case "call_invitation":
            let isVideo = value("channel") == "video"
            let op = person(value("operator_name"))
            let text: String
            if op.isEmpty {
                text = isVideo ? Str.sysCallInviteVideo(language) : Str.sysCallInviteAudio(language)
            } else {
                text = isVideo
                    ? Str.sysCallInviteVideoFrom(language, op: op)
                    : Str.sysCallInviteAudioFrom(language, op: op)
            }
            let status = value("status").isEmpty ? "pending" : value("status")
            return "\(text) · \(invitationStatus(status, language: language))"

        case "call_ended":
            let seconds = meta?["duration_seconds"]?.intValue ?? 0
            // A call that never connected has no duration worth reporting.
            guard value("end_reason") != "failed", seconds > 0 else {
                return Str.callEndedNotConnected(language)
            }
            let duration = Format.duration(seconds, locale: language.locale)
            switch value("ended_by") {
            case "operator": return Str.callEndedByOperator(language, duration: duration)
            case "visitor": return Str.callEndedByVisitor(language, duration: duration)
            default: return Str.callEndedBySystem(language, duration: duration)
            }

        default:
            return nil
        }
    }

    /// English stand-ins once stored as a name (chatRouting's 'a colleague',
    /// the inbox PATCH's 'An operator') — shared/systemMessages.ts.
    private static let placeholderNames: Set<String> = ["a colleague", "an operator"]

    /// The status word shown beside a call invitation.
    static func invitationStatus(_ status: String, language: Language) -> String {
        switch status {
        case "joined": Str.inviteStatusJoined(language)
        case "expired": Str.inviteStatusExpired(language)
        case "cancelled": Str.inviteStatusCancelled(language)
        case "declined": Str.inviteStatusDeclined(language)
        default: Str.inviteStatusPending(language)
        }
    }

    /// Describe a message whose only content is an attachment.
    ///
    /// Its body is empty, so a list that previews the body alone claims "no
    /// messages yet" about a conversation somebody just sent a photo to.
    ///
    /// The sentence comes from a whole template per case rather than a name
    /// glued onto a verb fragment, for the reason the web file records:
    /// Persian conjugates for the subject, so "you" needs «ارسال کردید» where
    /// a third party needs «ارسال کرد», and the concatenated form produced
    /// «شما: یک تصویر ارسال کرد» — "you: sent a photo" with the wrong person.
    static func attachmentPreview(
        kind: String,
        isMe: Bool,
        name: String?,
        language: Language
    ) -> String {
        if isMe {
            switch kind {
            case "image": return Str.previewYouSentImage(language)
            case "audio": return Str.previewYouSentAudio(language)
            case "video": return Str.previewYouSentVideo(language)
            default: return Str.previewYouSentFile(language)
            }
        }
        // An unidentified visitor still gets a subject — "sent a photo" with
        // no subject reads like a fragment in every language this ships in.
        let trimmed = (name ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let sender = trimmed.isEmpty ? Str.previewSomeone(language) : trimmed
        switch kind {
        case "image": return Str.previewSentByImage(language, name: sender)
        case "audio": return Str.previewSentByAudio(language, name: sender)
        case "video": return Str.previewSentByVideo(language, name: sender)
        default: return Str.previewSentByFile(language, name: sender)
        }
    }
}
