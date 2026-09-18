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
#endif
