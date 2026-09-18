import SwiftUI
import Observation

/// Where the app is in its session lifecycle.
///
/// `restoring` exists so the first frame is never the login screen for
/// somebody who is in fact already signed in — that flash is the single most
/// noticeable way a native app can look cheap.
enum SessionState: Equatable {
    case restoring
    case signedOut
    case signedIn(User)

    var user: User? {
        if case .signedIn(let user) = self { return user }
        return nil
    }
}

/// Session, workspace and language — the three things every screen needs.
@MainActor
@Observable
final class AppState {

    private(set) var session: SessionState = .restoring
    private(set) var workspaces: [Workspace] = []
    private(set) var selectedWorkspace: Workspace?

    /// The operator's chosen language. Device language is deliberately never
    /// consulted, matching the web app: a language someone picked is a
    /// decision, and travelling with a differently-configured phone should not
    /// silently override it.
    var language: Language {
        didSet {
            guard language != oldValue else { return }
            UserDefaults.standard.set(language.rawValue, forKey: Self.languageKey)
        }
    }

    /// Set when the operator's session turns out to be void, so the login
    /// screen can say why they are looking at it.
    private(set) var sessionEndedMessage: String?

    private static let languageKey = "app.language"
    private let api: APIClient

    init(api: APIClient = .shared) {
        self.api = api
        let stored = UserDefaults.standard.string(forKey: Self.languageKey)
        self.language = stored.flatMap(Language.init(rawValue:)) ?? GeneratedConfig.defaultLanguage
    }

    // MARK: - Session

    /// Restores a stored session at launch. A transport failure leaves the
    /// operator signed in with whatever is cached — only the server saying the
    /// session is void signs them out.
    func restore() async {
        guard await api.hasToken else {
            session = .signedOut
            return
        }
        do {
            let user = try await api.currentUser()
            session = .signedIn(user)
            await loadWorkspaces()
        } catch APIError.unauthorized {
            await api.discardSession()
            session = .signedOut
        } catch {
            // Offline at launch: we cannot prove the session is gone, so keep
            // the operator in and let individual screens show their own retry.
            session = .signedOut
        }
    }

    func signedIn(_ user: User) async {
        sessionEndedMessage = nil
        session = .signedIn(user)
        await loadWorkspaces()
    }

    /// Signs out only on a confirmed server-side revocation. Returns false if
    /// the request failed, so the UI can say the operator is still signed in
    /// rather than showing a logged-out screen over a live session.
    func signOut() async -> Bool {
        do {
            try await api.logOut()
        } catch APIError.unauthorized {
            // The session was already void — the desired end state either way.
            await api.discardSession()
        } catch {
            return false
        }
        reset()
        return true
    }

    /// Called when any screen's request comes back 401: the session is gone,
    /// so stop pretending otherwise.
    func handleUnauthorized() async {
        guard session != .signedOut else { return }
        await api.discardSession()
        sessionEndedMessage = Str.sessionExpired(language)
        reset()
    }

    private func reset() {
        session = .signedOut
        workspaces = []
        selectedWorkspace = nil
    }

    func clearSessionEndedMessage() {
        sessionEndedMessage = nil
    }

    // MARK: - Workspaces

    func loadWorkspaces() async {
        do {
            let list = try await api.workspaces()
            workspaces = list
            // Keep the current selection if it is still valid; otherwise fall
            // back to the first, so the inbox always has something to load.
            if let current = selectedWorkspace, list.contains(where: { $0.id == current.id }) { return }
            selectedWorkspace = list.first
        } catch APIError.unauthorized {
            await handleUnauthorized()
        } catch {
            // Leave whatever we had; the inbox surfaces its own error state.
        }
    }

    func select(_ workspace: Workspace) {
        selectedWorkspace = workspace
    }
}
