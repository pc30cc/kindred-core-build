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

    private(set) var session: SessionState = .restoring {
        didSet { scopeChanged() }
    }
    private(set) var workspaces: [Workspace] = []
    private(set) var selectedWorkspace: Workspace? {
        didSet { scopeChanged() }
    }

    /// The workspace list came from this phone's saved copy (a launch with
    /// no connection), so it is asked for again when the app comes forward.
    @ObservationIgnored private var workspacesFromSnapshot = false

    /// What the current workspace's plan grants. Every plan-gated tab and
    /// queue reads this rather than assuming.
    private(set) var entitlements: EntitlementsState = .loading

    /// The operator's role and the AI / call-center switches, read with the
    /// plan. Unknown (nil) hides whatever depends on it.
    private(set) var access: WorkspaceAccess = .unknown

    /// The operator's own profile row, for the one thing every screen wants
    /// from it: their photograph.
    ///
    /// `User` carries a name and an email and no avatar — the picture lives on
    /// `profiles` and is derived server-side from a storage key. Settings and
    /// the profile editor each fetched it for themselves; the internal chat
    /// wants it too, to put the operator's face beside their own messages the
    /// way the visitor chat does. Fetched once here instead of three times
    /// there.
    private(set) var profile: AccountProfile?

    /// The operator's own picture, wherever one is wanted.
    var myAvatarURL: String? { profile?.avatarURL }

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
            // The workspace this operator was last in, straight away, so the
            // inbox draws its saved copy while the list of workspaces is
            // still being asked for. `loadWorkspaces` then keeps it only if
            // the server still lists it.
            adoptSnapshot(for: user.id)
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
                // Offline: the workspaces this phone saw last, so the inbox
                // has something to show its saved conversations for.
                adoptSnapshot(for: cached.id)
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
        adoptSnapshot(for: user.id)
        await loadWorkspaces()
    }

    /// Signs out only on a confirmed server-side revocation. Returns false if
    /// the request failed, so the UI can say the operator is still signed in
    /// rather than showing a logged-out screen over a live session.
    func signOut() async -> Bool {
        // BEFORE the session is revoked, because `/api/push/devices/
        // unregister` is an authenticated call. Done the other way round it
        // answers 401, the device row stays enabled, and the phone keeps
        // receiving another operator's notifications until a send happens to
        // fail. Best effort, and never a reason to keep somebody signed in.
        await PushController.shared.signOut()
        do {
            try await api.logOut()
        } catch APIError.unauthorized {
            // The session was already void — the desired end state either way.
            await api.discardSession()
        } catch {
            return false
        }
        // Leaving on purpose: this account's saved conversations and files
        // leave the phone with it.
        await reset(purgeCache: true)
        return true
    }

    /// The operator deleted their own account.
    ///
    /// Not a sign-out: there is no account left to sign out of, and the
    /// server has already revoked every session including this one. So the
    /// token is simply discarded and the login screen is told why it is
    /// being looked at.
    func accountWasDeleted() async {
        await api.discardSession()
        sessionEndedMessage = Str.accountDeleted(language)
        await reset(purgeCache: true)
    }

    /// Called when any screen's request comes back 401: the session is gone,
    /// so stop pretending otherwise.
    func handleUnauthorized() async {
        guard session != .signedOut else { return }
        await api.discardSession()
        sessionEndedMessage = Str.sessionExpired(language)
        // Expired, not left: the saved copy stays for this same account's
        // next sign-in. It sits in that account's own folder, and nothing of
        // it is ever opened for anyone else.
        await reset(purgeCache: false)
    }

    private func reset(purgeCache: Bool) async {
        let leaving = session.user?.id
        session = .signedOut
        workspaces = []
        selectedWorkspace = nil
        planRefresh?.cancel()
        planRefresh = nil
        access = .unknown
        workspacesFromSnapshot = false
        entitlements = .loading
        profile = nil
        // Whoever signs in next must not be greeted by the last person's
        // name while the server is being asked who they are.
        SessionCache.clear()
        // In-memory copies of this account go at once, whatever else happens.
        await SyncCoordinator.shared.endSession(userID: leaving, purge: purgeCache)
    }

    /// Tells the sync layer who is signed in and where, the moment either
    /// changes — before the next frame is drawn for the new one.
    private func scopeChanged() {
        SyncCoordinator.shared.sessionChanged(userID: session.user?.id, workspaceID: selectedWorkspace?.id)
    }

    /// The workspaces saved for this account, if nothing better is known yet.
    private func adoptSnapshot(for userID: String) {
        guard !Backend.isSample, workspaces.isEmpty,
              let snapshot = AccountSnapshot.read(userID: userID), !snapshot.workspaces.isEmpty
        else { return }
        workspaces = snapshot.workspaces
        selectedWorkspace = snapshot.workspaces.first { $0.id == snapshot.selectedWorkspaceID } ?? snapshot.workspaces.first
        workspacesFromSnapshot = true
    }

    private func saveSnapshot() {
        guard !Backend.isSample, let userID = session.user?.id, !workspaces.isEmpty else { return }
        let snapshot = AccountSnapshot(workspaces: workspaces, selectedWorkspaceID: selectedWorkspace?.id)
        Task.detached(priority: .utility) { AccountSnapshot.write(snapshot, userID: userID) }
    }

    /// The app came forward. A launch that could only offer the saved
    /// workspaces asks the server again now that it may be reachable.
    func refreshIfStale() async {
        guard session.user != nil else { return }
        if workspacesFromSnapshot || workspaces.isEmpty { await loadWorkspaces() }
        if case .failed = entitlements, selectedWorkspace != nil { await loadPlan() }
    }

    func clearSessionEndedMessage() {
        sessionEndedMessage = nil
    }

    // MARK: - Workspaces

    /// Re-reads the operator's own profile.
    ///
    /// Called on sign-in and after the profile editor saves, so a newly
    /// uploaded photograph appears everywhere rather than only on the screen
    /// that uploaded it. A failure is not surfaced: an avatar that has not
    /// arrived yet falls back to initials, which is the same thing the app
    /// shows before the fetch finishes anyway.
    func loadProfile() async {
        profile = try? await api.account().profile
    }

    /// Takes a profile somebody else has just fetched or changed.
    ///
    /// The profile editor already has the fresh row in its hand after an
    /// upload; asking the server for it a second time would only be a slower
    /// way to learn the same thing.
    func adoptProfile(_ updated: AccountProfile?) {
        guard let updated else { return }
        profile = updated
    }

    func loadWorkspaces() async {
        do {
            await loadProfile()
            let list = try await api.workspaces()
            workspaces = list
            // Keep the current selection if it is still valid; otherwise fall
            // back to the first, so the inbox always has something to load.
            let keepsSelection = selectedWorkspace.map { current in
                list.contains { $0.id == current.id }
            } ?? false
            if !keepsSelection {
                selectedWorkspace = list.first
            } else if let current = selectedWorkspace, let fresh = list.first(where: { $0.id == current.id }), fresh != current {
                // Same workspace, newer name or logo.
                selectedWorkspace = fresh
            }
            workspacesFromSnapshot = false
            saveSnapshot()
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
        saveSnapshot()
        // A different workspace can be on a different plan, so the gates have
        // to be re-resolved before any tab decides whether it exists.
        entitlements = .loading
        access = .unknown
        Task { await loadPlan() }
    }

    // MARK: - Plan

    /// Resolves what this workspace's plan allows, and asks again later.
    ///
    /// A plan that cannot be read shows nothing gated (the server would refuse
    /// it anyway), so it is asked for again after 20 seconds; a plan in hand is
    /// refreshed every three minutes, because Super Admin can change it at any
    /// time and nothing announces it. A refresh that fails keeps the snapshot
    /// already in hand for this workspace, as the web's query does.
    ///
    /// The operator's role and the AI and call-center switches are read
    /// alongside it; one of those that cannot be read is simply off, and never
    /// fails the plan.
    func loadPlan() async {
        guard let workspaceID = selectedWorkspace?.id else {
            entitlements = .failed
            return
        }
        async let sideAccess = api.workspaceAccess(workspaceID: workspaceID)
        do {
            let snapshot = try await api.entitlements(workspaceID: workspaceID)
            let fresh = await sideAccess
            guard selectedWorkspace?.id == workspaceID else { return }
            entitlements = .loaded(snapshot)
            access = fresh
            planWorkspaceID = workspaceID
        } catch {
            let fresh = await sideAccess
            guard selectedWorkspace?.id == workspaceID else { return }
            // A kept snapshot keeps the role and switches read with it.
            if planWorkspaceID != workspaceID || entitlements.value == nil {
                entitlements = .failed
                access = fresh
            }
        }
        schedulePlanRefresh(workspaceID)
    }

    /// Which workspace the snapshot in `entitlements` belongs to.
    @ObservationIgnored private var planWorkspaceID: String? = nil
    @ObservationIgnored private var planRefresh: Task<Void, Never>? = nil

    private func schedulePlanRefresh(_ workspaceID: String) {
        planRefresh?.cancel()
        let delay: Duration = entitlements.value == nil ? .seconds(20) : .seconds(180)
        planRefresh = Task { [weak self] in
            try? await Task.sleep(for: delay)
            guard !Task.isCancelled, let self, self.selectedWorkspace?.id == workspaceID else { return }
            await self.loadPlan()
        }
    }

    // MARK: - Gates
    //
    // These follow the web console's one rule set (src/lib/planAccess.ts): a
    // capability is available only when the snapshot is in and its value is
    // exactly `true`. While it loads, or when it cannot be read, nothing gated
    // is offered; a key the snapshot does not carry is not available.

    /// Nothing plan-gated renders until the snapshot resolves one way or the
    /// other. Showing a tab and taking it away a moment later is worse than
    /// waiting for the answer.
    var planResolved: Bool { entitlements.isResolved }

    /// A top-level section belongs in this plan: only when the snapshot is in
    /// and says exactly `true`.
    func moduleInPlan(_ key: String) -> Bool {
        entitlements.value?.moduleInPlan(key) == true
    }

    /// A channel inbox from the plugin catalog (already installed, inbox-capable
    /// and `planAllowed`), as the web's `channelInboxVisible`: a channel the plan
    /// itself governs must be on in the snapshot; any other is the plugin's call.
    /// "Other inboxes" are an owner/admin surface, as in the console's sidebar.
    func channelInboxVisible(_ inbox: ChannelInbox) -> Bool {
        guard access.isAdmin else { return false }
        let key = inbox.key.lowercased()
        return !Entitlements.planChannels.contains(key) || entitlements.value?.channelEnabled(key) == true
    }

    /// Fail-closed, for a single capability rather than a whole section.
    func featureEnabled(_ key: String) -> Bool {
        entitlements.value?.featureEnabled(key) == true
    }

    var contactsVisible: Bool { moduleInPlan("contacts") }

    /// The inbox's AI queue, as the web's `aiQueueVisible`: the plan's
    /// `inbox_ai_queue`, the AI switched on and shown to customers, and either
    /// answering by itself or already holding threads (`automated`).
    func aiQueueVisible(automated: Int?) -> Bool {
        access.aiQueueVisible(inPlan: featureEnabled("inbox_ai_queue"), automated: automated)
    }

    /// The queues this plan includes, in the order they should appear.
    func inboxFilters(automated: Int?) -> [InboxFilter] {
        InboxFilter.available(for: entitlements.value, aiQueue: aiQueueVisible(automated: automated))
    }

    /// The subset of those that stay on the strip above the list.
    func inboxChips(automated: Int?) -> [InboxFilter] {
        InboxFilter.chips(aiQueue: aiQueueVisible(automated: automated))
    }

    /// Whether the internal operator-to-operator inbox belongs in this plan.
    ///
    /// Same key the console gates its Colleagues tab on.
    var colleaguesVisible: Bool { featureEnabled("inbox_team_chat") }

    /// Whether the mailbox belongs here: an owner/admin section (as in the
    /// console's sidebar) whose Email Inbox module is exactly `true`. An entry
    /// that opens onto a 403 is worse than no entry.
    var emailInboxVisible: Bool { access.isAdmin && moduleInPlan("email_inbox") }
}
