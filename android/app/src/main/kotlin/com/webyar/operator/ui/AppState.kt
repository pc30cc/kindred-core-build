package com.webyar.operator.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.webyar.operator.core.model.User
import com.webyar.operator.core.model.Workspace
import com.webyar.operator.core.net.ApiError
import com.webyar.operator.core.net.WebyarApi
import com.webyar.operator.core.storage.SessionCache
import com.webyar.operator.i18n.Language
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
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
) : ViewModel() {

    private val _session = MutableStateFlow<Session>(Session.Restoring)
    val session: StateFlow<Session> = _session.asStateFlow()

    private val _language = MutableStateFlow(Language.DEFAULT)
    val language: StateFlow<Language> = _language.asStateFlow()

    private val _workspaces = MutableStateFlow<List<Workspace>>(emptyList())
    val workspaces: StateFlow<List<Workspace>> = _workspaces.asStateFlow()

    private val _selectedWorkspace = MutableStateFlow<Workspace?>(null)
    val selectedWorkspace: StateFlow<Workspace?> = _selectedWorkspace.asStateFlow()

    init {
        viewModelScope.launch { restore() }
    }

    fun setLanguage(language: Language) {
        _language.value = language
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

    private suspend fun loadWorkspaces() {
        runCatching { api.workspaces() }.onSuccess { list ->
            _workspaces.value = list
            if (_selectedWorkspace.value == null) _selectedWorkspace.value = list.firstOrNull()
        }
    }

    fun selectWorkspace(workspace: Workspace) {
        _selectedWorkspace.value = workspace
    }
}
