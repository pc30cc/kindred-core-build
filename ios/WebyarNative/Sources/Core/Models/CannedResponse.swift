import Foundation

/// A saved reply the operator can drop into the composer.
///
/// The console calls these canned responses and the mobile web calls them
/// shortcuts; they are the same rows, in `canned_responses`, shared by
/// everyone in the workspace rather than owned per operator. Anyone can use
/// any of them; only the author and the workspace's owners and admins can
/// change one, which is why this app offers no editor — a phone is where you
/// reach for a reply, not where you curate the list.
struct CannedResponse: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let shortcut: String
    let title: String
    /// Stored raw, with its `{{placeholders}}` unexpanded. `CannedText`
    /// resolves them at the moment of insertion, against this conversation.
    let body: String
    let locale: String
    let usageCount: Int?

    enum CodingKeys: String, CodingKey {
        case id, shortcut, title, body, locale
        case usageCount = "usage_count"
    }
}

struct CannedResponsesResponse: Decodable, Sendable {
    let items: [CannedResponse]
}

/// Fills in a canned response's placeholders.
///
/// The six names and the rule for a name that cannot be filled are the web's,
/// from `src/components/canned-responses/interpolation.ts`: an unknown
/// placeholder, or one whose value is empty, is **left exactly as written**.
/// That is deliberate and worth keeping — a greeting that silently becomes
/// "Hello ," is worse than one that visibly still says "Hello {{contact.name}}",
/// because only the second is something the operator will notice before they
/// send it.
enum CannedText {
    struct Context: Sendable {
        var contactName: String?
        var contactEmail: String?
        var workspaceName: String?
        var agentName: String?
        var agentEmail: String?

        /// `{{agent.first_name}}` is the first word of the agent's name, the
        /// same way the web splits it.
        var agentFirstName: String? {
            agentName?.split(separator: " ").first.map(String.init)
        }

        func value(for name: String) -> String? {
            let resolved: String?
            switch name {
            case "contact.name": resolved = contactName
            case "contact.email": resolved = contactEmail
            case "workspace.name": resolved = workspaceName
            case "agent.name": resolved = agentName
            case "agent.first_name": resolved = agentFirstName
            case "agent.email": resolved = agentEmail
            default: return nil
            }
            guard let resolved, !resolved.trimmingCharacters(in: .whitespaces).isEmpty else {
                return nil
            }
            return resolved
        }
    }

    /// The same pattern the web uses: a dotted lower-case name, with optional
    /// spaces inside the braces.
    private static let pattern = try? NSRegularExpression(
        pattern: "\\{\\{\\s*([a-z_]+\\.[a-z_]+)\\s*\\}\\}"
    )

    static func interpolate(_ body: String, _ context: Context) -> String {
        guard let pattern else { return body }
        let full = NSRange(body.startIndex..<body.endIndex, in: body)
        var output = ""
        var cursor = body.startIndex

        for match in pattern.matches(in: body, range: full) {
            guard let whole = Range(match.range, in: body),
                  let nameRange = Range(match.range(at: 1), in: body)
            else { continue }
            output += body[cursor..<whole.lowerBound]
            // A name with no value keeps its braces, so the operator sees it.
            output += context.value(for: String(body[nameRange])) ?? String(body[whole])
            cursor = whole.upperBound
        }
        output += body[cursor...]
        return output
    }
}
