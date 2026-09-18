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
    func contacts(workspaceID: String) async throws -> [Contact]
}

extension APIClient: WebyarAPI {}

/// Chooses the backend for this launch.
///
/// Sample mode is opt-in through a launch argument only. It cannot be reached
/// by a user, by a setting, or by anything on the network — a shipped build
/// launched normally always gets the real client.
enum Backend {
    static let isSample = ProcessInfo.processInfo.arguments.contains("-WebyarSampleData")

    static let current: any WebyarAPI = isSample ? SampleAPI() : APIClient.shared
}

/// Which screen a sample-mode launch should open on.
///
/// Screenshot automation cannot tap its way through an app, and Apple wants a
/// shot of each major screen. Naming the destination on the command line is
/// how `fastlane snapshot` and friends do it. Honoured only alongside
/// `-WebyarSampleData`, so it cannot affect a real launch.
enum SampleRoute: String {
    case inbox, chat, contacts, contact, settings

    static let current: SampleRoute? = {
        guard Backend.isSample else { return nil }
        let arguments = ProcessInfo.processInfo.arguments
        guard let index = arguments.firstIndex(of: "-WebyarScreen"),
              arguments.index(after: index) < arguments.endIndex
        else { return nil }
        return SampleRoute(rawValue: arguments[arguments.index(after: index)])
    }()
}
