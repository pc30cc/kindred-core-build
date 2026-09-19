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
            // Before SwiftUI has even been told, so the window and the
            // interface turn together rather than one frame apart.
            WindowDirection.apply(language)
        }
    }

    // There used to be a `syncSystemLanguage` here that wrote `AppleLanguages`
    // so UIKit's own strings — Paste, Cancel — would follow the operator's
    // choice. It cost far more than it bought and it is not coming back.
    //
    // `AppleLanguages` is read *at launch*, so the menus only caught up one
    // relaunch late — and it is a system-wide key the operator never asked us
    // to set, which then decides the window's direction behind our back. The
    // mirrored interface that came with it turned out to have a separate
    // cause, fixed in `WebyarApp`, but nothing here wanted the key either
    // way: everything this app draws comes from `Str` and follows `language`
    // directly.

    /// Which tab the shell is showing.
    ///
    /// The shell would happily own this itself were it not for the language
    /// switch, which rebuilds the shell from nothing — see `WebyarApp`. Kept
    /// here it survives that, so changing the language leaves the operator
    /// looking at the screen they changed it on. It is not persisted: where
    /// you were last time you had the app open is not a preference.
    var selectedTab: AppTab = .inbox

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
        let chosen = stored.flatMap(Language.init(rawValue:)) ?? GeneratedConfig.defaultLanguage
        #if DEBUG
        self.language = LanguageOverride.current ?? chosen
        #else
        self.language = chosen
        #endif

        let storedAppearance = UserDefaults.standard.string(forKey: Self.appearanceKey)
        self.appearance = storedAppearance.flatMap(AppearancePreference.init(rawValue:)) ?? .system
    }

    // MARK: - Session

    /// Restores a stored session at launch. A transport failure leaves the
    /// operator signed in with whatever is cached — only the server saying the
    /// session is void signs them out.
    func restore() async {
        // Changing the language rebuilds the whole hierarchy, so the root's
        // `task` runs again. Working out the launch state is a launch
        // concern: once it is known, redoing it would cost a round trip and
        // could only ever arrive at the same answer.
        guard case .restoring = session else { return }

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
            SessionCache.save(user)
            await loadWorkspaces()
        } catch APIError.unauthorized {
            // The server said the session is void. That is the only thing
            // that signs an operator out.
            await api.discardSession()
            SessionCache.clear()
            session = .signedOut
        } catch {
            // Offline at launch, or a server that did not answer in twenty
            // seconds. We cannot prove the session is gone — and it almost
            // certainly is not, since the token is still in the Keychain and
            // a mobile session lasts sixty days — so the operator stays in
            // with the account they were last seen using. Every screen still
            // makes its own requests, and the first `401` from any of them
            // signs them out properly.
            //
            // The old behaviour here was to sign out, which is what put the
            // login screen in front of somebody whose session was fine.
            if let cached = SessionCache.read() {
                session = .signedIn(cached)
                await loadWorkspaces()
            } else {
                session = .signedOut
            }
        }
    }

    func signedIn(_ user: User) async {
        sessionEndedMessage = nil
        session = .signedIn(user)
        SessionCache.save(user)
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
        // Whoever signs in next must not be greeted by the last person's
        // name while the server is being asked who they are.
        SessionCache.clear()
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

    /// The subset of those that stay on the strip above the list.
    var inboxChips: [InboxFilter] {
        InboxFilter.chips(for: entitlements.value)
    }

    /// Whether the mailbox belongs in this plan.
    ///
    /// `moduleEnabled` rather than `moduleInPlan`: the Email Inbox is off by
    /// default in the capability registry, so an absent key means "not
    /// granted" here rather than "a module this build has not heard of". An
    /// entry that opens onto a 403 is worse than no entry.
    var emailInboxVisible: Bool {
        entitlements.value?.moduleEnabled("email_inbox") == true
    }
}
