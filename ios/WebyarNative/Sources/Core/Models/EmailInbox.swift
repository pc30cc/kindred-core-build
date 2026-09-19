import Foundation

// The Email Inbox is a real mailbox — Gmail today — and is deliberately a
// different surface from the chat inbox, right down to its own API prefix
// (`/api/email-inbox`, not `/api/email`). These types mirror
// `src/lib/emailInbox-api.ts` field for field, and the server already speaks
// camelCase here, so almost none of them need coding keys.

struct EmailAddress: Codable, Hashable, Sendable {
    let email: String
}

struct EmailThreadSummary: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let provider: String?
    let subject: String?
    let participants: [EmailAddress]?
    let lastMessageAt: Date?
    let isRead: Bool?
    let isStarred: Bool?
    let labels: [String]?
    let lastMessageSnippet: String?

    /// Who the row is about: everyone on the thread except, where we can tell,
    /// the mailbox itself.
    func people(excluding mailbox: String?) -> String {
        let all = (participants ?? []).map(\.email)
        let others = mailbox.map { own in all.filter { $0.caseInsensitiveCompare(own) != .orderedSame } } ?? all
        let shown = others.isEmpty ? all : others
        return shown.joined(separator: ", ")
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

    /// What to show in the trail.
    ///
    /// The plain-text part when there is one; otherwise the HTML with its tags
    /// taken out, because a mail written only in HTML is common and showing
    /// its markup is worse than showing its words imperfectly. A web view per
    /// message would render it properly and is the obvious next step — it is
    /// also a much larger surface to get right on a phone, so this stays
    /// text until that is worth building.
    var displayBody: String {
        if let text = textBody?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty {
            return text
        }
        if let html = htmlBody, !html.isEmpty { return EmailBody.plainText(from: html) }
        return snippet ?? ""
    }
}

struct EmailThreadResponse: Decodable, Sendable {
    let thread: EmailThreadSummary
    let messages: [EmailMessageView]
}

struct EmailThreadsResponse: Decodable, Sendable {
    let threads: [EmailThreadSummary]
    let nextBefore: String?
}

/// The connected mailbox, so the screen can say whose inbox this is — and say
/// something useful when there isn't one.
struct GmailConnection: Codable, Sendable {
    let connected: Bool?
    let emailAddress: String?
    let status: String?
}

struct GmailConnectionResponse: Decodable, Sendable {
    let connection: GmailConnection?
    let platformConfigured: Bool?
}

/// Turns an HTML mail into something readable as plain text.
///
/// Not a parser and not trying to be: it drops the parts that are never
/// content, unwraps the tags, and puts back the handful of entities that
/// appear in almost every message. Anything cleverer belongs in a web view.
enum EmailBody {
    static func plainText(from html: String) -> String {
        var text = html
        for block in ["script", "style", "head"] {
            text = text.replacingOccurrences(
                // `(?s)` so a block spanning several lines is still one match.
                of: "(?s)<\(block)[^>]*>.*?</\(block)>",
                with: " ",
                options: [.regularExpression, .caseInsensitive]
            )
        }
        // Tags that end a line, before the ones that do not.
        text = text.replacingOccurrences(
            of: "<(br|/p|/div|/tr|/li|/h[1-6])[^>]*>",
            with: "\n",
            options: [.regularExpression, .caseInsensitive]
        )
        text = text.replacingOccurrences(of: "<[^>]+>", with: "", options: .regularExpression)

        let entities = [
            "&nbsp;": " ", "&amp;": "&", "&lt;": "<", "&gt;": ">",
            "&quot;": "\"", "&#39;": "'", "&apos;": "'", "&zwnj;": "\u{200C}",
        ]
        for (entity, character) in entities {
            text = text.replacingOccurrences(of: entity, with: character, options: .caseInsensitive)
        }

        // Three blank lines in a row are an artefact of the markup, not of
        // what anybody wrote.
        text = text.replacingOccurrences(of: "[ \\t]+", with: " ", options: .regularExpression)
        text = text.replacingOccurrences(of: "\n{3,}", with: "\n\n", options: .regularExpression)
        return text.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
