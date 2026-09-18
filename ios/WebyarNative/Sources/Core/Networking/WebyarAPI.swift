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
    func send(body: String, conversationID: String, workspaceID: String, clientMessageID: String) async throws
    func markSeen(conversationID: String) async throws
    func setStatus(_ status: ConversationStatus, conversationID: String, workspaceID: String) async throws
    func claim(conversationID: String, workspaceID: String) async throws
    func inboxCounts(workspaceID: String, scope: String) async throws -> InboxCounts
    func contacts(workspaceID: String) async throws -> [Contact]
    func visitorIntel(workspaceID: String, conversationIDs: [String]) async throws -> [String: VisitorProfile]

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

/// Which screen a Debug launch should open on.
///
/// Screenshot automation cannot tap its way through an app, and Apple wants a
/// shot of each major screen. Naming the destination on the command line is
/// how `fastlane snapshot` and friends do it. It applies to a sample-data run
/// and to an auto-signed-in run against the real server alike — the point is
/// to reach a screen, not to choose where its content comes from.
enum SampleRoute: String {
    case inbox, chat, aiChat, contacts, contact, settings, profile, security

    static let current: SampleRoute? = {
        let arguments = ProcessInfo.processInfo.arguments
        guard let index = arguments.firstIndex(of: "-WebyarScreen"),
              arguments.index(after: index) < arguments.endIndex
        else { return nil }
        return SampleRoute(rawValue: arguments[arguments.index(after: index)])
    }()
}
#endif
