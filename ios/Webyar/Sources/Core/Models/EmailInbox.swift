import Foundation

// The Email Inbox is a real mailbox — Gmail or Yahoo — and is deliberately a
// different surface from the chat inbox, right down to its own API prefix
// (`/api/email-inbox`, not `/api/email`). These types mirror
// `src/lib/emailInbox-api.ts` field for field, and the server already speaks
// camelCase here, so almost none of them need coding keys. The same shapes
// as the Android app's `EmailInbox.kt`.

struct EmailAddress: Codable, Hashable, Sendable {
    let email: String
}

struct EmailThreadSummary: Codable, Identifiable, Hashable, Sendable {
    let id: String
    var provider: String?
    var subject: String?
    var participants: [EmailAddress]?
    var lastMessageAt: Date?
    var isRead: Bool?
    var isStarred: Bool?
    var labels: [String]?
    var lastMessageSnippet: String?
    /// The mailbox's cursor for this thread; it moves on every change, labels included.
    var historyId: String?
    var messageCount: Int?

    init(
        id: String, provider: String? = nil, subject: String? = nil, participants: [EmailAddress]? = nil,
        lastMessageAt: Date? = nil, isRead: Bool? = nil, isStarred: Bool? = nil, labels: [String]? = nil,
        lastMessageSnippet: String? = nil, historyId: String? = nil, messageCount: Int? = nil
    ) {
        self.id = id
        self.provider = provider
        self.subject = subject
        self.participants = participants
        self.lastMessageAt = lastMessageAt
        self.isRead = isRead
        self.isStarred = isStarred
        self.labels = labels
        self.lastMessageSnippet = lastMessageSnippet
        self.historyId = historyId
        self.messageCount = messageCount
    }

    /// What the thread's CONTENT is at: its message count and the time of
    /// its last message, which is how the web keys its body cache. The
    /// history id would also change on a read or a star, and those do not
    /// change what the thread says.
    var version: String {
        let count = messageCount.map(String.init) ?? "-"
        let last = lastMessageAt.map { String($0.timeIntervalSince1970) } ?? "-"
        return "\(count)|\(last)"
    }

    /// Who the row is about: everyone on the thread except, where we can
    /// tell, the mailbox itself. The full list when excluding the mailbox
    /// would leave nothing — a note to yourself is still from somebody.
    func people(excluding mailbox: String?) -> String {
        let all = (participants ?? []).map(\.email)
        let others = mailbox.map { own in all.filter { !EmailAddressing.same($0, own) } } ?? all
        return (others.isEmpty ? all : others).joined(separator: ", ")
    }
}

struct EmailAttachmentView: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let filename: String?
    let contentType: String?
    let sizeBytes: Int?
    let contentId: String?
    let url: String?
}

struct EmailMessageView: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let externalMessageId: String?
    let direction: String?
    let fromAddress: String?
    let toAddresses: [EmailAddress]?
    let ccAddresses: [EmailAddress]?
    let textBody: String?
    let htmlBody: String?
    let snippet: String?
    let isRead: Bool?
    let deliveryStatus: String?
    let deliveryError: String?
    let sentAt: Date?
    let attachments: [EmailAttachmentView]?

    var isOutbound: Bool { direction == "outbound" }

    /// The words of the mail: the plain-text part when there is one,
    /// otherwise the HTML's words, otherwise the snippet. What a forward
    /// quotes.
    var displayBody: String {
        if let text = textBody?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty { return text }
        if let html = htmlBody, !html.isEmpty { return EmailBody.plainText(from: html) }
        return snippet ?? ""
    }
}

struct EmailThreadResponse: Decodable, Hashable, Sendable {
    let thread: EmailThreadSummary
    let messages: [EmailMessageView]

    init(thread: EmailThreadSummary, messages: [EmailMessageView]) {
        self.thread = thread
        self.messages = messages
    }

    private enum CodingKeys: String, CodingKey { case thread, messages }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        thread = try c.decode(EmailThreadSummary.self, forKey: .thread)
        messages = (try? c.decodeIfPresent([EmailMessageView].self, forKey: .messages)) ?? []
    }
}

