package com.webyar.operator.core.sync

import com.webyar.operator.core.Diag
import com.webyar.operator.core.cache.CacheScope
import com.webyar.operator.core.cache.CacheStore
import com.webyar.operator.core.cache.MemoryCacheStore
import com.webyar.operator.core.net.WebyarApi
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob

/**
 * What a screen's view model needs from the sync layer, in one parameter.
 *
 * [account] is read at the moment a scope is made rather than captured once:
 * the view models that hold this outlive nothing — they are cleared with the
 * session — but the question "who is signed in" still has exactly one
 * answer, and it lives in the session, not here.
 */
class SyncGraph(
    val coordinator: SyncCoordinator,
    private val account: () -> String?,
    /** Who a message typed here is from, for its pending bubble. */
    val sender: () -> OutgoingSender? = { null },
) {
    val conversations: ConversationRepository get() = coordinator.conversations
    val messages: MessageRepository get() = coordinator.messages

    fun scope(workspaceId: String): CacheScope? =
        account()?.takeIf { it.isNotBlank() }?.let { CacheScope(it, workspaceId) }

    companion object {
        /**
         * The account a graph with no session belongs to: the sample backend,
         * previews and the view-model tests, which have a workspace and no user.
         */
        const val LOCAL_ACCOUNT = "local"

        /** A whole sync layer in memory — for tests and the sample backend. */
        fun inMemory(
            api: WebyarApi,
            store: CacheStore = MemoryCacheStore(),
            scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate),
            clock: () -> Long = System::currentTimeMillis,
            diag: Diag = Diag.Silent,
        ): SyncGraph {
            val coordinator = SyncCoordinator(
                conversations = ConversationRepository(api, store, clock, diag),
                messages = MessageRepository(api, store, clock, diag = diag),
                appScope = scope,
                clock = clock,
                diag = diag,
            )
            return SyncGraph(coordinator, account = { LOCAL_ACCOUNT })
        }
    }
}
