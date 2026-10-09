package com.webyar.ai.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.webyar.ai.core.model.EntitlementsState
import com.webyar.ai.core.model.MaintenanceNotice
import com.webyar.ai.core.model.MobileAppConfig
import com.webyar.ai.core.model.WorkspaceAccess
import com.webyar.ai.core.model.User
import com.webyar.ai.core.model.Workspace
import com.webyar.ai.core.net.ApiError
import com.webyar.ai.core.net.WebyarApi
import com.webyar.ai.core.push.IncomingCallLink
import com.webyar.ai.core.push.PushPayload
import com.webyar.ai.core.storage.Appearance
import com.webyar.ai.core.storage.Preferences
import com.webyar.ai.core.storage.SessionCache
import com.webyar.ai.i18n.Language
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull

/**
 * Whether anyone is signed in, and who.
 *
 * `Restoring` is a state of its own rather than "not signed in yet". A cold
 * launch cannot confirm a session without asking the server, and on a train or
 * in a lift that question goes unanswered — so treating unknown as signed-out
 * would show the login screen to somebody who is signed in. The app holds
 * here, then falls back to the cached user if the token is present.
 */
sealed interface Session {
    data object Restoring : Session
    data object SignedOut : Session
    data class SignedIn(val user: User) : Session
}