struct EmailThreadsResponse: Decodable, Sendable {
    var threads: [EmailThreadSummary] = []
    var nextBefore: String?
    /// The mailbox's change cursor as of this page (Gmail's `historyId`),
    /// handed back to `/changes` to learn what moved since. Absent for a
    /// mailbox the server polls instead (Yahoo).
    var historyId: String?

    init(threads: [EmailThreadSummary] = [], nextBefore: String? = nil, historyId: String? = nil) {
        self.threads = threads
        self.nextBefore = nextBefore
        self.historyId = historyId
    }

    private enum CodingKeys: String, CodingKey { case threads, nextBefore, historyId }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        threads = (try? c.decodeIfPresent([EmailThreadSummary].self, forKey: .threads)) ?? []
        nextBefore = try? c.decodeIfPresent(String.self, forKey: .nextBefore)
        historyId = try? c.decodeIfPresent(String.self, forKey: .historyId)
    }
}

/// One connected mailbox of the workspace — a Gmail and a Yahoo can both be
/// connected — with how many of its inbox threads are unread.
///
/// `provider` is also what every `/api/email-inbox` call takes as
/// `?provider=` to mean this mailbox rather than the default one.
struct EmailMailbox: Decodable, Hashable, Sendable {
    let provider: String
    var address: String?
    var status: String?
    /// Unread threads in the inbox; nil when the provider could not say just now.
    var unread: Int?
}

struct EmailMailboxesResponse: Decodable, Sendable {
    let mailboxes: [EmailMailbox]?
}

/// What changed in a mailbox since a cursor (`GET /changes?since=`).
///
/// Ids only, never content. `contentThreadIds` are the threads whose
/// messages changed — the only ones whose body a reader must fetch again;
/// the rest changed a label. `reset` means the cursor is too old to answer
/// from (or the provider has no cursors at all): reload the first page.
struct EmailChanges: Decodable, Sendable, Equatable {
    var historyId: String?
    var threadIds: [String] = []
    var contentThreadIds: [String]?
    var reset = false

    init(historyId: String? = nil, threadIds: [String] = [], contentThreadIds: [String]? = nil, reset: Bool = false) {
        self.historyId = historyId
        self.threadIds = threadIds
        self.contentThreadIds = contentThreadIds
        self.reset = reset
    }

    private enum CodingKeys: String, CodingKey { case historyId, threadIds, contentThreadIds, reset }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        historyId = try? c.decodeIfPresent(String.self, forKey: .historyId)
        threadIds = (try? c.decodeIfPresent([String].self, forKey: .threadIds)) ?? []
        contentThreadIds = try? c.decodeIfPresent([String].self, forKey: .contentThreadIds)
        reset = (try? c.decodeIfPresent(Bool.self, forKey: .reset)) ?? false
    }
}

/// One entry of a mailbox's folder menu (`GET /folders`): a system folder
/// (`inbox`, `starred`, `important`, `sent`, `drafts`, `all`, `spam`, `trash`)
/// or one of the mailbox's labels (`label:<id>`, named by `name`). Counts
/// only: `unread` where a mail client shows it (Inbox, Spam, labels), `total`
/// for Drafts.
struct EmailMailFolder: Decodable, Hashable, Identifiable, Sendable {
    static let inbox = "inbox"
    /// What a server from before `/folders` has: the inbox.
    static let fallback = [EmailMailFolder(id: inbox)]

    let id: String
    var kind = "system"
    var name: String?
    var unread: Int?
    var total: Int?

    var isLabel: Bool { kind == "label" || id.hasPrefix("label:") }

    /// Unread where a mail client shows it; for Drafts, how many there are.
    var count: Int? {
        let value = id == "drafts" ? total : unread
        return value.flatMap { $0 > 0 ? $0 : nil }
    }

    init(id: String, kind: String = "system", name: String? = nil, unread: Int? = nil, total: Int? = nil) {
        self.id = id
        self.kind = kind
        self.name = name
        self.unread = unread
        self.total = total
    }

    private enum CodingKeys: String, CodingKey { case id, kind, name, unread, total }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        kind = (try? c.decodeIfPresent(String.self, forKey: .kind)) ?? "system"
        name = try? c.decodeIfPresent(String.self, forKey: .name)
        unread = try? c.decodeIfPresent(Int.self, forKey: .unread)
        total = try? c.decodeIfPresent(Int.self, forKey: .total)
    }
}

