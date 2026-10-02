import Foundation

/// A message or file the operator sent that the server has not confirmed yet.
struct PendingSupportItem: Equatable, Sendable {
    /// Minted once; every attempt carries it, so a retry is the same message.
    let clientMessageID: String
    var body: String
    let createdAt: Date
    /// A file, held until it lands — a retry sends these same bytes.
    var file: SupportUpload?
    var failed = false
    /// The open conversation it was written to; nil for the first message of
    /// a new one. Every attempt names the same one, so a retry never lands
    /// anywhere else.
    let conversationID: String?
}

/// A picked file on its way to the team. A class: two uploads are the same
/// only if they are the same object, never because their bytes match.
final class SupportUpload: Equatable, Sendable {
    let data: Data
    let fileName: String
    let mimeType: String

    init(data: Data, fileName: String, mimeType: String) {
        self.data = data
        self.fileName = fileName
        self.mimeType = mimeType
    }

    var isImage: Bool { mimeType.hasPrefix("image/") }

    static func == (lhs: SupportUpload, rhs: SupportUpload) -> Bool { lhs === rhs }
}

/// One message in the support transcript: the server's `item`, or one still
/// on its way (`pending`).
struct SupportBubble: Equatable, Sendable {
    let item: SupportItem?
    let pending: PendingSupportItem?
    let mine: Bool
    let time: Date?
    let dayHeader: Date?
    var startsRun = false
    var endsRun = false

    /// Who a run belongs to: the operator, or one agent of the team.
    var sender: String { mine ? "me" : "team:\(item?.senderName ?? "")" }

    var body: String { item?.body ?? pending?.body ?? "" }
}

/// One row of the support chat. Worked out once for the whole list, as the
/// other transcripts do: a lazy stack builds rows in an order nobody
/// controls, so a row cannot look at its neighbours while it draws.
struct SupportRow: Identifiable, Equatable, Sendable {
    enum Kind: Equatable, Sendable {
        /// «گفتگوی تازه · ‹date›», before each conversation after the first.
        case newConversation(startedAt: Date?)
        /// «‹name› به گفتگو پیوست».
        case joined(name: String?, dayHeader: Date?)
        case bubble(SupportBubble)
        /// «این گفتگو حل شد · ‹date›», under a conversation that ended.
        case ended(SupportConversation)
        /// The stars to give, or the ones given.
        case rating(SupportConversation)
    }

    let id: String
    var kind: Kind
}

/// The conversations given, in order, each followed by how it ended and its
/// rating, then whatever the operator is still sending. The chat gives the
/// one it shows (or none, on a fresh page); a closed conversation is read
/// back on its own.
///
/// What is on its way to a new conversation sits under its own "new
/// conversation" line, below any ended one and never inside it.
///
/// A day header goes above the first message of each day, as in the other
/// transcripts — except right under a "new conversation" line, which already
/// carries the date. An item whose conversation is not in `conversations`
/// has nothing to be filed under and is left out.
func supportTimeline(
    conversations: [SupportConversation],
    items: [SupportItem],
    pending: [PendingSupportItem],
    calendar: Calendar = .current
) -> [SupportRow] {
    var rows: [SupportRow] = []
    var lastDay: Date?
    func header(_ time: Date?) -> Date? {
        guard let time else { return nil }
        let day = calendar.startOfDay(for: time)
        if day == lastDay { return nil }
        lastDay = day
        return time
    }

    let byConversation = Dictionary(grouping: items, by: \.conversationID)
    for (index, conversation) in conversations.enumerated() {
        if index > 0 {
            rows.append(SupportRow(id: "new-\(conversation.id)", kind: .newConversation(startedAt: conversation.createdAt)))
            if let started = conversation.createdAt { lastDay = calendar.startOfDay(for: started) }
        }
        for item in byConversation[conversation.id] ?? [] {
            if item.isJoin {
                rows.append(SupportRow(id: item.id, kind: .joined(name: item.senderName, dayHeader: header(item.createdAt))))
            } else if !item.body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !item.attachments.isEmpty {
                let bubble = SupportBubble(
                    item: item, pending: nil, mine: !item.fromTeam,
                    time: item.createdAt, dayHeader: header(item.createdAt)
                )
                rows.append(SupportRow(id: item.clientMessageID.map { "c-\($0)" } ?? item.id, kind: .bubble(bubble)))
            }
        }
        if conversation.ended {
            rows.append(SupportRow(id: "ended-\(conversation.id)", kind: .ended(conversation)))
            if conversation.canRate || conversation.rating != nil {
                rows.append(SupportRow(id: "rating-\(conversation.id)", kind: .rating(conversation)))
            }
        }
    }

    // Once the server has it, its own copy is the one shown.
    let delivered = Set(items.compactMap(\.clientMessageID))
    let waiting = pending.filter { !delivered.contains($0.clientMessageID) }
    let toActive = waiting.filter { $0.conversationID != nil }
    let toNew = waiting.filter { $0.conversationID == nil }
    func append(_ entry: PendingSupportItem) {
        let bubble = SupportBubble(
            item: nil, pending: entry, mine: true,
            time: entry.createdAt, dayHeader: header(entry.createdAt)
        )
        // The same key the server's copy will have, so the bubble is not
        // rebuilt the moment it lands.
        rows.append(SupportRow(id: "c-\(entry.clientMessageID)", kind: .bubble(bubble)))
    }
    toActive.forEach(append)
    if !conversations.isEmpty, let first = toNew.first {
        rows.append(SupportRow(id: "new-next", kind: .newConversation(startedAt: first.createdAt)))
        lastDay = calendar.startOfDay(for: first.createdAt)
    }
    toNew.forEach(append)

    // Runs: one sender's messages in a row, unbroken by a day or a line.
    // Ids are the list's identity, and a repeated one confuses it; a row the
    // server sent twice is shown twice rather than that.
    var seen = Set<String>()
    return rows.enumerated().map { index, candidate in
        var row = candidate
        if !seen.insert(row.id).inserted { row = SupportRow(id: "\(row.id)#\(index)", kind: row.kind) }
        guard case .bubble(var bubble) = row.kind else { return row }
        let previous = index > 0 ? rows[index - 1].bubble : nil
        let next = index + 1 < rows.count ? rows[index + 1].bubble : nil
        bubble.startsRun = previous == nil || previous?.sender != bubble.sender || bubble.dayHeader != nil
        bubble.endsRun = next == nil || next?.sender != bubble.sender || next?.dayHeader != nil
        row.kind = .bubble(bubble)
        return row
    }
}

