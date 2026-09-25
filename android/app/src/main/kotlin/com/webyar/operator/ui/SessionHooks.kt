package com.webyar.operator.ui

import com.webyar.operator.core.model.User
import com.webyar.operator.core.model.Workspace
import com.webyar.operator.i18n.Language

/**
 * What the rest of the app does when the session changes.
 *
 * [AppState] decides WHEN somebody is signed in, and to which workspace;
 * these are the consequences — the realtime socket, the push registration,
 * the caches — which belong to the app's graph and not to a view model. An
 * interface so AppState's own tests need none of them.
 */
interface SessionHooks {
    fun signedIn(user: User) {}

    fun workspaceSelected(user: User, workspace: Workspace, all: List<Workspace>) {}

    fun languageChanged(language: Language) {}

    /** While the session is still valid: the last moment anything can be told to the server. */
    suspend fun beforeSignOut(user: User) {}

    /**
     * The session is gone. Everything that was the previous operator's —
     * socket, push token, cached rows, cached files, notifications — goes
     * with it, before the login screen is shown.
     */
    suspend fun signedOut(accountId: String?) {}

    object None : SessionHooks
}
