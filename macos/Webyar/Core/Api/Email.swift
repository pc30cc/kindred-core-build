import Foundation

// The workspace mailbox — a real Gmail/Yahoo inbox on its own
// /api/email-inbox surface (server/routes/emailInbox.ts), which answers in
// camelCase. Addresses come as the provider stored them: plain strings or
// `{ email, name }` objects, so they are read loosely.

struct EmailAddress: Hashable, Sendable, Identifiable {
    var email: String
    var name: String?

    var id: String { email.lowercased() }

    /// The person's name when the provider gave one, else the address.
    var display: String {
        if let n = name?.trimmingCharacters(in: .whitespaces), !n.isEmpty { return n }
        return email
    }

    /// Reads a string, an object, or a list of either.
    static func list(_ v: JSONValue?) -> [EmailAddress] {
        guard let v else { return [] }
        if let a = v.array { return a.flatMap { list($0) } }
        if let s = v.text { return parse(s) }
        if v.object != nil, let e = (v["email"] ?? v["address"])?.text {
            return [EmailAddress(email: e, name: v["name"]?.text)]
        }
        return []
    }

    /// "Sara <sara@x.com>, bob@y.com" → two addresses.
    static func parse(_ text: String) -> [EmailAddress] {
        text.split(whereSeparator: { $0 == "," || $0 == ";" || $0 == "\n" }).compactMap { raw in
            let part = raw.trimmingCharacters(in: .whitespaces)
            guard !part.isEmpty else { return nil }
            if let lt = part.lastIndex(of: "<"), let gt = part.lastIndex(of: ">"), lt < gt {
                let email = String(part[part.index(after: lt)..<gt]).trimmingCharacters(in: .whitespaces)
                let name = String(part[..<lt]).trimmingCharacters(in: CharacterSet(charactersIn: " \""))
                return email.isEmpty ? nil : EmailAddress(email: email, name: name.isEmpty ? nil : name)
            }
            return EmailAddress(email: part, name: nil)
        }
    }

    var isValid: Bool {
        let t = email.trimmingCharacters(in: .whitespaces)
        guard let at = t.firstIndex(of: "@"), at > t.startIndex, let dot = t.lastIndex(of: "."), !t.contains(" ") else { return false }
        return dot > t.index(after: at) && !t.hasSuffix(".")
    }
}

struct EmailThreadSummary: Decodable, Hashable, Sendable, Identifiable {
    var id: String
    var provider: String?
    var subject: String?
    var participantsRaw: JSONValue?
    var lastMessageAt: Date?
    var isRead: Bool?
    var isStarred: Bool?
    var labels: [String]?
    var lastMessageSnippet: String?

    enum CodingKeys: String, CodingKey {
        case id, provider, subject, lastMessageAt, isRead, isStarred, labels, lastMessageSnippet
        case participantsRaw = "participants"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        provider = try? c.decodeIfPresent(String.self, forKey: .provider)
        subject = try? c.decodeIfPresent(String.self, forKey: .subject)
        participantsRaw = try? c.decodeIfPresent(JSONValue.self, forKey: .participantsRaw)
        lastMessageAt = try? c.decodeIfPresent(Date.self, forKey: .lastMessageAt)
        isRead = try? c.decodeIfPresent(Bool.self, forKey: .isRead)
        isStarred = try? c.decodeIfPresent(Bool.self, forKey: .isStarred)
        labels = try? c.decodeIfPresent([String].self, forKey: .labels)
        lastMessageSnippet = try? c.decodeIfPresent(String.self, forKey: .lastMessageSnippet)
    }

    var participants: [EmailAddress] { EmailAddress.list(participantsRaw) }
    var unread: Bool { isRead == false }
    var starred: Bool { isStarred == true }
}

struct EmailAttachmentView: Decodable, Hashable, Sendable, Identifiable {
    var id: String
    var filename: String?
    var contentType: String?
    @Lenient var sizeBytes: Int64? = nil
    var contentId: String?
    var url: String?
    /// The same file through the API, read from whichever provider is primary now (newer servers).
    var downloadPath: String?
}

struct EmailMessageView: Decodable, Hashable, Sendable, Identifiable {
    var id: String
    var direction: String?
    var fromAddress: String?
    var toRaw: JSONValue?
    var ccRaw: JSONValue?
    var bccRaw: JSONValue?
    var textBody: String?
    var htmlBody: String?
    var snippet: String?
    var isRead: Bool?
    var deliveryStatus: String?
    var deliveryError: String?
    var sentAt: Date?
    var attachments: [EmailAttachmentView]?

    enum CodingKeys: String, CodingKey {
        case id, direction, fromAddress, textBody, htmlBody, snippet, isRead, deliveryStatus, deliveryError, sentAt, attachments
        case toRaw = "toAddresses", ccRaw = "ccAddresses", bccRaw = "bccAddresses"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        direction = try? c.decodeIfPresent(String.self, forKey: .direction)
        fromAddress = try? c.decodeIfPresent(String.self, forKey: .fromAddress)
        toRaw = try? c.decodeIfPresent(JSONValue.self, forKey: .toRaw)
        ccRaw = try? c.decodeIfPresent(JSONValue.self, forKey: .ccRaw)
        bccRaw = try? c.decodeIfPresent(JSONValue.self, forKey: .bccRaw)
        textBody = try? c.decodeIfPresent(String.self, forKey: .textBody)
        htmlBody = try? c.decodeIfPresent(String.self, forKey: .htmlBody)
        snippet = try? c.decodeIfPresent(String.self, forKey: .snippet)
        isRead = try? c.decodeIfPresent(Bool.self, forKey: .isRead)
        deliveryStatus = try? c.decodeIfPresent(String.self, forKey: .deliveryStatus)
        deliveryError = try? c.decodeIfPresent(String.self, forKey: .deliveryError)
        sentAt = try? c.decodeIfPresent(Date.self, forKey: .sentAt)
        attachments = try? c.decodeIfPresent([EmailAttachmentView].self, forKey: .attachments)
    }