struct EmailFoldersResponse: Decodable, Sendable {
    let folders: [EmailMailFolder]?
}

/// The list's three filters inside the folder on screen: everything, what is
/// unread, what is starred.
enum EmailListFilter: String, CaseIterable, Hashable, Sendable {
    case all, unread, starred

    /// The list endpoint's own switches (`unread=true`, `starred=true`).
    var query: [URLQueryItem] {
        switch self {
        case .all: []
        case .unread: [URLQueryItem(name: "unread", value: "true")]
        case .starred: [URLQueryItem(name: "starred", value: "true")]
        }
    }
}

/// A file uploaded ahead of a send. `POST /api/email-inbox/:ws/attachments`
/// answers with this and `/send` takes it back; the row is only written once
/// the message it belongs to exists.
struct StagedEmailAttachment: Codable, Hashable, Sendable {
    let storageKey: String
    let filename: String
    let contentType: String
    let sizeBytes: Int
}

/// Everything a sent mail is made of. `threadID` nil starts a new thread.
struct EmailDraft: Hashable, Sendable {
    var threadID: String?
    var to: [String]
    var cc: [String] = []
    var bcc: [String] = []
    var subject: String
    var body: String
    var attachments: [StagedEmailAttachment] = []
}

/// The connected mailbox, from before `/mailboxes`: what a server that does
/// not know it is asked instead.
struct GmailConnection: Codable, Sendable {
    let connected: Bool?
    let emailAddress: String?
    let status: String?
}

struct GmailConnectionResponse: Decodable, Sendable {
    let connection: GmailConnection?
    let platformConfigured: Bool?
}

/// The mailbox's endpoints. Every backend the app runs against answers them
/// (`WebyarAPI` refines this); the mailbox's screens ask for nothing more.
protocol EmailAPI: Sendable {
    /// One page of a folder's threads; `before` is the previous page's `nextBefore`.
    func emailThreadsPage(
        workspaceID: String, filter: EmailListFilter, before: String?, mailbox: String?, folder: String?
    ) async throws -> EmailThreadsResponse
    func emailThread(workspaceID: String, threadID: String, mailbox: String?, folder: String?) async throws -> EmailThreadResponse
    func setEmailThreadRead(workspaceID: String, threadID: String, isRead: Bool, mailbox: String?) async throws
    func setEmailThreadStarred(workspaceID: String, threadID: String, starred: Bool, mailbox: String?) async throws
    func sendEmailDraft(workspaceID: String, draft: EmailDraft, mailbox: String?) async throws
    func stageEmailAttachment(
        workspaceID: String, data: Data, filename: String, contentType: String, mailbox: String?
    ) async throws -> StagedEmailAttachment
    func emailAttachmentData(workspaceID: String, attachmentID: String, mailbox: String?) async throws -> Data
    /// The workspace's connected mailboxes and their unread counts.
    func emailMailboxes(workspaceID: String) async throws -> [EmailMailbox]
    /// A mailbox's folder menu; `[inbox]` from a server that has none.
    func emailFolders(workspaceID: String, mailbox: String?) async throws -> [EmailMailFolder]
    func emailChanges(workspaceID: String, since: String, mailbox: String?) async throws -> EmailChanges
}

/// A mailbox changed: the inbox channel's `email_mailbox_changed`, or an email
/// push. Ids only; the screens read what they show again.
struct EmailSignal: Equatable, Sendable {
    let workspaceID: String
    /// `gmail`, `yahoo`; nil when the signal did not say (any of them).
    let provider: String?
}

/// `"Sara Karimi" <sara@x.com>` as its two halves; a bare address has no name.
struct MailName: Equatable, Sendable {
    let name: String?
    let email: String

    var display: String { name ?? email }

