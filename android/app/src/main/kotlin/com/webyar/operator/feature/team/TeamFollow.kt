package com.webyar.operator.feature.team

import com.webyar.operator.core.sync.TeamSignal
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull

/** What the console polls the colleague list at (`useTeamChat.ts`). */
const val TEAM_LIST_POLL_MS = 20_000L

/**
 * Runs [refresh] for as long as the caller runs: once straight away, again
 * the moment the operator's own channel says a team thread moved (a signal
 * [wanted] accepts), and every [pollMs] regardless.
 *
 * The poll is not a leftover. A server with no realtime — or one that
 * predates the operator's channel — sends no signal at all, and there the
 * poll is the whole of it, at the console's own rate. With realtime, it only
 * catches what a dropped socket missed.
 *
 * Signals that arrive while a refresh is running fold into one more refresh,
 * never a queue of them: ten messages in a burst are one re-read.
 *
 * Meant to run under `repeatOnLifecycle(RESUMED)`: a phone in a pocket asks
 * nothing.
 */
suspend fun followTeam(
    signals: Flow<TeamSignal>?,
    pollMs: Long,
    wanted: (TeamSignal) -> Boolean = { true },
    immediately: Boolean = true,
    refresh: suspend () -> Unit,
) = coroutineScope {
    val wake = Channel<Unit>(Channel.CONFLATED)
    val listener = signals?.let { flow ->
        launch { flow.collect { if (wanted(it)) wake.trySend(Unit) } }
    }
    try {
        if (immediately) refresh()
        while (currentCoroutineContext().isActive) {
            withTimeoutOrNull(pollMs) { wake.receive() }
            refresh()
        }
    } finally {
        listener?.cancel()
    }
}
