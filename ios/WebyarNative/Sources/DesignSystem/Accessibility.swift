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
    /// The menu behind the inbox title, listing every queue and inbox.
    static let inboxTitleMenu = "inbox.title.menu"
    /// The three-line menu in the chat header.
    static let conversationMenu = "chat.menu"
    /// The composer's send button.
    static let composerSend = "composer.send"
    /// The voice picker inside the field, on a thread the AI answers.
    static let sayNowVoice = "sayNow.voice"
    /// One saved reply in the picker.
    static func shortcutRow(_ id: String) -> String { "shortcut.\(id)" }
    /// The composer's paperclip, present only where the plan allows files.
    static let attachButton = "composer.attach"
    /// One message in a transcript, visitor or internal.
    static func messageRow(_ id: String) -> String { "message.\(id)" }
    /// One conversation in the inbox — the row that opens the chat.
    static func conversationRow(_ id: String) -> String { "conversation.\(id)" }
    /// The row at the foot of Security that opens account deletion.
    static let deleteAccountRow = "settings.deleteAccount"
    /// The password field on the deletion screen.
    static let deleteAccountPassword = "deleteAccount.password"
    /// The red button on the deletion screen, which asks for confirmation.
    static let deleteAccountSubmit = "deleteAccount.submit"
    /// The destructive button inside that confirmation. Best effort: a
    /// `confirmationDialog` is bridged to `UIAlertController`, which takes a
    /// title and a role from each button and need not carry anything else, so
    /// the test that drives it falls back to the button's words.
    static let deleteAccountConfirm = "deleteAccount.confirm"
    /// What the screen becomes when the server refuses because this operator
    /// still owns workspaces.
    static let deleteAccountBlocked = "deleteAccount.blocked"
    /// The line above a saved copy shown while the server cannot be reached.
    static let offlineNotice = "sync.offlineNotice"
    /// The Storage row in Settings.
    static let storageRow = "settings.storage"
    /// Clear Cache, on the Storage screen.
    static let clearCache = "settings.storage.clear"
}