class AppState(
    private val api: WebyarApi,
    private val cache: SessionCache,
    private val prefs: Preferences,
    private val hooks: SessionHooks = SessionHooks.None,
) : ViewModel() {

    private val _session = MutableStateFlow<Session>(Session.Restoring)
    val session: StateFlow<Session> = _session.asStateFlow()

    private val _language = MutableStateFlow(Language.DEFAULT)
    val language: StateFlow<Language> = _language.asStateFlow()

    private val _appearance = MutableStateFlow(Appearance.SYSTEM)
    val appearance: StateFlow<Appearance> = _appearance.asStateFlow()

    /**
     * Whether [appearance] is the operator's stored choice yet, rather than
     * the default it starts on. Nothing should tell the system "follow the
     * phone" in the moment before the choice is read, only to say "dark" a
     * moment later.
     */
    private val _appearanceLoaded = MutableStateFlow(false)
    val appearanceLoaded: StateFlow<Boolean> = _appearanceLoaded.asStateFlow()

    /**
     * Super Admin's switches for this app — which Settings sections show,
     * what the profile lets an operator change. See [MobileAppConfig].
     */
    private val _appConfig = MutableStateFlow(MobileAppConfig.DEFAULT)
    val appConfig: StateFlow<MobileAppConfig> = _appConfig.asStateFlow()

    /** The operator's own choice, kept even while Super Admin disallows it. */
    private val _dynamicColor = MutableStateFlow(false)

    /** Set once the operator has chosen in this run; the stored value then never overwrites it. */
    private var dynamicColorChosen = false

    /** Set once the server has answered in this run; the stored copy then never overwrites it. */
    private var appConfigFromServer = false

    /**
     * Whether the operator has picked a language on this phone. Until they
     * have, the app speaks Super Admin's default ([MobileAppConfig.defaultLanguage],
     * the brand's own [Language.DEFAULT] when the server names none: Persian
     * for WebYar, English for RESPOK); after, their choice is the only one
     * that counts.
     */
    private var languageChosen = false

    /**
     * Super Admin's maintenance notice while it is on, else null. Only ever
     * from a live answer: a notice kept from an earlier launch could lock an
     * operator out of a platform that has long been back.
     */
    private val _maintenance = MutableStateFlow<MaintenanceNotice?>(null)
    val maintenance: StateFlow<MaintenanceNotice?> = _maintenance.asStateFlow()

    /** A maintenance check on its way — the notice's Try again shows it. */
    private val _checkingPlatform = MutableStateFlow(false)
    val checkingPlatform: StateFlow<Boolean> = _checkingPlatform.asStateFlow()

    /**
     * Wallpaper colours instead of the brand's — see [Preferences.dynamicColor].
     *
     * The operator's choice, and only while the platform allows it: turned
     * off in Super Admin, every phone goes back to the brand colours, and
     * turned on again, each operator gets back whatever they had chosen.
     */
    val dynamicColor: StateFlow<Boolean> = combine(_dynamicColor, _appConfig) { chosen, config ->
        chosen && config.allowWallpaperColors
    }.stateIn(viewModelScope, SharingStarted.Eagerly, false)

    private val _workspaces = MutableStateFlow<List<Workspace>>(emptyList())
    val workspaces: StateFlow<List<Workspace>> = _workspaces.asStateFlow()

    /**
     * The operator's own picture.
     *
     * Separate from [session] because the login response's `user` has no
     * avatar in it — `GET /api/account/me` is the only endpoint that carries
     * one. Without it, an operator who has set a photo on the web sees only
     * their initials on the phone.
     */
    private val _avatarUrl = MutableStateFlow<String?>(null)
    val avatarUrl: StateFlow<String?> = _avatarUrl.asStateFlow()

    private val _selectedWorkspace = MutableStateFlow<Workspace?>(null)
    val selectedWorkspace: StateFlow<Workspace?> = _selectedWorkspace.asStateFlow()

    private val _entitlements = MutableStateFlow<EntitlementsState>(EntitlementsState.Loading)
    val entitlements: StateFlow<EntitlementsState> = _entitlements.asStateFlow()

    /**
     * The operator's role and the AI / call-center switches, read with the
     * plan. Unknown (null) hides whatever depends on it.
     */
    private val _access = MutableStateFlow(WorkspaceAccess.UNKNOWN)
    val access: StateFlow<WorkspaceAccess> = _access.asStateFlow()

    /**
     * Which tab is open, held here rather than in the shell.
     *
     * A language change rebuilds the shell from scratch. Without somewhere
     * outside to keep this, changing the language would drop the operator back
     * on the inbox from wherever they were.
     */
    private val _selectedTab = MutableStateFlow(AppTab.INBOX)
    val selectedTab: StateFlow<AppTab> = _selectedTab.asStateFlow()

    /**
     * The tabs this account actually has — [appTabsFor] over the plan, the
     * operator's role and Super Admin's switches for the Android app.
     */
    val tabs: StateFlow<List<AppTab>> = combine(entitlements, access, appConfig, ::appTabsFor)
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), listOf(AppTab.INBOX, AppTab.SETTINGS))

    fun selectTab(tab: AppTab) {
        _selectedTab.value = tab
    }

    /**
     * A conversation — or a colleague's team thread — a notification asked
     * to open, until the shell opens it.
     *
     * Held here rather than acted on where the tap arrived: the tap can come
     * before the session is restored or the workspaces are loaded, and the
     * workspace it names has to be checked against THIS operator's before
     * anything is shown.
     */
    private val _pendingLink = MutableStateFlow<PushPayload?>(null)
    val pendingLink: StateFlow<PushPayload?> = _pendingLink.asStateFlow()

    /** A ringing call the operator asked to see or answer, until the shell opens it. */
    private val _pendingCall = MutableStateFlow<IncomingCallLink?>(null)
    val pendingCall: StateFlow<IncomingCallLink?> = _pendingCall.asStateFlow()

    fun openIncomingCall(link: IncomingCallLink) {
        _pendingCall.value = link
    }

    /**
     * The call, once it can be opened: signed in, the workspaces known, and
     * the one it rang for among them — switched to if it is not in front.
     * One this operator has no part in is dropped.
     */
    fun resolvePendingCall(): IncomingCallLink? {
        val link = _pendingCall.value ?: return null
        if (_session.value !is Session.SignedIn) return null
        val list = _workspaces.value
        if (list.isEmpty()) return null
        val target = list.firstOrNull { it.id == link.workspaceId }
        _pendingCall.value = null
        if (target == null) return null
        if (target.id != _selectedWorkspace.value?.id) selectWorkspace(target)
        return link
    }

    fun openFromNotification(link: PushPayload) {
        if (link.opensSomething) _pendingLink.value = link
    }

    /**
     * The link, once it can be followed: signed in, the workspaces known,
     * and the one it names among them — switched to if it is not the one in
     * front. A link to a workspace this operator does not have is dropped.
     */
    fun resolvePendingLink(): PushPayload? {
        val link = _pendingLink.value ?: return null
        if (_session.value !is Session.SignedIn) return null
        val list = _workspaces.value
        if (list.isEmpty()) return null
        val target = list.firstOrNull { it.id == link.workspaceId }
        _pendingLink.value = null
        if (target == null) return null
        if (target.id != _selectedWorkspace.value?.id) selectWorkspace(target)
        return link
    }

    init {
        // A session revoked elsewhere — the web's "sign out everywhere", an
        // admin removing this operator — reaches here as the first 401 and is
        // handled once; otherwise every screen shows its own error, the socket
        // keeps retrying, and the operator has to find Sign out.
        viewModelScope.launch { api.sessionLost.collect { onSessionLost() } }
        viewModelScope.launch {
            // Before restore(), so the login screen is already in the right
            // language and the right way round rather than flipping once the
            // preference arrives.
            val storedLanguage = prefs.language()
            val storedConfig = prefs.appConfig()
            if (storedLanguage != null) {
                languageChosen = true
                _language.value = storedLanguage
            } else if (!languageChosen) {
                // Nobody has picked one: the platform's default, as the last
                // answer named it, so a launch does not start in Persian and
                // turn English a moment later.
                Language.from(storedConfig.defaultLanguage)?.let { _language.value = it }
            }
            hooks.languageChanged(_language.value)
            _appearance.value = prefs.appearance()
            _appearanceLoaded.value = true
            // Stored values arrive from DataStore's own threads, possibly
            // after the operator has already chosen (or the server already
            // answered). The later, fresher value wins; the stored one only
            // fills in what nothing newer has set.
            val storedDynamic = prefs.dynamicColor()
            if (!dynamicColorChosen) _dynamicColor.value = storedDynamic
            if (!appConfigFromServer) _appConfig.value = storedConfig
            // Alongside the session, not before it: the sign-in screen needs
            // to know whether the platform is down, and the language it
            // starts in; neither is worth holding the launch for.
            checkPlatform()
            restore()
        }
    }

    fun setLanguage(language: Language) {
        languageChosen = true
        _language.value = language
        hooks.languageChanged(language)
        viewModelScope.launch {
            // A write that fails (a full disk) costs the choice at the next
            // launch, not the app now: nothing handles an exception thrown in
            // this scope, so it would end the process.
            runCatching { prefs.setLanguage(language) }
            // Tell the server too, so the console and the emails this operator
            // receives agree with the app in their hand. A failure here is not
            // worth surfacing: the app is already in the new language, and the
            // next successful save will carry it.
            runCatching { api.updateProfile(fullName = null, preferredLocale = language.code) }
        }
    }

    fun setAppearance(appearance: Appearance) {
        _appearance.value = appearance
        _appearanceLoaded.value = true
        // Caught, as the language's is: a failed write is not worth the app.
        viewModelScope.launch { runCatching { prefs.setAppearance(appearance) } }
    }

    fun setDynamicColor(on: Boolean) {
        dynamicColorChosen = true
        _dynamicColor.value = on
        viewModelScope.launch { runCatching { prefs.setDynamicColor(on) } }
    }

    /**
     * Asks the platform where it lives, then whether this token still names a
     * session.
     *
     * A transport failure is NOT a logout: the token is still stored, so the
     * cached user stands in and every screen will discover otherwise the
     * moment a request comes back 401. Only an actual 401 signs anyone out.
     */
    private suspend fun restore() {
        // A sign-out the process did not live to finish.
        prefs.pendingSignOut()?.let { pending ->
            withContext(NonCancellable) {
                runCatching { hooks.signedOut(pending.ifEmpty { null }) }
                runCatching { prefs.setPendingSignOut(null) }
            }
        }
        if (!api.hasToken()) {
            // No token, yet an operator is remembered: their session ended
            // without this phone signing them out — the Keystore key that
            // sealed the token is gone (an OS update does that on some
            // devices), or the token never reached the disk (a full one).
            // Nothing cleaned up after them then, so it is done now, exactly
            // as at a sign-out: their notifications left in the tray, their
            // cached rows and files, and their push registration — which
            // would otherwise go on drawing their customers' messages on a
            // phone somebody else signs in to. A tap on one of those
            // notifications, already waiting to be followed, goes with them.
            val stale = cache.read()
            if (stale != null) {
                withContext(NonCancellable) { endSession(stale.id) }
            } else {
                _session.value = Session.SignedOut
            }
            // Where the platform lives is asked behind the sign-in screen,
            // not in front of it: on a connection that hangs rather than
            // fails, that one request would hold the loader up for its whole
            // timeout before anyone could type. logIn() waits for it.
            refreshOriginInBackground()
            return
        }
        // Local first, as the inbox itself is: the operator this phone
        // remembers opens straight onto their cached inbox, and the server's
        // word on the session follows. Asking first — the origin, then the
        // account, each allowed its full timeout — would hold the loader for
        // up to forty seconds on a connection that hangs, before the very
        // same cached inbox appeared. A session the server has ended still
        // ends, the moment it says so.
        cache.read()?.let { cached ->
            recallWorkspace(cached.id)
            hooks.signedIn(cached)
            _session.value = Session.SignedIn(cached)
            loadWorkspaces()
            val epoch = sessionEpoch
            viewModelScope.launch { confirmSession(cached, epoch) }
            return
        }
        // A token and nobody remembered (a cache cleared under it): nothing
        // to show until the server says who this is.
        runCatching { api.refreshOrigin() }
        try {
            val user = api.currentUser()
            cache.save(user)
            recallWorkspace(user.id)
            hooks.signedIn(user)
            _session.value = Session.SignedIn(user)
            loadWorkspaces()
            loadAppConfig()
        } catch (e: ApiError) {
            if (e.isAuthFailure) {
                val stale = cache.read()
                api.discardSession()
                // The session was revoked elsewhere: whatever this phone
                // cached for it goes, exactly as at a sign-out.
                withContext(NonCancellable) { endSession(stale?.id) }
            } else {
                val cached = cache.read()
                cached?.let { recallWorkspace(it.id) }
                // Offline at launch: the cached operator stands in, and so
                // does their cache — which is the whole point of having one.
                cached?.let(hooks::signedIn)
                _session.value = if (cached != null) Session.SignedIn(cached) else Session.SignedOut
                if (cached != null) loadWorkspaces()
            }
        }
    }

    /**
     * Which session is current: moved on by every sign-in and every end of
     * a session, so a late answer about an earlier one can tell it is late
     * even when the same operator has signed in again since.
     */
    private var sessionEpoch = 0

    /** The signed-out launch's question of where the platform lives; see [logIn]. */
    private var originJob: Job? = null

    private fun refreshOriginInBackground() {
        originJob = viewModelScope.launch { runCatching { api.refreshOrigin() } }
    }

    private fun isStill(epoch: Int, userId: String): Boolean =
        epoch == sessionEpoch && (_session.value as? Session.SignedIn)?.user?.id == userId

    /**
     * The server's word on the session [restore] opened from the cache.
     *
     * Only a 401 ends it, as everywhere: offline, or with the server down,
     * the cached operator stays with their cache, which is what it is for.
     * An answer is applied only to the session it was asked about ([epoch])
     * — an operator who signed out, or signed in again, while it was on its
     * way is not touched by it.
     */
    private suspend fun confirmSession(cached: User, epoch: Int) {
        runCatching { api.refreshOrigin() }
        val user = try {
            api.currentUser()
        } catch (e: CancellationException) {
            throw e
        } catch (e: ApiError) {
            if (e.isAuthFailure && isStill(epoch, cached.id)) {
                api.discardSession()
                // Revoked elsewhere: whatever this phone cached for it goes,
                // exactly as at a sign-out.
                withContext(NonCancellable) { endSession(cached.id) }
            }
            return
        }
        if (!isStill(epoch, cached.id)) return
        if (user.id != cached.id) {
            // The token names somebody other than the operator remembered —
            // nothing of the one on screen may stay for the other.
            withContext(NonCancellable) { endSession(cached.id) }
            runCatching { cache.save(user) }
            recallWorkspace(user.id)
            hooks.signedIn(user)
            _session.value = Session.SignedIn(user)
            loadWorkspaces()
            loadAppConfig()
            return
        }
        runCatching { cache.save(user) }
        hooks.signedIn(user)
        // The same person, perhaps renamed on the web since: the header
        // follows. Keyed by id, so nothing on screen is rebuilt.
        if (user != cached) _session.value = Session.SignedIn(user)
        // The cached launch asked for the workspaces before the origin was
        // confirmed; asked again, from the right place, if that found none.
        if (_workspaces.value.isEmpty()) loadWorkspaces()
        loadAppConfig()
    }

    /**
     * Sign in, and then get out of the caller's coroutine scope.
     *
     * The line that sets [_session] is also the line that replaces the login
     * screen with the app — and the login screen's `rememberCoroutineScope`
     * dies with it. Anything still running in that scope is cancelled on the
     * spot; a workspace load caught there fails with
     *
     *     REQUEST /api/workspaces failed with exception:
     *     ForgottenCoroutineScopeException: rememberCoroutineScope left the
     *     composition
     *
     * and a fresh sign-in reaches an app with no workspace, and therefore no
     * entitlements, no Contacts tab, no AI queues and no conversations — an
     * app that looks empty rather than broken, silently, because
     * [loadWorkspaces] swallows its failures. A restored session is not
     * affected: that path runs in `viewModelScope` already.
     *
     * So the load is handed to [viewModelScope], which outlives every screen.
     * The caller learns only whether the credentials were good, which is all
     * it asked.
     */
    suspend fun logIn(email: String, password: String): Result<Unit> = runCatching {
        // Nobody signs in while the platform is down for maintenance. Asked
        // afresh rather than read from the last answer, which can be a
        // minute old either way; a check that cannot be made does not stop
        // anyone — the server is the one that knows.
        checkPlatform().join()
        if (_maintenance.value != null) throw ApiError.Server(503, "maintenance")
        // The credentials go where the platform now lives: the launch asked
        // behind this screen, and on a slow connection may still be asking.
        // Bounded — past it the address in hand is used.
        originJob?.takeIf { it.isActive }?.let { withTimeoutOrNull(ORIGIN_WAIT_MS) { it.join() } }
        val user = api.logIn(email.trim(), password)
        sessionEpoch++
        cache.save(user)
        recallWorkspace(user.id)
        hooks.signedIn(user)
        _session.value = Session.SignedIn(user)
        loadWorkspaces()
        loadAppConfig()
    }

    /**
     * Signs out, in the order the server needs it: the push registration is
     * withdrawn while the session can still authorise that, THEN the session
     * is revoked, THEN everything this phone holds for the operator goes —
     * socket, token, cached rows and files, notifications, in-memory state —
     * before the login screen appears. Nothing of theirs is left for whoever
     * signs in next.
     *
     * Not cancellable once begun: this model's scope ends with the activity,
     * and a sign-out cut off half-way — Back pressed while it runs — leaves
     * the token deleted and the last operator's notifications and push token
     * in place.
     */
    fun logOut() {
        val user = (_session.value as? Session.SignedIn)?.user
        if (signOutJob?.isActive == true) return
        _signOutFailed.value = false
        signOutJob = viewModelScope.launch {
            withContext(NonCancellable) {
                user?.let { runCatching { hooks.beforeSignOut(it) } }
                val result = runCatching { api.logOut() }
                // A 401 is the server saying the session is already gone,
                // which is what was asked for.
                if (result.isSuccess || result.exceptionOrNull() == ApiError.Unauthorized) {
                    api.discardSession()
                    endSession(user?.id)
                } else {
                    // A failure here proves nothing about the server's view
                    // of the session, so the operator stays signed in and can
                    // try again — with this device registered for pushes
                    // again, which [SessionHooks.beforeSignOut] undid.
                    user?.let { runCatching { hooks.signOutFailed(it) } }
                    // And told so: the confirmation has closed and nothing
                    // has changed, which otherwise reads as a dead button.
                    _signOutFailed.value = true
                }
            }
        }
    }

    private var signOutJob: Job? = null

    /** A sign-out the server did not confirm, until the shell has said so. */
    private val _signOutFailed = MutableStateFlow(false)
    val signOutFailed: StateFlow<Boolean> = _signOutFailed.asStateFlow()

    fun signOutFailureShown() {
        _signOutFailed.value = false
    }

    /** The server said 401 to the token in hand: signed out here too, as at a sign-out. */
    private fun onSessionLost() {
        val user = (_session.value as? Session.SignedIn)?.user ?: return
        // A sign-out on its way handles its own 401.
        if (signOutJob?.isActive == true) return
        signOutJob = viewModelScope.launch {
            withContext(NonCancellable) {
                api.discardSession()
                endSession(user.id)
            }
        }
    }

    /**
     * Everything this phone holds for [accountId] goes, then the login
     * screen. Marked as pending first, so a process that dies half-way
     * finishes it at the next launch ([restore]).
     */
    private suspend fun endSession(accountId: String?) {
        // Whatever the launch's check brings back now belongs to a session
        // that is over, and is not applied — see [confirmSession].
        sessionEpoch++
        runCatching { prefs.setPendingSignOut(accountId.orEmpty()) }
        // Caught like every other step: a write that throws here (a full
        // disk) would otherwise end the sign-out before anything below it —
        // the caches, the notifications, the screens — and the process too.
        runCatching { cache.clear() }
        runCatching { hooks.signedOut(accountId) }
        runCatching { prefs.setPendingSignOut(null) }
        // A different operator is a different set of workspaces: nothing
        // selected here may carry across to them — and no retry still in
        // flight may bring the last one's back.
        workspacesJob?.cancel()
        rememberedWorkspace = null
        _workspaces.value = emptyList()
        _selectedWorkspace.value = null
        entitlementsRetry?.cancel()
        _entitlements.value = EntitlementsState.Loading
        _access.value = WorkspaceAccess.UNKNOWN
        planLoadedAt = null
        avatarJob?.cancel()
        _avatarUrl.value = null
        _signOutFailed.value = false
        _pendingLink.value = null
        _pendingCall.value = null
        _selectedTab.value = AppTab.INBOX
        _session.value = Session.SignedOut
    }

    private var appConfigJob: Job? = null

    /**
     * Asks for Super Admin's switches. The endpoint needs a session, so only
     * while signed in; a failure keeps the answer in hand — the last one
     * stored, or the defaults — and the next foreground asks again.
     */
    private fun loadAppConfig() {
        if (_session.value !is Session.SignedIn) return
        if (appConfigJob?.isActive == true) return
        appConfigJob = viewModelScope.launch {
            val config = runCatching { api.mobileAppConfig() }.getOrNull() ?: return@launch
            appConfigFromServer = true
            // The Firebase project push arrives through rides in it: handed on
            // at every read, so a phone that missed it once takes it the next.
            runCatching { hooks.appConfigChanged(config) }
            adoptPlatform(config)
            if (config != _appConfig.value) {
                _appConfig.value = config
                // Stored on the side, so this job ends when the answer is
                // in hand: a write still queued on DataStore's own threads
                // must not make the next foreground skip its ask.
                viewModelScope.launch { runCatching { prefs.setAppConfig(config) } }
            }
        }
    }

    private var platformJob: Job? = null

    /**
     * Asks whether the platform is down for maintenance, and which language
     * it starts a phone in — `GET /api/mobile-app/public-config`, which
     * needs no session, so the sign-in screen asks it too. Called at launch,
     * every minute while the app is on screen, and by the maintenance
     * notice's Try again. A failure keeps what is in hand.
     */
    fun checkPlatform(): Job {
        platformJob?.takeIf { it.isActive }?.let { return it }
        return viewModelScope.launch {
            _checkingPlatform.value = true
            try {
                val config = runCatching { api.publicAppConfig() }.getOrNull() ?: return@launch
                adoptPlatform(config)
                // The default language is kept with the rest of the config,
                // for the next launch to start in.
                val kept = _appConfig.value.copy(defaultLanguage = config.defaultLanguage)
                if (kept != _appConfig.value) {
                    _appConfig.value = kept
                    viewModelScope.launch { runCatching { prefs.setAppConfig(kept) } }
                }
            } finally {
                _checkingPlatform.value = false
            }
        }.also { platformJob = it }
    }

    /**
     * What a live answer says about maintenance and the default language. An
     * answer without a notice at all — a server from before the setting —
     * says nothing about it, and leaves the one in hand.
     */
    private fun adoptPlatform(config: MobileAppConfig) {
        config.maintenance?.let { notice -> _maintenance.value = notice.takeIf { it.isActive() } }
        if (languageChosen) return
        val language = Language.from(config.defaultLanguage) ?: return
        if (language == _language.value) return
        _language.value = language
        hooks.languageChanged(language)
    }

    private var avatarJob: Job? = null

    /**
     * Advisory: no picture is a quiet circle, not an error to show.
     *
     * Kept to the operator it was asked for. An answer that lands after a
     * sign-out would otherwise set the last operator's photo again — and if
     * the next operator's own ask then fails (offline, or no photo read yet),
     * their Settings and their team threads wear it.
     */
    private fun loadAvatar() {
        val userId = (_session.value as? Session.SignedIn)?.user?.id ?: return
        val asked = avatarSetByProfile
        avatarJob?.cancel()
        avatarJob = viewModelScope.launch {
            runCatching { api.account() }
                .onSuccess { account ->
                    val user = (_session.value as? Session.SignedIn)?.user
                    if (user?.id != userId) return@onSuccess
                    // Profile set a photo while this was on its way: this
                    // answer may be from before it.
                    if (asked == avatarSetByProfile) _avatarUrl.value = account.profile?.avatarUrl
                    // The name too, which the session only read at sign-in:
                    // otherwise one changed in Profile, or on the web, stays
                    // the old one in Settings' header and on a message still
                    // sending.
                    val name = account.profile?.fullName?.takeIf { it.isNotBlank() }
                    if (name != null && name != user.fullName) {
                        val renamed = user.copy(fullName = name)
                        hooks.signedIn(renamed)
                        _session.value = Session.SignedIn(renamed)
                    }
                }
        }
    }

    /**
     * The operator's name and photo read again: Profile has just saved a
     * change to them, and everything outside Profile holds the copy read at
     * sign-in.
     */
    fun refreshAccount() = loadAvatar()

    /** Counts the photos Profile has set, so an older read cannot put the last one back. */
    private var avatarSetByProfile = 0

    /** The photo as Profile now has it from the server — set, replaced or removed. */
    fun avatarChanged(url: String?) {
        if (_session.value !is Session.SignedIn) return
        avatarSetByProfile++
        _avatarUrl.value = url
    }

    private var workspacesJob: Job? = null

    /**
     * The workspace this operator was last in ([Preferences.workspace]), read
     * before the list is asked for rather than while choosing from it: the
     * choice then waits on nothing but the list.
     */
    private var rememberedWorkspace: String? = null

    private suspend fun recallWorkspace(userId: String) {
        rememberedWorkspace = runCatching { prefs.workspace(userId) }.getOrNull()
    }

    /**
     * Loads the workspace list, and tries again until it lands.
     *
     * Everything else hangs off the workspace — the conversations, the plan,
     * and through the plan the Contacts tab and the AI queues. If a single
     * failed attempt were the end of it, an app opened a moment before the
     * network was up (a phone just switched on, or coming out of a lift)
     * would sit on grey placeholder rows with two tabs until it was killed,
     * while every later request went through.
     *
     * So a failure waits and tries again, the waits growing to half a minute,
     * for a few minutes; after that, pulling the list to refresh starts it
     * over ([retryIfIncomplete]). Not for an auth failure — that is a
     * signed-out session, which the next request reports and the app acts on.
     */
    private fun loadWorkspaces() {
        if (workspacesJob?.isActive == true) return
        workspacesJob = viewModelScope.launch {
            retrying { api.workspaces() }?.let { list ->
                if (_session.value !is Session.SignedIn) return@let
                _workspaces.value = list
                loadAvatar()
                val current = _selectedWorkspace.value
                if (current == null || list.none { it.id == current.id }) {
                    // Where this operator last was, while they still have it.
                    val remembered = rememberedWorkspace
                    val chosen = list.firstOrNull { it.id == remembered } ?: list.firstOrNull()
                    chosen?.let(::selectWorkspace)
                } else {
                    // The same workspace, with a name or a logo that may
                    // have changed since it was picked.
                    list.firstOrNull { it.id == current.id }?.let { _selectedWorkspace.value = it }
                }
            }
        }
    }

    /**
     * Pull to refresh on a list that has nothing under it: whatever did not
     * load at launch is asked for again.
     */
    fun retryIfIncomplete() {
        if (_session.value !is Session.SignedIn) return
        if (_selectedWorkspace.value == null) {
            loadWorkspaces()
        } else if (_entitlements.value == EntitlementsState.Failed) {
            loadEntitlements()
        }
    }

    /**
     * [block], again after a growing wait each time it fails, until it
     * succeeds, the session ends, or the attempts run out. Null when it never
     * succeeded.
     */
    private suspend fun <T> retrying(block: suspend () -> T): T? {
        var wait = RETRY_FIRST_MS
        repeat(RETRY_ATTEMPTS) { attempt ->
            try {
                return block()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                if (e is ApiError && e.isAuthFailure) return null
            }
            if (_session.value !is Session.SignedIn || attempt == RETRY_ATTEMPTS - 1) return null
            delay(wait)
            wait = (wait * 2).coerceAtMost(RETRY_MAX_MS)
        }
        return null
    }

    private fun announceWorkspace() {
        val user = (_session.value as? Session.SignedIn)?.user ?: return
        val workspace = _selectedWorkspace.value ?: return
        hooks.workspaceSelected(user, workspace, _workspaces.value)
    }

    fun selectWorkspace(workspace: Workspace) {
        if (workspace.id == _selectedWorkspace.value?.id) return
        _selectedWorkspace.value = workspace
        (_session.value as? Session.SignedIn)?.user?.id?.let { userId ->
            viewModelScope.launch { runCatching { prefs.setWorkspace(userId, workspace.id) } }
        }
        announceWorkspace()
        // A different workspace is a different plan, so the old answer is
        // wrong rather than merely stale. Back to Loading, which is what keeps
        // a gated tab from lingering across the switch.
        _entitlements.value = EntitlementsState.Loading
        _access.value = WorkspaceAccess.UNKNOWN
        planLoadedAt = null
        loadEntitlements()
    }

    /** The plan load in flight, or its pending re-ask after a plan that could not be read. */
    private var entitlementsRetry: Job? = null

    /** When this workspace's plan was last read ([System.nanoTime]); null until it is. */
    private var planLoadedAt: Long? = null

    /**
     * Asks for the plan again if the one in hand is over three minutes old —
     * Super Admin can change it at any time and nothing announces it. Called
     * when the app comes to the foreground and when a screen that depends on
     * the plan is shown, so there is no timer running in the background; a
     * load or a 20-second re-ask already on its way is left to finish.
     */
    fun refreshPlanIfStale() {
        // A switch flipped in Super Admin reaches the phone the next time it
        // is opened. One small request, so no staleness window of its own.
        loadAppConfig()
        if (_selectedWorkspace.value == null) {
            // No workspace means the launch never got one; coming back to
            // the app is as good a moment as any to ask again.
            if (_session.value is Session.SignedIn) loadWorkspaces()
            return
        }
        if (entitlementsRetry?.isActive == true) return
        val loadedAt = planLoadedAt
        if (loadedAt != null && System.nanoTime() - loadedAt < PLAN_REFRESH_NS) return
        loadEntitlements()
    }

    /**
     * Asks for the plan now, whatever its age: a screen was just told by the
     * server that the plan no longer carries it.
     */
    fun refreshPlan() {
        if (_selectedWorkspace.value == null) return
        loadEntitlements()
    }

    /**
     * The plan, with the operator's role and the AI and call-center switches
     * read alongside it (a side request that fails leaves its value unknown,
     * and never fails the plan).
     */
    private fun loadEntitlements() {
        val workspaceId = _selectedWorkspace.value?.id ?: return
        entitlementsRetry?.cancel()
        entitlementsRetry = viewModelScope.launch {
            while (true) {
                val (next, nextAccess) = coroutineScope {
                    val side = async { runCatching { api.workspaceAccess(workspaceId) }.getOrNull() }
                    val plan = runCatching { api.entitlements(workspaceId) }
                        .fold(
                            onSuccess = { EntitlementsState.Loaded(it) },
                            // Failed, not Loading: the difference is the whole point
                            // of the state. Staying in Loading would hide the gated
                            // tab for ever on a flaky network; Failed resolves, and
                            // a fail-closed plan simply grants nothing.
                            onFailure = { EntitlementsState.Failed },
                        )
                    plan to (side.await() ?: WorkspaceAccess.UNKNOWN)
                }
                // Replaced by a newer load, or a workspace switched to meanwhile
                // (which has its own load): this answer is not the one to show.
                ensureActive()
                if (_selectedWorkspace.value?.id != workspaceId) return@launch
                if (next is EntitlementsState.Loaded) {
                    _entitlements.value = next
                    // Same workspace (a switch resets it to unknown), so a
                    // side answer that did not come keeps the last one.
                    _access.value = nextAccess.filledFrom(_access.value)
                    planLoadedAt = System.nanoTime()
                    return@launch
                }
                // A refresh that fails keeps the snapshot already in hand for this
                // workspace, with the role and switches read with it, as the web's
                // query does; the next foreground asks again.
                if (_entitlements.value is EntitlementsState.Loaded) return@launch
                _entitlements.value = next
                _access.value = nextAccess.filledFrom(_access.value)
                // Nothing gated shows while the plan cannot be read (the web's
                // rule), so ask again soon rather than at the next workspace switch.
                delay(PLAN_RETRY_MS)
                if (_selectedWorkspace.value?.id != workspaceId) return@launch
            }
        }
    }

    private companion object {
        const val PLAN_RETRY_MS = 20_000L
        const val PLAN_REFRESH_NS = 3 * 60 * 1_000_000_000L

        /**
         * How long a sign-in waits for the launch's question of where the
         * platform lives — a little over that question's own cap
         * (ApiClient.ORIGIN_TIMEOUT_MS), so it only ever cuts a hung one.
         */
        const val ORIGIN_WAIT_MS = 6_000L
        /** 1, 2, 4, 8, 16, 30, 30… seconds: about five minutes in all. */
        const val RETRY_FIRST_MS = 1_000L
        const val RETRY_MAX_MS = 30_000L
        const val RETRY_ATTEMPTS = 12
    }
}

