import SwiftUI
import Observation

/// Where the app is in its session lifecycle.
///
/// `restoring` exists so the first frame is never the login screen for
/// somebody who is in fact already signed in — that flash is the single most
/// noticeable way an iPhone app can look cheap.
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

    /// The session on screen came from this phone's saved copy and the server
    /// has not yet said it still stands (`resumeSavedSession()`).
    @ObservationIgnored private var savedSessionUnconfirmed = false

    /// What the current workspace's plan grants. Every plan-gated tab and
    /// queue reads this rather than assuming.
    private(set) var entitlements: EntitlementsState = .loading {
        didSet { lockChanged() }
    }

    /// The operator's role and the AI / call-center switches, read with the
    /// plan. Unknown (nil) hides whatever depends on it.
    private(set) var access: WorkspaceAccess = .unknown

    /// Which sections Super Admin has switched on for the iPhone app.
    ///
    /// Held in memory only, never in `UserDefaults`: it is the platform's
    /// setting, not this operator's, it is read again on every sign-in and
    /// every return to the foreground, and nothing about it is worth keeping
    /// on the phone. Until it arrives — and whenever it cannot be read — it
    /// is the last answer, which starts as everything on: an unreachable
    /// server must not strip sections out of the app.
    private(set) var appConfig: MobileAppConfig = .defaults

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
            // The operator's choice is kept; the platform's default is only
            // used until they make one (`adoptPublicConfig`).
            if persistsLanguage {
                UserDefaults.standard.set(language.rawValue, forKey: Self.languageKey)
            }
            // Before SwiftUI has even been told, so the window and the
            // interface turn together rather than one frame apart.
            WindowDirection.apply(language)
            // And the type, for the same reason: the rebuilt interface is
            // drawn in the new language's typeface from its first frame.
            Typeface.use(language)
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
    /// you were last time you had the app open is not a preference. Signing
    /// in or out puts it back on the Inbox.
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
    /// The language Super Admin chose for the iOS app, as last read: the
    /// first frame of the next launch is already in it.
    private static let platformLanguageKey = "app.platformDefaultLanguage"
    private static let privacyPolicyKey = "app.privacyPolicyURL"
    private static let termsKey = "app.termsURL"

    /// The privacy policy and terms of use, as the platform last named them
    /// before sign-in — remembered, so the sign-in screen links them from its
    /// first frame and without a connection.
    private(set) var legalLinks = LegalLinks(
        privacyPolicy: LegalLinks.https(UserDefaults.standard.string(forKey: AppState.privacyPolicyKey)),
        terms: LegalLinks.https(UserDefaults.standard.string(forKey: AppState.termsKey))
    )
    /// False while the platform's default is being applied, which is not the
    /// operator choosing a language.
    @ObservationIgnored private var persistsLanguage = true
    private static let appearanceKey = "app.appearance"
    private let api: any WebyarAPI

    init(api: any WebyarAPI = Backend.current) {
        self.api = api
        self.language = Self.storedLanguage()

        let storedAppearance = UserDefaults.standard.string(forKey: Self.appearanceKey)
        self.appearance = storedAppearance.flatMap(AppearancePreference.init(rawValue:)) ?? .system

        // `didSet` does not run for the initial value, and this is before the
        // first frame — the Persian font is registered and chosen here or
        // not at all.
        Typeface.use(language)
    }

    // MARK: - Language

    /// The language as this phone has it stored: the operator's choice, else
    /// the platform's default as last read, else the build's. What `language`
    /// starts as — and, since every change of it is stored at once, what it
    /// is now, for the one part of the app that runs without a scene and so
    /// without this object: a colleague's ring, which can launch the app on
    /// the lock screen and has to name the caller there (`CallManager`).
    static func storedLanguage() -> Language {
        let chosen = LanguageChoice.starting(
            stored: UserDefaults.standard.string(forKey: languageKey),
            platformDefault: UserDefaults.standard.string(forKey: platformLanguageKey),
            compiled: AppBrand.defaultLanguage
        )
        #if DEBUG
        return LanguageOverride.current ?? chosen
        #else
        return chosen
        #endif
    }

    /// What the platform says before sign-in: the privacy policy and terms,
    /// and the language Super Admin chose for the iOS app — switched to when
    /// the operator has not picked one of their own. True when the language
    /// changed — the interface is rebuilt in it.
    @discardableResult
    func adoptPublicConfig() async -> Bool {
        guard let config = await api.mobilePublicConfig() else { return false }
        rememberLegalLinks(config.legal)
        guard let platformDefault = config.defaultLanguage else { return false }
        UserDefaults.standard.set(platformDefault.rawValue, forKey: Self.platformLanguageKey)
        #if DEBUG
        // A screenshot run names its language; the platform does not move it.
        if LanguageOverride.current != nil { return false }
        #endif
        let hasChosen = UserDefaults.standard.string(forKey: Self.languageKey) != nil
        guard let next = LanguageChoice.adopt(platformDefault: platformDefault, hasChosen: hasChosen, current: language)
        else { return false }
        persistsLanguage = false
        language = next
        persistsLanguage = true
        return true
    }

    private func rememberLegalLinks(_ links: LegalLinks) {
        legalLinks = links
        for (key, url) in [(Self.privacyPolicyKey, links.privacyPolicy), (Self.termsKey, links.terms)] {
            if let url {
                UserDefaults.standard.set(url.absoluteString, forKey: key)
            } else {
                UserDefaults.standard.removeObject(forKey: key)
            }
        }
    }

    // MARK: - Session

    /// Restores a stored session at launch. A transport failure leaves the
    /// operator signed in with whatever is cached — only the server saying the
    /// session is void signs them out.
    func restore() async {
        if savedSessionUnconfirmed {
            await confirmSavedSession()
            return
        }
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

    /// A returning operator, straight into the app from this phone's saved
    /// copy — the account last seen here and its workspaces — without waiting
    /// for the server.
    ///
    /// The launch loader used to stay up until three requests had come back
    /// one after another: where the API is (up to 8 s), the public config
    /// (4 s) and who the token belongs to (20 s). On a good connection that
    /// is a second or two; on a slow or flaky one it was half a minute of a
    /// spinner in front of an inbox the phone already had. `restore()` asks
    /// the server afterwards, and only a `401` ends the session.
    ///
    /// Nothing to resume on a first launch, after a sign-out, or when the
    /// app was reinstalled (the token outlives the app in the Keychain, the
    /// saved account does not): those still wait, as they must, to learn
    /// whether there is anybody to show.
    func resumeSavedSession() async {
        guard case .restoring = session, !Backend.isSample,
              await api.hasToken, let saved = SessionCache.read()
        else { return }
        savedSessionUnconfirmed = true
        session = .signedIn(saved)
        adoptSnapshot(for: saved.id)
    }

    /// The server's word on a session `resumeSavedSession()` put on screen.
    private func confirmSavedSession() async {
        savedSessionUnconfirmed = false
        guard let shown = session.user else { return }
        do {
            let user = try await api.currentUser()
            guard session.user?.id == shown.id else { return }
            guard user.id == shown.id else {
                // The token belongs to somebody else than the saved account:
                // nothing of the saved one may stay on screen.
                await reset(purgeCache: false)
                await signedIn(user)
                return
            }
            session = .signedIn(user)
            SessionCache.save(user)
            await loadWorkspaces()
        } catch APIError.unauthorized {
            guard session.user?.id == shown.id else { return }
            await handleUnauthorized()
        } catch {
            // Offline, as in `restore()`: the saved copy stays, and the next
            // request that gets an answer settles it.
            await loadWorkspaces()
        }
    }

    func signedIn(_ user: User) async {
        sessionEndedMessage = nil
        // A sign-in opens on the Inbox. The tab was the last one shown, and
        // the last one shown before signing out is Settings, where the
        // sign-out and the account deletion are.
        selectedTab = .inbox
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
        //
        // A colleague call still on (minimised, so Sign out was reachable) is
        // ended first, with the server told while the session can still
        // tell it: the colleague's phones stop ringing.
        await CallManager.shared.endForSignOut()
        await PushController.shared.signOut()
        do {
            try await api.logOut()
        } catch APIError.unauthorized {
            // The session was already void — the desired end state either way.
            await api.discardSession()
        } catch {
            // Still signed in, so this phone is still where their
            // notifications go: register it again.
            await PushController.shared.sessionChanged(signedIn: true, workspaceID: selectedWorkspace?.id)
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
        PushController.shared.sessionEnded()
        await api.discardSession()
        sessionEndedMessage = Str.accountDeleted(language)
        await reset(purgeCache: true)
    }

    /// Called when any screen's request comes back 401: the session is gone,
    /// so stop pretending otherwise.
    func handleUnauthorized() async {
        guard session != .signedOut else { return }
        // The phone stops receiving this account's notifications with the
        // session, not whenever a send next happens to fail.
        PushController.shared.sessionEnded()
        await api.discardSession()
        sessionEndedMessage = Str.sessionExpired(language)
        // Expired, not left: the saved copy stays for this same account's
        // next sign-in. It sits in that account's own folder, and nothing of
        // it is ever opened for anyone else.
        await reset(purgeCache: false)
    }

    private func reset(purgeCache: Bool) async {
        let leaving = session.user?.id
        // Whoever signs in next agrees to "Send with AI" for themselves.
        AIConsent.reset()
        session = .signedOut
        // Whoever signs in next starts on the Inbox, not on the Settings
        // screen this session was left from.
        selectedTab = .inbox
        workspaces = []
        selectedWorkspace = nil
        planRefresh?.cancel()
        planRefresh = nil
        access = .unknown
        appConfig = .defaults
        workspacesFromSnapshot = false
        savedSessionUnconfirmed = false
        entitlements = .loading
        // The next session learns its plans afresh.
        MobileAppLock.clear()
        profile = nil
        // Whoever signs in next must not be greeted by the last person's
        // name while the server is being asked who they are.
        SessionCache.clear()
        // A colleague call cannot outlive the session it was made in.
        CallManager.shared.sessionEnded()
        // In-memory copies of this account go at once, whatever else happens.
        await SyncCoordinator.shared.endSession(userID: leaving, purge: purgeCache)
    }

    /// Tells the sync layer who is signed in and where, the moment either
    /// changes — before the next frame is drawn for the new one.
    private func scopeChanged() {
        SyncCoordinator.shared.sessionChanged(userID: session.user?.id, workspaceID: selectedWorkspace?.id)
        lockChanged()
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
        // Not gated on staleness: Super Admin can switch a section off at any
        // time, and coming back to the app is the natural moment to notice.
        Task { await loadAppConfig() }
        if workspacesFromSnapshot || workspaces.isEmpty {
            // Reads the plan too, once the list is in.
            await loadWorkspaces()
        } else if selectedWorkspace != nil {
            // The plan again, whether or not the last read failed: the mobile
            // app can have been switched on or off in it meanwhile
            // (docs/operations/MOBILE_APP_PLAN.md). A failed read keeps the
            // snapshot in hand.
            await loadPlan(readsAppConfig: false)
        }
        // And the other workspaces this phone remembers as locked, which are
        // read nowhere else until one is opened: a plan switched back on
        // there must not go on ending its colleagues' rings here.
        for workspaceID in MobileAppLock.lockedWorkspaceIDs() where workspaceID != selectedWorkspace?.id {
            Task { [api] in _ = await MobileAppLock.recheck(workspaceID: workspaceID, api: api) }
        }
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
    /// arrived yet shows the skeleton's silhouette, which is the same thing
    /// the app shows before the fetch finishes anyway.
    ///
    /// Whose profile is decided before the request goes out: an answer that
    /// lands after a sign-out, or after somebody else signed in, belongs to
    /// nobody on screen and is dropped rather than shown as theirs.
    func loadProfile() async {
        guard let userID = session.user?.id else { return }
        let fetched = try? await api.account().profile
        guard session.user?.id == userID else { return }
        profile = fetched
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
        // As with the profile: a list that arrives for an account that is no
        // longer the one signed in must not become the new account's list —
        // or, after a sign-out, bring a workspace back onto a login screen.
        guard let userID = session.user?.id else { return }
        do {
            await loadProfile()
            let list = try await api.workspaces()
            guard session.user?.id == userID else { return }
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
            guard session.user?.id == userID else { return }
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
    func loadPlan(readsAppConfig: Bool = true) async {
        // Alongside, never in front: the plan decides most of what shows,
        // and waiting on a second request to resolve it would only delay the
        // tab bar.
        if readsAppConfig { Task { await loadAppConfig() } }
        guard let workspaceID = selectedWorkspace?.id else {
            entitlements = .failed
            return
        }
        async let sideAccess = api.workspaceAccess(workspaceID: workspaceID)
        do {
            let snapshot = try await api.entitlements(workspaceID: workspaceID)
            let fresh = await sideAccess
            guard selectedWorkspace?.id == workspaceID else { return }
            // Before the snapshot is adopted, so the lock it may bring finds
            // the role read with it (who is the owner) already in place.
            access = fresh
            planWorkspaceID = workspaceID
            // What this read said about the mobile app, for the ring and the
            // notification that arrive without this object (`MobileAppLock`).
            MobileAppLock.record(workspaceID: workspaceID, locked: snapshot.mobileAppLocked)
            entitlements = .loaded(snapshot)
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

    /// Reads the Super Admin switches for this app.
    ///
    /// An answer that lands after the operator signed out, or after somebody
    /// else signed in, is dropped. A failure keeps what is already known —
    /// and says nothing: the switches are a ceiling on sections that the
    /// plan still has to grant, so the worst a missed read can do is leave a
    /// section on for one more refresh.
    func loadAppConfig() async {
        guard let userID = session.user?.id else { return }
        guard let fresh = try? await api.mobileAppConfig(), session.user?.id == userID else { return }
        if fresh != appConfig { appConfig = fresh }
    }

    /// Which workspace the snapshot in `entitlements` belongs to.
    ///
    /// Observed, like `entitlements`: the lock (`isAppLocked`) reads both,
    /// and a view that last read it while this still named another
    /// workspace must hear when it moves on, or the lock never shows.
    private var planWorkspaceID: String? = nil
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

    // MARK: - The mobile app off in the plan

    /// The workspace on screen has the mobile app switched off in its plan
    /// (docs/operations/MOBILE_APP_PLAN.md): the app is drawn faded under one
    /// card and nothing in it works (`SignedInRoot`).
    ///
    /// Fail-open, unlike every gate below: only a snapshot of this
    /// workspace's plan in hand that says exactly `false` locks. While it
    /// loads, when it cannot be read, and when it does not carry the key, the
    /// app works — a network blip must not lock a whole team out. Read again
    /// at sign-in, on a workspace switch, on coming back to the foreground
    /// and on every refresh of the plan.
    var isAppLocked: Bool {
        guard session.user != nil, let workspaceID = selectedWorkspace?.id else { return false }
        // This workspace's own snapshot: the one in hand can still be the
        // last workspace's for a moment after the selection moved on (the
        // list lost the workspace that was open), and that one's lock is not
        // this one's.
        // Both read every time, never one short-circuited behind the other:
        // SwiftUI follows only what was read, and a lock whose plan was
        // skipped would never be redrawn when the plan arrives.
        let planLocked = entitlements.mobileAppLocked
        let planIsThisWorkspace = planWorkspaceID == workspaceID
        return planIsThisWorkspace && planLocked
    }

    /// The lock last handed to the sync layer and the notifications.
    @ObservationIgnored private var appliedLock = false

    /// While locked the app stops its own work for the workspace — realtime
    /// and upkeep here; the screens that poll are not on screen — and a
    /// tapped notification does nothing. The push device stays registered:
    /// the server decides what to send to a locked workspace's phones.
    private func lockChanged() {
        let locked = isAppLocked
        guard locked != appliedLock else { return }
        appliedLock = locked
        SyncCoordinator.shared.setSuspended(locked)
        PushController.shared.appLocked = locked
    }

    /// The member is the workspace's owner, as read with the plan: the lock
    /// card asks everybody else to contact them.
    var isWorkspaceOwner: Bool { access.role == "owner" }

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

    /// Contacts: in the plan, and not switched off for the iPhone app.
    var contactsVisible: Bool { appConfig.showContacts && moduleInPlan("contacts") }

    /// Online visitors: the plan's `visitor_tracking`, as the web's sidebar
    /// and the desktop apps gate it, under the Super Admin switch.
    var visitorsVisible: Bool { appConfig.showVisitors && moduleInPlan("visitor_tracking") }

    /// Website analytics: owners and admins, when the plan has the module —
    /// the web sidebar's rule — under the Super Admin switch.
    var webAnalyticsVisible: Bool {
        appConfig.showWebAnalytics && access.isAdmin && moduleInPlan("web_analytics")
    }

    /// The inbox's AI queue, as the web's `aiQueueVisible`: the plan's
    /// `inbox_ai_queue`, the AI switched on and shown to customers, and either
    /// answering by itself or already holding threads (`automated`) — under
    /// the Super Admin switch, which takes it off the strip and the menu both.
    func aiQueueVisible(automated: Int?) -> Bool {
        appConfig.showAIQueue
            && access.aiQueueVisible(inPlan: featureEnabled("inbox_ai_queue"), automated: automated)
    }

    /// The queues this plan includes, in the order they should appear.
    func inboxFilters(automated: Int?) -> [InboxFilter] {
        InboxFilter.available(for: entitlements.value, aiQueue: aiQueueVisible(automated: automated))
    }

    /// The subset of those that stay on the strip above the list.
    func inboxChips(automated: Int?) -> [InboxFilter] {
        InboxFilter.chips(aiQueue: aiQueueVisible(automated: automated))
    }

    /// The strip above the inbox list: its queues, then Colleagues.
    func inboxStrip(automated: Int?) -> [InboxStripItem] {
        InboxStripItem.strip(chips: inboxChips(automated: automated), colleagues: colleaguesVisible)
    }

    /// Whether the internal operator-to-operator inbox belongs here: the key
    /// the console gates its Colleagues tab on, under the Super Admin switch.
    var colleaguesVisible: Bool { appConfig.showColleagues && featureEnabled("inbox_team_chat") }

    /// Whether a colleague's thread offers this kind of call
    /// (`Entitlements.allowsTeamCall`). Follows the plan as it refreshes, so
    /// a plan switched on or off in Super Admin shows or hides the buttons
    /// by itself; the platform's and the workspace's own voice and video
    /// switches are the server's to apply when the call is placed.
    func teamCallAllowed(_ channel: CallChannel) -> Bool {
        entitlements.value?.allowsTeamCall(channel) == true
    }

    /// Whether Settings shows Storage. Super Admin's switch alone: it is not
    /// a plan feature, and hiding it leaves the cache working as before.
    var storageVisible: Bool { appConfig.showStorage }
    /// Super Admin's switch for Settings → Online support. The row also
    /// needs the server to offer support (`SupportStatus.shown`).
    var supportAllowed: Bool { appConfig.showSupport }

    /// Where Support opens: the link Super Admin set for the app (Mobile App
    /// → iOS → In-app settings, falling back server-side to the App Store
    /// support URL), else the platform's own help centre.
    var supportURL: URL? { appConfig.supportURL ?? PlatformOrigin.supportURL }

    /// The website link at the foot of Settings: the address Super Admin set (Mobile App →
    /// iOS → In-app settings), else the platform's public site, else — on a
    /// phone that has never heard from the platform — the help centre.
    var websiteURL: URL? { appConfig.websiteURL ?? PlatformOrigin.websiteURL ?? PlatformOrigin.supportURL }

    /// What that row is called: Super Admin's name for it in this language,
    /// else the app's own word.
    var websiteLabel: String { appConfig.websiteName(language) ?? SettingsStr.website(language) }

    /// The website row's link in the language on screen (WebYar: `/en`, `/tr`,
    /// `/ar`, Persian at the root; RESPOK as configured), `SiteLinks`.
    var siteWebsiteURL: URL? { SiteLinks.website(siteRoot ?? websiteURL, language: language) }

    /// The site the language-following links are built on: the website link Super Admin
    /// set (known after sign-in), else the brand's canonical site from the platform's
    /// origins (known before it). Never the panel's public address: before sign-in that
    /// is the app's own host, whose pages need an account.
    private var siteRoot: URL? { appConfig.websiteURL ?? PlatformOrigin.siteURL }

    /// The privacy policy and the terms in the language on screen, on the
    /// site the website link names (WebYar); RESPOK's as configured.
    var siteLegalLinks: LegalLinks { SiteLinks.legal(legalLinks, website: siteRoot, language: language) }

    /// The sign-in screen's website link (docs/operations/MOBILE_APP_PLAN.md,
    /// "The sign-in screen's site address"): the Settings website row's name
    /// — the word, never the address — opening the brand's site in the
    /// language on screen. None when no site is known.
    var signInWebsiteLink: WebsiteLink? {
        siteWebsiteURL.map { WebsiteLink(title: websiteLabel, url: $0) }
    }

    /// Whether the mailbox belongs here: an owner/admin section (as in the
    /// console's sidebar) whose Email Inbox module is exactly `true`. An entry
    /// that opens onto a 403 is worse than no entry.
    var emailInboxVisible: Bool { access.isAdmin && moduleInPlan("email_inbox") }
}

/// A link shown by its name (`AppState.signInWebsiteLink`).
struct WebsiteLink: Equatable, Sendable {
    let title: String
    let url: URL
}
