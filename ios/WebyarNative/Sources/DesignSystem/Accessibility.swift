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
    /// "WEBYAR AI" at the foot of the launch, sign-in and reset screens.
    static let brandFooter = "brand.footer"
    /// Where a conversation is written from, on its row and in its bar.
    static func channelLabel(_ key: String) -> String { "channel.\(key)" }

    // Settings → Online support (docs/PLATFORM_SUPPORT.md). The same names
    // as the Android app's test tags.
    /// The one row, which opens the chat.
    static let settingsSupportChat = "settings.support.chat"
    static let supportTranscript = "support.transcript"
    static let supportGreeting = "support.greeting"
    static let supportOfflineBanner = "support.offline"
    static let supportEndedPanel = "support.ended"
    static let supportStartNew = "support.startNew"
    /// The chat bar's way to the conversations that ended.
    static let supportClosedButton = "support.closed"
    static let supportClosedList = "support.closed.list"
    static func supportClosedRow(_ conversationID: String) -> String { "support.closed.\(conversationID)" }
    static func supportRatingStar(_ conversationID: String, _ star: Int) -> String {
        "support.rating.\(conversationID).star.\(star)"
    }
    static func supportRatingComment(_ conversationID: String) -> String { "support.rating.\(conversationID).comment" }
    static func supportRatingSubmit(_ conversationID: String) -> String { "support.rating.\(conversationID).submit" }
    /// The rating once given.
    static func supportRatingGiven(_ conversationID: String) -> String { "support.rating.\(conversationID).given" }
    /// A message that did not go, with its retry.
    static func supportRetry(_ clientMessageID: String) -> String { "support.retry.\(clientMessageID)" }

    // The mailbox (Inbox → Email). The same names as the Android app's test tags.
    static let emailList = "email.list"
    static func emailRow(_ threadID: String) -> String { "email.row.\(threadID)" }
    static func emailStar(_ threadID: String) -> String { "email.star.\(threadID)" }
    static let emailLoading = "email.loading"
    static let emailEmpty = "email.empty"
    static let emailNotConnected = "email.notConnected"
    /// The thin line under the filters while the list is read again.
    static let emailSyncing = "email.syncing"
    /// The bar's ☰, which opens the folders.
    static let emailFolders = "email.folders"
    static let emailDrawer = "email.drawer"
    static func emailMailFolder(_ id: String) -> String { "email.folder.\(id)" }
    static func emailMailbox(_ provider: String) -> String { "email.mailbox.\(provider)" }
    static func emailFilter(_ filter: String) -> String { "email.filter.\(filter)" }
    static let emailCompose = "email.compose"
    /// The page a thread is read on.
    static let emailThread = "email.thread"
    static let emailThreadStar = "email.thread.star"
    static let emailMenu = "email.menu"
    static let emailReply = "email.reply"
    static let emailReplyAll = "email.replyAll"
    static let emailForward = "email.forward"
    static let emailDownloading = "email.downloading"
    static let emailComposeTo = "email.compose.to"
    static let emailComposeCc = "email.compose.cc"
    static let emailComposeCcBcc = "email.compose.ccBcc"
    static let emailComposeSubject = "email.compose.subject"
    static let emailComposeBody = "email.compose.body"
    static let emailComposeSend = "email.compose.send"
    static let emailComposeClose = "email.compose.close"
    static let emailComposeAttach = "email.compose.attach"
    static let emailComposeAttachment = "email.compose.attachment"
    static let emailComposeError = "email.compose.error"

    /// Who is asking: the card at the top of a platform-support conversation.
    static let supportRequesterCard = "support.requester"

    /// Security: sign out of every device but this one.
    static let securityRevokeOthers = "security.revokeOthers"
    /// The confirming button inside its dialog — best effort, as with
    /// account deletion: the bridged sheet need not carry it, and the words
    /// are the fallback.
    static let securityRevokeOthersConfirm = "security.revokeOthers.confirm"

    /// Settings → About: the version, its build, and the platform's website.
    static let settingsVersion = "settings.version"
    static let settingsBuild = "settings.build"
    static let settingsWebsite = "settings.website"

    // The inbox's strip, beside its queues.
    /// The strip's envelope, which opens the mailbox.
    static let inboxEmail = "inbox.email"
    /// The strip's ☰, which lists every inbox.
    static let inboxEveryInbox = "inbox.everyInbox"
    static let everyInboxSheet = "inbox.everyInbox.sheet"
    static func everyInboxRow(_ key: String) -> String { "inbox.everyInbox.\(key)" }
}