private extension SupportRow {
    var bubble: SupportBubble? {
        if case .bubble(let bubble) = kind { return bubble }
        return nil
    }
}

/// The team's week as the offline banner reads it: days in a row that keep
/// the same hours are one line — «شنبه تا چهارشنبه ۹:۰۰ تا ۱۷:۰۰»,
/// «پنجشنبه ۹:۰۰ تا ۱۳:۰۰», «جمعه تعطیل».
///
/// The times are the support workspace's own wall clock, exactly as it keeps
/// them; `zoneDiffers` says whether that clock needs naming on this phone.
enum SupportHoursText {
    /// The week Saturday first, as `/status` keys it and as the team's workweek runs.
    static let week = ["sat", "sun", "mon", "tue", "wed", "thu", "fri"]

    /// Days in a row with the same hours; no `intervals` is closed.
    struct DayGroup: Equatable, Sendable {
        var first: String
        var last: String
        var intervals: [SupportInterval]
    }

    static func groups(_ hours: SupportHours) -> [DayGroup] {
        var groups: [DayGroup] = []
        for day in week {
            let intervals = (hours.weekly[day] ?? [])
                .filter { !$0.from.isEmpty && !$0.to.isEmpty }
                .sorted { $0.from < $1.from }
            if let last = groups.last, last.intervals == intervals {
                groups[groups.count - 1].last = day
            } else {
                groups.append(DayGroup(first: day, last: day, intervals: intervals))
            }
        }
        // A week with no opening at all says nothing useful as seven closed days.
        return groups.allSatisfy { $0.intervals.isEmpty } ? [] : groups
    }

    /// One line per group, in the reader's digits.
    static func lines(_ hours: SupportHours, language: Language) -> [String] {
        groups(hours).map { group in
            let first = SupportStr.weekday(language, group.first)
            let days = group.first == group.last
                ? first
                : SupportStr.dayRange(language, first, SupportStr.weekday(language, group.last))
            guard !group.intervals.isEmpty else { return SupportStr.closedDays(language, days) }
            let times = group.intervals
                .map {
                    SupportStr.interval(
                        language,
                        Format.openingTime($0.from, language: language),
                        Format.openingTime($0.to, language: language)
                    )
                }
                .joined(separator: language == .fa ? "، " : ", ")
            return SupportStr.hoursLine(language, days: days, times: times)
        }
    }

    /// Whether `timezone` keeps another clock than `device`, and so has to be
    /// named under the hours. An id nobody knows is named as it is.
    static func zoneDiffers(_ timezone: String, device: TimeZone = .current, at date: Date = Date()) -> Bool {
        guard !timezone.isEmpty else { return false }
        guard let zone = TimeZone(identifier: timezone) else { return true }
        return zone.identifier != device.identifier
            && zone.secondsFromGMT(for: date) != device.secondsFromGMT(for: date)
    }
}
