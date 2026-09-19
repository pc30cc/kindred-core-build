import Foundation

/// Names the UI tests use to find things.
///
/// Every one of these is also reachable by its accessibility *label* — the
/// screen reader has no use for these strings. The labels are translated,
/// though, and a test that looks for "جست‌وجو" passes or fails depending on
/// which language the run happened to be in. An identifier is the same in all
/// three, so the test says what it means: this button, not this word.
///
/// Only elements a test actually drives are listed. An identifier nobody
/// queries is a name to keep in step with nothing.
enum A11y {
    /// The inbox toolbar's magnifier, which opens and closes the search.
    static let inboxSearch = "inbox.search"
    /// The inbox toolbar's funnel.
    static let inboxFilter = "inbox.filter"
    /// The search field itself — absent from the hierarchy when the search is
    /// closed, which is the point of several of the tests.
    static let searchField = "search.field"
    /// The floating tab bar, whose position the keyboard must not change.
    static let tabBar = "tab.bar"
    /// The chat composer's text field.
    static let composerField = "composer.field"
    /// A workspace row in Settings. One per workspace the operator belongs to.
    static func workspaceRow(_ id: String) -> String { "settings.workspace.\(id)" }
    /// The composer's lightning bolt, which opens the saved replies.
    static let shortcutsButton = "composer.shortcuts"
    /// One saved reply in the picker.
    static func shortcutRow(_ id: String) -> String { "shortcut.\(id)" }
    /// The composer's paperclip, present only where the plan allows files.
    static let attachButton = "composer.attach"
    /// One message in a transcript, visitor or internal.
    static func messageRow(_ id: String) -> String { "message.\(id)" }
}