    static func parse(_ raw: String?) -> MailName {
        let value = (raw ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard let open = value.lastIndex(of: "<"), value.hasSuffix(">") else { return MailName(name: nil, email: value) }
        let email = String(value[value.index(after: open)..<value.index(before: value.endIndex)])
            .trimmingCharacters(in: .whitespaces)
        var name = String(value[..<open]).trimmingCharacters(in: .whitespaces)
        if name.hasPrefix("\""), name.hasSuffix("\""), name.count >= 2 {
            name = String(name.dropFirst().dropLast()).trimmingCharacters(in: .whitespaces)
        }
        return MailName(name: name.isEmpty ? nil : name, email: email)
    }
}

/// Addresses as people type them and as mail headers write them.
enum EmailAddressing {
    private static let pattern = try! NSRegularExpression(pattern: "^[^@\\s,;<>]+@[^@\\s,;<>]+\\.[^@\\s,;<>]+$")

    /// Entries separated by commas, semicolons and line breaks — but not
    /// inside quotes or angle brackets, because Gmail hands senders back as
    /// `"Ahmadi, Sara" <sara@example.com>` and a comma in a display name is
    /// not the end of an address. An entry with `<…>` is the address inside
    /// it; an entry without one is bare addresses, which people also separate
    /// with spaces. Duplicates go regardless of case.
    static func list(_ text: String) -> [String] {
        var out: [String] = []
        var entry = ""
        var quoted = false
        var bracketed = false
        func flush() {
            let value = entry
            entry = ""
            if value.contains("<") {
                out.append(address(value))
            } else {
                out += value.split(whereSeparator: { $0.isWhitespace || $0 == "," || $0 == ";" }).map(String.init)
            }
        }
        for c in text {
            switch c {
            case "\"" where !bracketed:
                quoted.toggle()
                entry.append(c)
            case "<" where !quoted:
                bracketed = true
                entry.append(c)
            case ">" where !quoted:
                bracketed = false
                entry.append(c)
            case ",", ";", "\n":
                // Inside a quoted name or an angle-bracketed address it is
                // part of the entry, not the end of it.
                if quoted || bracketed { entry.append(c) } else { flush() }
            default:
                entry.append(c)
            }
        }
        flush()
        var seen = Set<String>()
        return out
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty && seen.insert($0.lowercased()).inserted }
    }

    /// One address as a header writes it: `Sara <sara@x.com>` is `sara@x.com`.
    static func address(_ value: String) -> String {
        guard let open = value.lastIndex(of: "<") else { return value.trimmingCharacters(in: .whitespacesAndNewlines) }
        let rest = value[value.index(after: open)...]
        let inside = rest.firstIndex(of: ">").map { rest[..<$0] } ?? rest
        return String(inside).trimmingCharacters(in: .whitespaces)
    }

    /// The same mailbox, whatever name or case either side is written with.
    static func same(_ a: String, _ b: String) -> Bool {
        address(a).caseInsensitiveCompare(address(b)) == .orderedSame
    }

    static func isValid(_ value: String) -> Bool {
        pattern.firstMatch(in: value, range: NSRange(value.startIndex..., in: value)) != nil
    }
}

/// Turns an HTML mail into something readable as plain text, and splits a
/// plain-text mail from the trail it quotes.
///
/// Not a parser and not trying to be: it drops the parts that are never
/// content, unwraps the tags, and puts back the entities that appear in
/// almost every message.
enum EmailBody {
    /// The named entities worth spelling out, and NOT `&amp;` — see below.
    private static let entities: [(String, String)] = [
        ("&nbsp;", " "), ("&lt;", "<"), ("&gt;", ">"),
        ("&quot;", "\""), ("&apos;", "'"), ("&zwnj;", "\u{200C}"),
        ("&mdash;", "—"), ("&ndash;", "–"), ("&hellip;", "…"),
        ("&lsquo;", "‘"), ("&rsquo;", "’"), ("&ldquo;", "“"), ("&rdquo;", "”"),
        ("&laquo;", "«"), ("&raquo;", "»"), ("&middot;", "·"), ("&bull;", "•"),
        ("&copy;", "©"), ("&reg;", "®"), ("&trade;", "™"),
        ("&euro;", "€"), ("&pound;", "£"), ("&deg;", "°"),
    ]

    private static let numeric = try! NSRegularExpression(pattern: "&#(x[0-9a-f]+|[0-9]+);", options: .caseInsensitive)

