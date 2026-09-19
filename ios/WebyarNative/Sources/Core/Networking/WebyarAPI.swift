import Foundation

/// What the app needs from a backend.
///
/// The screens depend on this rather than on `APIClient` directly, which is
/// what allows the sample backend below to drive the whole UI with no network
/// at all — needed to lay out and screenshot every screen, and to produce the
/// App Store screenshots Apple requires.
protocol WebyarAPI: Sendable {
    var hasToken: Bool { get async }
    func logIn(email: String, password: String) async throws -> User
    func currentUser() async throws -> User
    func logOut() async throws
    func discardSession() async
    func requestPasswordReset(email: String) async throws

    func workspaces() async throws -> [Workspace]
    func conversations(workspaceID: String, filter: InboxFilter) async throws -> [Conversation]
    func messages(conversationID: String) async throws -> [Message]
    func send(
        body: String,
        conversationID: String,
        workspaceID: String,
        clientMessageID: String,
        attachmentID: String?
    ) async throws
    /// `conversationID` is nil for an internal message: team chat reuses
    /// `conversation_attachments` with the conversation left unset, which is
    /// how the server tells an operator-to-operator file from a visitor's.
    func uploadAttachment(
        conversationID: String?,
        workspaceID: String,
        fileName: String,
        mimeType: String,
        data: Data
    ) async throws -> String
    func markSeen(conversationID: String) async throws
    func setStatus(_ status: ConversationStatus, conversationID: String, workspaceID: String) async throws
    func claim(conversationID: String, workspaceID: String) async throws
    func inboxCounts(workspaceID: String, scope: String) async throws -> InboxCounts
    // Email Inbox — a real mailbox, on its own `/api/email-inbox` surface.
    func emailThreads(workspaceID: String, search: String?) async throws -> [EmailThreadSummary]
    func emailThread(workspaceID: String, threadID: String) async throws -> EmailThreadResponse
    func setEmailThreadRead(workspaceID: String, threadID: String, isRead: Bool) async throws
    func setEmailThreadStarred(workspaceID: String, threadID: String, starred: Bool) async throws
    func sendEmail(workspaceID: String, threadID: String?, to: [String], subject: String, body: String) async throws
    func gmailConnection(workspaceID: String) async throws -> GmailConnection?
    // Channel inboxes the workspace has installed — Telegram, Bale and the rest.
    func channelInboxes(workspaceID: String) async throws -> [ChannelInbox]
    // Colleagues — operator-to-operator messages.
    func colleagues(workspaceID: String) async throws -> ColleaguesResponse
    func teamThread(workspaceID: String, peerID: String) async throws -> TeamThreadResponse
    func sendTeamMessage(workspaceID: String, recipientID: String, body: String, attachmentID: String?) async throws
    func markTeamThreadRead(workspaceID: String, peerID: String) async throws
    // Saved replies, shared across the workspace.
    func cannedResponses(workspaceID: String, locale: String, query: String) async throws -> [CannedResponse]
    /// Advisory: it orders the list by how often each one is actually used.
    /// Failing to record a use must never stop a message going out.
    func trackCannedResponseUse(id: String, workspaceID: String) async throws
    // Whether visitors can see this operator.
    func availability() async throws -> AvailabilityResponse
    func updateAvailability(_ update: AvailabilityUpdate) async throws -> AvailabilityResponse
    // What the app may show as a promotion, for this workspace and language.
    func promotions(workspaceID: String, locale: String) async throws -> Promotions
    // Asks the platform where it lives, before anything else talks to it.
    func refreshOrigin() async
    func contacts(workspaceID: String) async throws -> [Contact]
    func visitorIntel(workspaceID: String, conversationIDs: [String]) async throws -> [String: VisitorProfile]
    func visitorIntel(workspaceID: String, contactIDs: [String]) async throws -> [String: VisitorProfile]