    var from: EmailAddress { EmailAddress.parse(fromAddress ?? "").first ?? EmailAddress(email: fromAddress ?? "", name: nil) }
    var to: [EmailAddress] { EmailAddress.list(toRaw) }
    var cc: [EmailAddress] { EmailAddress.list(ccRaw) }
    var bcc: [EmailAddress] { EmailAddress.list(bccRaw) }
    var isOutbound: Bool { direction == "outbound" }
}

struct EmailThreadDetail: Decodable, Sendable {
    var thread: EmailThreadSummary?
    var messages: [EmailMessageView]?
}

struct EmailThreadPage: Decodable, Sendable {
    var threads: [EmailThreadSummary]?
    /// The cursor for the next (older) page; nil at the end.
    var nextBefore: String?
}

struct MailboxConnection: Decodable, Sendable {
    var connected: Bool?
    var emailAddress: String?
    var status: String?
}

/// A file uploaded ahead of a send; the send call attaches it.
struct StagedEmailAttachment: Decodable, Hashable, Sendable {
    var storageKey: String
    var filename: String
    var contentType: String
    @Lenient var sizeBytes: Int64? = nil
}

enum EmailFolder: String, CaseIterable, Sendable {
    case all, unread, starred
}

extension WebyarAPI {
    private static func mailbox(_ workspaceId: String) -> String {
        "/api/email-inbox/\(ApiClient.escape(workspaceId))"
    }

    func emailThreads(workspaceId: String, folder: EmailFolder, search: String?, before: String? = nil) async throws -> EmailThreadPage {
        let q = search?.trimmingCharacters(in: .whitespaces)
        return try await client.get(Self.mailbox(workspaceId) + "/threads", query: [
            ("limit", "50"),
            ("q", (q?.isEmpty ?? true) ? nil : q),
            ("unread", folder == .unread ? "true" : nil),
            ("starred", folder == .starred ? "true" : nil),
            ("before", before),
        ])
    }

    func emailThread(workspaceId: String, threadId: String) async throws -> EmailThreadDetail {
        try await client.get(Self.mailbox(workspaceId) + "/threads/\(ApiClient.escape(threadId))")
    }

    func setEmailRead(workspaceId: String, threadId: String, isRead: Bool) async throws {
        try await client.call("POST", Self.mailbox(workspaceId) + "/threads/\(ApiClient.escape(threadId))/read", body: ["is_read": isRead])
    }

    func setEmailStarred(workspaceId: String, threadId: String, starred: Bool) async throws {
        try await client.call("POST", Self.mailbox(workspaceId) + "/threads/\(ApiClient.escape(threadId))/star", body: ["starred": starred])
    }

    /// Uploads a file for the next send (up to 25 MB).
    func stageEmailAttachment(workspaceId: String, filename: String, contentType: String, data: Data) async throws -> StagedEmailAttachment {
        try await client.upload(Self.mailbox(workspaceId) + "/attachments", query: [("filename", filename), ("content_type", contentType)],
                                data: data, contentType: contentType)
    }

    func sendEmail(workspaceId: String, threadId: String?, to: [String], cc: [String] = [], bcc: [String] = [],
                   subject: String, body: String, attachments: [StagedEmailAttachment] = []) async throws {
        var payload: [String: Any?] = [
            "thread_id": threadId,
            "to": to,
            "subject": subject,
            "text_body": body,
        ]
        if !cc.isEmpty { payload["cc"] = cc }
        if !bcc.isEmpty { payload["bcc"] = bcc }
        if !attachments.isEmpty {
            payload["attachments"] = attachments.map { a -> [String: Any] in
                ["storageKey": a.storageKey, "filename": a.filename, "contentType": a.contentType, "sizeBytes": a.sizeBytes ?? 0]
            }
        }
        try await client.call("POST", Self.mailbox(workspaceId) + "/send", body: payload)
    }

    /// The connected mailbox, for "connected as …"; nil when none (or no Gmail plugin).
    func mailboxConnection(workspaceId: String) async -> MailboxConnection? {
        struct R: Decodable { var connection: MailboxConnection? }
        let r: R? = try? await client.get("/api/plugins/gmail/connection", query: [("workspace_id", workspaceId)])
        return r?.connection
    }

    /// An attachment's bytes: its storage URL, fetched with the session when it is the API's own.
    func emailAttachmentData(_ a: EmailAttachmentView) async throws -> Data {
        // The signed-in route first: it works for any provider (no public URL, private buckets) and
        // after a provider or CDN change. The public link is only for servers without it.
        if let path = a.downloadPath, path.hasPrefix("/api/") { return try await client.bytes(path) }
        guard let raw = a.url, !raw.isEmpty else { throw ApiError(failure: .server, status: 404) }
        if raw.hasPrefix("/api/") { return try await client.bytes(raw) }
        guard let url = client.absolute(raw) else { throw ApiError(failure: .server, status: 404) }
        do {
            let (data, response) = try await URLSession.shared.data(from: url)
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            guard (200..<300).contains(status) else { throw ApiError(failure: .server, status: status) }
            return data
        } catch let e as ApiError {
            throw e
        } catch {
            throw ApiError(failure: .transport, underlying: error.localizedDescription)
        }
    }
}