    static func plainText(from html: String) -> String {
        var text = html.replacingOccurrences(
            of: "(?s)<(script|style|head)[^>]*>.*?</\\1>",
            with: " ",
            options: [.regularExpression, .caseInsensitive]
        )
        // Tags that end a line, before the ones that do not.
        text = text.replacingOccurrences(
            of: "<(br|/p|/div|/tr|/li|/h[1-6])[^>]*>",
            with: "\n",
            options: [.regularExpression, .caseInsensitive]
        )
        text = text.replacingOccurrences(of: "<[^>]+>", with: "", options: .regularExpression)
        for (entity, character) in entities {
            text = text.replacingOccurrences(of: entity, with: character, options: .caseInsensitive)
        }
        // `&#8212;` and `&#x2014;`, which is how much of the world's mail writes a dash.
        let ns = text as NSString
        var decoded = ""
        var last = 0
        for match in numeric.matches(in: text, range: NSRange(location: 0, length: ns.length)) {
            decoded += ns.substring(with: NSRange(location: last, length: match.range.location - last))
            let digits = ns.substring(with: match.range(at: 1))
            let code = digits.lowercased().hasPrefix("x") ? UInt32(digits.dropFirst(), radix: 16) : UInt32(digits)
            if let code, code >= 1, code <= 0x10FFFF, let scalar = Unicode.Scalar(code) {
                decoded += String(Character(scalar))
            } else {
                decoded += ns.substring(with: match.range)
            }
            last = match.range.location + match.range.length
        }
        decoded += ns.substring(from: last)
        text = decoded
        // LAST: a mail that wants to show the text "&mdash;" writes
        // "&amp;mdash;", and decoding the ampersand first would turn it into
        // an em dash — quietly changing what somebody wrote.
        text = text.replacingOccurrences(of: "&amp;", with: "&", options: .caseInsensitive)
        // Runs of blank lines are an artefact of the markup, not of what
        // anybody wrote.
        text = text.replacingOccurrences(of: "[ \\t]+", with: " ", options: .regularExpression)
        text = text.replacingOccurrences(of: "\n{3,}", with: "\n\n", options: .regularExpression)
        return text.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static let quoteOpeners: [NSRegularExpression] = [
        // "On Tue, 3 Sep 2026 at 10:04, Sara <sara@x.com> wrote:" — Gmail,
        // Apple Mail and Outlook's English, which is most of what arrives.
        try! NSRegularExpression(pattern: "^\\s*On .{4,200}wrote:\\s*$", options: .caseInsensitive),
        // The same line in Persian and Turkish clients.
        try! NSRegularExpression(pattern: "^\\s*.{0,200}نوشت:\\s*$"),
        try! NSRegularExpression(pattern: "^\\s*.{4,200}(yazdı|şunu yazdı):\\s*$", options: .caseInsensitive),
        try! NSRegularExpression(
            pattern: "^\\s*-{2,}\\s*(Original Message|Forwarded message|پیام اصلی|پیام ارسال‌شده)\\s*-{2,}\\s*$",
            options: .caseInsensitive
        ),
        try! NSRegularExpression(pattern: "^\\s*From: .+$", options: .caseInsensitive),
    ]

    /// The new text of a mail, and the trail it quotes — split where the
    /// quote starts, so the trail can fold away the way every mail client
    /// folds it. No trail when nothing is quoted, and when the "quote" would
    /// be the whole mail (a forward is its content, not a trail to hide).
    static func splitQuoted(_ text: String) -> (fresh: String, quoted: String?) {
        let lines = text.components(separatedBy: "\n")
        let start = lines.firstIndex { line in
            if line.drop(while: { $0 == " " || $0 == "\t" }).hasPrefix(">") { return true }
            let range = NSRange(line.startIndex..., in: line)
            return quoteOpeners.contains { $0.firstMatch(in: line, range: range) != nil }
        }
        guard let start, start > 0 else { return (text, nil) }
        let fresh = lines[..<start].joined(separator: "\n").replacingOccurrences(of: "\\s+$", with: "", options: .regularExpression)
        guard !fresh.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return (text, nil) }
        return (fresh, lines[start...].joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines))
    }
}
