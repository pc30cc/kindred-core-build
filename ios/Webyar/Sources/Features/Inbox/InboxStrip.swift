import Foundation

/// What the strip above the inbox list switches between: one of the queues,
/// or the colleagues.
///
/// Colleagues is not a queue — no contact, no status, a colleague and a thread
/// with them — so it is its own item rather than another `InboxFilter`, and
/// selecting it shows the colleagues in place of the conversations.
enum InboxStripItem: Hashable, Identifiable, Sendable {
    case queue(InboxFilter)
    case colleagues

    var id: String {
        switch self {
        case .queue(let filter): "queue.\(filter.rawValue)"
        case .colleagues: "colleagues"
        }
    }

    /// The queues the plan and Super Admin leave on the strip, then
    /// Colleagues when team chat is on.
    static func strip(chips: [InboxFilter], colleagues: Bool) -> [InboxStripItem] {
        chips.map(InboxStripItem.queue) + (colleagues ? [.colleagues] : [])
    }
}
