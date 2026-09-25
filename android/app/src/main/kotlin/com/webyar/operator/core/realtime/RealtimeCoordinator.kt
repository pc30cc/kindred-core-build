package com.webyar.operator.core.realtime

import com.webyar.operator.core.Diag
import com.webyar.operator.core.model.Message
import com.webyar.operator.core.model.RealtimeEventPayload
import com.webyar.operator.core.sync.RealtimeHealth
import com.webyar.operator.core.sync.SyncCoordinator
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.launch

/**
 * Decides WHEN there is a socket; [RealtimeClient] decides how.
 *
 * There is one exactly while the app is in front and somebody is signed in
 * to a workspace. It is not kept alive in the background — no foreground
 * service, no wake lock, no socket held open in a pocket: once the app is
 * out of sight the operator's notifications come by push, which the system
 * delivers through Doze and battery optimisation where a socket of ours
 * would not survive anyway. Coming back to the front opens a new socket and
 * the sync layer reconciles what push did not carry.
 *
 * A workspace switch is a new socket too: `collectLatest` cancels the old
 * run — closing its socket, which ends its subscriptions — before the new
 * one negotiates tokens for the new workspace.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class RealtimeCoordinator(
    private val clientFactory: (RealtimeSink) -> RealtimeClient,
    private val sync: SyncCoordinator,
    private val appScope: CoroutineScope,
    private val diag: Diag = Diag.Android,
) {
    private val foreground = MutableStateFlow(false)
    private val workspace = MutableStateFlow<String?>(null)
    private var client: RealtimeClient? = null

    private val sink = object : RealtimeSink {
        override fun onMessage(workspaceId: String, message: Message) = sync.onRealtimeMessage(workspaceId, message)
        override fun onEvent(workspaceId: String, event: RealtimeEventPayload) = sync.onRealtimeEvent(workspaceId, event)
        override fun onReconnected(recovered: Boolean) = sync.onRealtimeReconnected(recovered)
        override fun onHealth(health: RealtimeHealth) {
            sync.setRealtime(health)
        }
    }

    init {
        appScope.launch {
            combine(foreground, workspace) { fg, ws -> if (fg) ws else null }
                .distinctUntilChanged()
                .collectLatest { ws ->
                    if (ws == null) {
                        sync.setRealtime(RealtimeHealth.IDLE)
                        return@collectLatest
                    }
                    diag.info("Realtime", "starting for workspace ${Diag.id(ws)}")
                    val running = clientFactory(sink)
                    client = running
                    try {
                        running.run(ws)
                    } finally {
                        if (client === running) client = null
                        diag.info("Realtime", "stopped for workspace ${Diag.id(ws)}")
                    }
                }
        }
    }

    fun setForeground(value: Boolean) {
        foreground.value = value
    }

    /** The workspace in front of the signed-in operator; null when signed out. */
    fun setWorkspace(workspaceId: String?) {
        workspace.value = workspaceId
    }

    /** The network came back: a client waiting out a backoff tries now. */
    fun onNetworkAvailable() {
        client?.nudge()
    }
}