/**
 * The tabs this account has.
 *
 * Inbox and Settings are core and always present. The rest follow the web
 * console's `planAccess.ts`:
 *
 * - **Contacts** — the plan's `contacts` module.
 * - **Visitors** — the plan's `visitor_tracking` module, any role.
 * - **Website analytics** — the plan's `web_analytics` module, owners and
 *   admins only (the web's `ADMIN_ONLY`), so it waits for the role as well.
 *
 * Super Admin's switches for the Android app (`showVisitors`,
 * `showWebAnalytics`) can only take a tab away: a switch left on never shows
 * what the plan does not carry.
 *
 * **While the plan is still resolving the gated tabs are left out** — a tab
 * that appears a few seconds after launch and then vanishes reads as a bug,
 * and the plan resolves long enough after a cold start for the operator to be
 * reading something when it lands.
 *
 * **The inbox sits in the middle**, the rest in their order around it — the
 * iOS app's `MainTabView.order`. The middle is where the thumb rests and the
 * eye lands first, and the inbox is the tab an operator comes back to between
 * everything else. With an even number of others it takes the leading middle;
 * with only Settings beside it, the leading end.
 */
internal fun appTabsFor(plan: EntitlementsState, access: WorkspaceAccess, config: MobileAppConfig): List<AppTab> {
    val resolved = plan.value.takeIf { plan.isResolved }
    val others = buildList {
        if (resolved?.moduleInPlan("contacts") == true) add(AppTab.CONTACTS)
        if (config.showVisitors && resolved?.moduleInPlan("visitor_tracking") == true) add(AppTab.VISITORS)
        if (config.showWebAnalytics && access.isAdmin && resolved?.moduleInPlan("web_analytics") == true) add(AppTab.ANALYTICS)
        add(AppTab.SETTINGS)
    }
    return others.toMutableList().apply { add(others.size / 2, AppTab.INBOX) }
}
