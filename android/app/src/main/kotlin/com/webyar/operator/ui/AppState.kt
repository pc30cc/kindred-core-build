package com.webyar.operator.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.webyar.operator.core.model.EntitlementsState
import com.webyar.operator.core.model.MobileAppConfig
import com.webyar.operator.core.model.WorkspaceAccess
import com.webyar.operator.core.model.User
import com.webyar.operator.core.model.Workspace
import com.webyar.operator.core.net.ApiError
import com.webyar.operator.core.net.WebyarApi
import com.webyar.operator.core.push.PushPayload
import com.webyar.operator.core.storage.Appearance
import com.webyar.operator.core.storage.Preferences
import com.webyar.operator.core.storage.SessionCache
import com.webyar.operator.i18n.Language
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

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
     * one. Settings used to be handed a hard-coded null for this, so an
     * operator who had set a photo on the web saw their initials on the
     * phone for ever.
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
     * The tabs this account actually has.
     *
     * Inbox and Settings are core and always present. Contacts is plan-gated,
     * and **while the plan is still resolving it is left out** — a tab that
     * appears a few seconds after launch and then vanishes reads as a bug, and
     * the plan resolves long enough after a cold start for the operator to be
     * reading something when it lands.
     */
    val tabs: StateFlow<List<AppTab>> = entitlements
        .map { plan ->
            buildList {
                add(AppTab.INBOX)
                if (plan.isResolved && plan.value?.moduleInPlan("contacts") == true) {
                    add(AppTab.CONTACTS)
                }
                add(AppTab.SETTINGS)
            }
        }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), listOf(AppTab.INBOX, AppTab.SETTINGS))

    fun selectTab(tab: AppTab) {
        _selectedTab.value = tab
    }

    /**
     * A conversation a notification asked to open, until the shell opens it.
     *
     * Held here rather than acted on where the tap arrived: the tap can come
     * before the session is restored or the workspaces are loaded, and the
     * workspace it names has to be checked against THIS operator's before
     * anything is shown.
     */
    private val _pendingLink = MutableStateFlow<PushPayload?>(null)
    val pendingLink: StateFlow<PushPayload?> = _pendingLink.asStateFlow()

    fun openFromNotification(link: PushPayload) {
        if (link.opensConversation) _pendingLink.value = link
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
        viewModelScope.launch {
            // Before restore(), so the login screen is already in the right
            // language and the right way round rather than flipping once the
            // preference arrives.
            prefs.language()?.let { _language.value = it }
            hooks.languageChanged(_language.value)
            _appearance.value = prefs.appearance()
            // Stored values arrive from DataStore's own threads, possibly
            // after the operator has already chosen (or the server already
            // answered). The later, fresher value wins; the stored one only
            // fills in what nothing newer has set.
            val storedDynamic = prefs.dynamicColor()
            if (!dynamicColorChosen) _dynamicColor.value = storedDynamic
            val storedConfig = prefs.appConfig()
            if (!appConfigFromServer) _appConfig.value = storedConfig
            restore()
        }
    }

    fun setLanguage(language: Language) {
        _language.value = language
        hooks.languageChanged(language)
        viewModelScope.launch {
            prefs.setLanguage(language)
            // Tell the server too, so the console and the emails this operator
            // receives agree with the app in their hand. A failure here is not
            // worth surfacing: the app is already in the new language, and the
            // next successful save will carry it.
            runCatching { api.updateProfile(fullName = null, preferredLocale = language.code) }
        }
    }

    fun setAppearance(appearance: Appearance) {
        _appearance.value = appearance
        viewModelScope.launch { prefs.setAppearance(appearance) }
    }

    fun setDynamicColor(on: Boolean) {
        dynamicColorChosen = true
        _dynamicColor.value = on
        viewModelScope.launch { prefs.setDynamicColor(on) }
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
        runCatching { api.refreshOrigin() }
        if (!api.hasToken()) {
            _session.value = Session.SignedOut
            return
        }
        try {
            val user = api.currentUser()
            cache.save(user)
            hooks.signedIn(user)
            _session.value = Session.SignedIn(user)
            loadWorkspaces()
            loadAppConfig()
        } catch (e: ApiError) {
            if (e.isAuthFailure) {
                val stale = cache.read()
                api.discardSession()
                cache.clear()
                // The session was revoked elsewhere: whatever this phone
                // cached for it goes, exactly as at a sign-out.
                runCatching { hooks.signedOut(stale?.id) }
                _session.value = Session.SignedOut
            } else {
                val cached = cache.read()
                // Offline at launch: the cached operator stands in, and so
                // does their cache — which is the whole point of having one.
                cached?.let(hooks::signedIn)
                _session.value = if (cached != null) Session.SignedIn(cached) else Session.SignedOut
                if (cached != null) loadWorkspaces()
            }
        }
    }

    /**
     * Sign in, and then get out of the caller's coroutine scope.
     *
     * The line that sets [_session] is also the line that replaces the login
     * screen with the app — and the login screen's `rememberCoroutineScope`
     * dies with it. Anything still running in that scope is cancelled on the
     * spot, which is what used to happen to the workspace load:
     *
     *     REQUEST /api/workspaces failed with exception:
     *     ForgottenCoroutineScopeException: rememberCoroutineScope left the
     *     composition
     *
     * So a fresh sign-in reached an app with no workspace, and therefore no
     * entitlements, no Contacts tab, no AI queues and no conversations — an
     * app that looked empty rather than broken, silently, because
     * [loadWorkspaces] swallows its failures. A restored session never showed
     * it: that path runs in `viewModelScope` already.
     *
     * The load is handed to [viewModelScope], which outlives every screen.
     * The caller learns only whether the credentials were good, which is all
     * it asked.
     */
    suspend fun logIn(email: String, password: String): Result<Unit> = runCatching {
        val user = api.logIn(email.trim(), password)
        cache.save(user)
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
     */
    fun logOut() {
        val user = (_session.value as? Session.SignedIn)?.user
        viewModelScope.launch {
            user?.let { runCatching { hooks.beforeSignOut(it) } }
            runCatching { api.logOut() }
                .onSuccess {
                    cache.clear()
                    runCatching { hooks.signedOut(user?.id) }
                    // A different operator is a different set of workspaces:
                    // nothing selected here may carry across to them — and
                    // no retry still in flight may bring the last one's back.
                    workspacesJob?.cancel()
                    _workspaces.value = emptyList()
                    _selectedWorkspace.value = null
                    entitlementsRetry?.cancel()
                    _entitlements.value = EntitlementsState.Loading
                    _access.value = WorkspaceAccess.UNKNOWN
                    planLoadedAt = null
                    _avatarUrl.value = null
                    _pendingLink.value = null
                    _selectedTab.value = AppTab.INBOX
                    _session.value = Session.SignedOut
                }
            // A failure here proves nothing about the server's view of the
            // session, so the operator stays signed in and can try again.
        }
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
            if (config != _appConfig.value) {
                _appConfig.value = config
                // Stored on the side, so this job ends when the answer is
                // in hand: a write still queued on DataStore's own threads
                // must not make the next foreground skip its ask.
                viewModelScope.launch { prefs.setAppConfig(config) }
            }
        }
    }

    /** Advisory: no picture is a quiet circle, not an error to show. */
    private fun loadAvatar() {
        viewModelScope.launch {
            runCatching { api.account() }
                .onSuccess { _avatarUrl.value = it.profile?.avatarUrl }
        }
    }

    private var workspacesJob: Job? = null

    /**
     * Loads the workspace list, and tries again until it lands.
     *
     * Everything else hangs off the workspace — the conversations, the plan,
     * and through the plan the Contacts tab and the AI queues. A single
     * attempt that failed used to be the end of it: an app opened a moment
     * before the network was up (the emulator's DNS for its first seconds, a
     * phone coming out of a lift) sat on grey placeholder rows with two tabs
     * until it was killed, while every later request went through.
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
                if (_selectedWorkspace.value == null) {
                    _selectedWorkspace.value = list.firstOrNull()
                    announceWorkspace()
                    loadEntitlements()
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
                    _access.value = nextAccess
                    planLoadedAt = System.nanoTime()
                    return@launch
                }
                // A refresh that fails keeps the snapshot already in hand for this
                // workspace, with the role and switches read with it, as the web's
                // query does; the next foreground asks again.
                if (_entitlements.value is EntitlementsState.Loaded) return@launch
                _entitlements.value = next
                _access.value = nextAccess
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
        /** 1, 2, 4, 8, 16, 30, 30… seconds: about five minutes in all. */
        const val RETRY_FIRST_MS = 1_000L
        const val RETRY_MAX_MS = 30_000L
        const val RETRY_ATTEMPTS = 12
    }
}
