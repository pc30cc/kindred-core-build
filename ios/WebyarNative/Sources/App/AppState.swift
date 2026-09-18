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

    /// What the current workspace's plan grants. Every plan-gated tab and
    /// queue reads this rather than assuming.
    private(set) var entitlements: EntitlementsState = .loading

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

    /// Light, dark, or whatever the device is set to.
    ///
    /// A per-viewer convenience, so `UserDefaults` is the right home for it —
    /// losing it costs nothing and it never needs to reach the server.
    var appearance: AppearancePreference {
        didSet {
            guard appearance != oldValue else { return }
            UserDefaults.standard.set(appearance.rawValue, forKey: Self.appearanceKey)
        }
    }

    private static let languageKey = "app.language"
    private static let appearanceKey = "app.appearance"
    private let api: any WebyarAPI

    init(api: any WebyarAPI = Backend.current) {
        self.api = api
        let stored = UserDefaults.standard.string(forKey: Self.languageKey)
        self.language = stored.flatMap(Language.init(rawValue:)) ?? GeneratedConfig.defaultLanguage

        let storedAppearance = UserDefaults.standard.string(forKey: Self.appearanceKey)
        self.appearance = storedAppearance.flatMap(AppearancePreference.init(rawValue:)) ?? .system
    }

    // MARK: - Session

    /// Restores a stored session at launch. A transport failure leaves the
    /// operator signed in with whatever is cached — only the server saying the
    /// session is void signs them out.
    func restore() async {
        #if DEBUG
        // Screenshot automation cannot type into a text field, so a Debug run
        // may carry credentials on the command line. Compiled out of Release.
        if let credentials = AutoLogin.credentials, await !api.hasToken {
            if let user = try? await api.logIn(email: credentials.email, password: credentials.password) {
                await signedIn(user)
                return
            }
        }
        #endif

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
            let keepsSelection = selectedWorkspace.map { current in
                list.contains { $0.id == current.id }
            } ?? false
            if !keepsSelection { selectedWorkspace = list.first }
            // Always re-resolve: signing back in keeps the same workspace, and
            // returning early there would leave every plan gate unresolved and
            // so every gated tab permanently hidden.
            await loadPlan()
        } catch APIError.unauthorized {
            await handleUnauthorized()
        } catch {
            // Leave whatever we had; the inbox surfaces its own error state.
        }
    }

    func select(_ workspace: Workspace) {
        guard workspace.id != selectedWorkspace?.id else { return }
        selectedWorkspace = workspace
        // A different workspace can be on a different plan, so the gates have
        // to be re-resolved before any tab decides whether it exists.
        entitlements = .loading
        Task { await loadPlan() }
    }

    // MARK: - Plan

    /// Resolves what this workspace's plan allows.
    func loadPlan() async {
        guard let workspaceID = selectedWorkspace?.id else {
            entitlements = .failed
            return
        }
        entitlements = (try? await api.entitlements(workspaceID: workspaceID))
            .map(EntitlementsState.loaded) ?? .failed
    }

    // MARK: - Gates
    //
    // These mirror the web console's sidebar rules exactly. Where they differ
    // from each other it is deliberate, and the difference is what decides
    // whether a whole tab exists.

    /// Nothing plan-gated renders until the snapshot resolves one way or the
    /// other. Showing a tab and taking it away a moment later is worse than
    /// waiting for the answer.
    var planResolved: Bool { entitlements.isResolved }

    /// A top-level section belongs in this plan. An unknown key stays visible
    /// so a module added server-side does not disappear from an older build;
    /// only an explicit `false` hides it.
    func moduleInPlan(_ key: String) -> Bool {
        switch entitlements {
        case .loading: false
        case .failed: false
        case .loaded(let value): value.moduleInPlan(key)
        }
    }

    /// Fail-closed, for a single capability rather than a whole section.
    func featureEnabled(_ key: String) -> Bool {
        entitlements.value?.featureEnabled(key) == true
    }

    var contactsVisible: Bool { moduleInPlan("contacts") }

    /// The queues this plan includes, in the order they should appear.
    var inboxFilters: [InboxFilter] {
        InboxFilter.available(for: entitlements.value)
    }
}