    func updateConversation(
        conversationID: String,
        workspaceID: String,
        status: ConversationStatus?,
        priority: ConversationPriority?,
        assignedTo: String??,
        tags: [String]?
    ) async throws
    func workspaceMembers(workspaceID: String) async throws -> [WorkspaceMember]
    func notes(conversationID: String, workspaceID: String) async throws -> [ConversationNote]
    func addNote(conversationID: String, workspaceID: String, body: String) async throws
    func deleteNote(conversationID: String, workspaceID: String, noteID: String) async throws
    func inviteToCall(conversationID: String, workspaceID: String, channel: CallChannel) async throws -> CallInvitation
    func cancelInvitation(id: String) async throws
    func invitation(id: String) async throws -> CallInvitation
    func callToken(callSessionID: String, displayName: String?) async throws -> CallToken
    func hangUp(callSessionID: String) async throws

    func entitlements(workspaceID: String) async throws -> Entitlements

    func account() async throws -> Account
    func updateProfile(fullName: String?, preferredLocale: String?) async throws -> Account
    func uploadAvatar(imageData: Data, contentType: String, fileName: String?) async throws -> AccountProfile?
    func attachmentData(id: String) async throws -> Data
    func deleteAvatar() async throws
    func sessions() async throws -> AccountSessionsResponse
    func revokeSession(id: String) async throws
    func changePassword(current: String, new: String) async throws
}

extension APIClient: WebyarAPI {}

/// Chooses the backend for this launch.
///
/// The app talks to the real server. The in-memory sample backend exists only
/// to lay out and screenshot screens that otherwise need a live account, and
/// it is fenced off twice over: it is compiled only into Debug builds, so a
/// Release build physically cannot contain it, and even in Debug it requires
/// an explicit launch argument. There is no setting, no gesture and no server
/// response that can reach it.
enum Backend {
    #if DEBUG
    static let isSample = ProcessInfo.processInfo.arguments.contains("-WebyarSampleData")
    static let current: any WebyarAPI = isSample ? SampleAPI() : APIClient.shared
    #else
    static let isSample = false
    static let current: any WebyarAPI = APIClient.shared
    #endif
}

#if DEBUG
/// Signs in from launch arguments so a screenshot run can reach the screens
/// that live behind the login.
///
/// The credentials are read from the command line and never appear in source
/// or in the bundle, and like everything else here this is compiled out of
/// Release entirely — a shipped build has no automatic sign-in at all.
enum AutoLogin {
    static let credentials: (email: String, password: String)? = {
        let arguments = ProcessInfo.processInfo.arguments
        guard let index = arguments.firstIndex(of: "-WebyarAutoLogin"),
              arguments.index(index, offsetBy: 2, limitedBy: arguments.endIndex.advanced(by: -1)) != nil
        else { return nil }
        return (
            arguments[arguments.index(after: index)],
            arguments[arguments.index(index, offsetBy: 2)]
        )
    }()
}

/// Language for a Debug launch, when one is named on the command line.
///
/// Apple wants screenshots in every language the app ships in, and the
/// operator's choice lives in `UserDefaults` — which a screenshot run cannot
/// set from outside the app's sandbox. Naming it on the command line is how
/// `fastlane snapshot` and friends do it, and it is the only way to run the
/// same screen three times in three languages without tapping through
/// Settings. Compiled out of Release entirely.
enum LanguageOverride {
    static let current: Language? = {
        let arguments = ProcessInfo.processInfo.arguments
        guard let index = arguments.firstIndex(of: "-WebyarLanguage"),
              arguments.index(after: index) < arguments.endIndex
        else { return nil }
        return Language(rawValue: arguments[arguments.index(after: index)])
    }()
}

/// Which screen a Debug launch should open on.
///
/// Screenshot automation cannot tap its way through an app, and Apple wants a
/// shot of each major screen. Naming the destination on the command line is
/// how `fastlane snapshot` and friends do it. It applies to a sample-data run
/// and to an auto-signed-in run against the real server alike — the point is
/// to reach a screen, not to choose where its content comes from.
enum SampleRoute: String {
    case inbox, chat, aiChat, call, videoCall, contacts, contact, settings, profile, security, email
    case colleagues, colleagueThread

    static let current: SampleRoute? = {
        let arguments = ProcessInfo.processInfo.arguments
        guard let index = arguments.firstIndex(of: "-WebyarScreen"),
              arguments.index(after: index) < arguments.endIndex
        else { return nil }
        return SampleRoute(rawValue: arguments[arguments.index(after: index)])
    }()
}
#endif
