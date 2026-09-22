package com.webyar.operator.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.webyar.operator.core.model.EntitlementsState
import com.webyar.operator.core.model.User
import com.webyar.operator.core.model.Workspace
import com.webyar.operator.core.net.ApiError
import com.webyar.operator.core.net.WebyarApi
import com.webyar.operator.core.storage.Appearance
import com.webyar.operator.core.storage.Preferences
import com.webyar.operator.core.storage.SessionCache
import com.webyar.operator.i18n.Language
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.stateIn
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
) : ViewModel() {

    private val _session = MutableStateFlow<Session>(Session.Restoring)
    val session: StateFlow<Session> = _session.asStateFlow()

    private val _language = MutableStateFlow(Language.DEFAULT)
    val language: StateFlow<Language> = _language.asStateFlow()

    private val _appearance = MutableStateFlow(Appearance.SYSTEM)
    val appearance: StateFlow<Appearance> = _appearance.asStateFlow()

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

    init {
        viewModelScope.launch {
            // Before restore(), so the login screen is already in the right
            // language and the right way round rather than flipping once the
            // preference arrives.
            prefs.language()?.let { _language.value = it }
            _appearance.value = prefs.appearance()
            restore()
        }
    }

    fun setLanguage(language: Language) {
        _language.value = language
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
            _session.value = Session.SignedIn(user)
            loadWorkspaces()
        } catch (e: ApiError) {
            if (e.isAuthFailure) {
                api.discardSession()
                cache.clear()
                _session.value = Session.SignedOut
            } else {
                val cached = cache.read()
                _session.value = if (cached != null) Session.SignedIn(cached) else Session.SignedOut
                if (cached != null) loadWorkspaces()
            }
        }
    }

    suspend fun logIn(email: String, password: String): Result<Unit> = runCatching {
        val user = api.logIn(email.trim(), password)
        cache.save(user)
        _session.value = Session.SignedIn(user)
        loadWorkspaces()
    }

    fun logOut() {
        viewModelScope.launch {
            runCatching { api.logOut() }
                .onSuccess {
                    cache.clear()
                    _session.value = Session.SignedOut
                }
            // A failure here proves nothing about the server's view of the
            // session, so the operator stays signed in and can try again.
        }
    }

    /** Advisory: no picture is a fallback to initials, not an error to show. */
    private fun loadAvatar() {
        viewModelScope.launch {
            runCatching { api.account() }
                .onSuccess { _avatarUrl.value = it.profile?.avatarUrl }
        }
    }

    private suspend fun loadWorkspaces() {
        runCatching { api.workspaces() }.onSuccess { list ->
            _workspaces.value = list
            loadAvatar()
            if (_selectedWorkspace.value == null) {
                _selectedWorkspace.value = list.firstOrNull()
                loadEntitlements()
            }
        }
    }

    fun selectWorkspace(workspace: Workspace) {
        if (workspace.id == _selectedWorkspace.value?.id) return
        _selectedWorkspace.value = workspace
        // A different workspace is a different plan, so the old answer is
        // wrong rather than merely stale. Back to Loading, which is what keeps
        // a gated tab from lingering across the switch.
        _entitlements.value = EntitlementsState.Loading
        loadEntitlements()
    }

    private fun loadEntitlements() {
        val workspaceId = _selectedWorkspace.value?.id ?: return
        viewModelScope.launch {
            _entitlements.value = runCatching { api.entitlements(workspaceId) }
                .fold(
                    onSuccess = { EntitlementsState.Loaded(it) },
                    // Failed, not Loading: the difference is the whole point of
                    // the state. Staying in Loading would hide the gated tab
                    // for ever on a flaky network; Failed resolves, and a
                    // fail-closed plan simply grants nothing.
                    onFailure = { EntitlementsState.Failed },
                )
        }
    }
}
