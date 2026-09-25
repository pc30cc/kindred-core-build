package com.webyar.operator.core.push

import com.webyar.operator.core.Diag
import com.webyar.operator.core.sync.SyncCoordinator
import com.webyar.operator.i18n.Language

/** What the router needs to know about the app at the moment a push arrives. */
data class PushContext(
    val accountId: String,
    /** The operator's workspaces, when known. Empty means "not loaded yet", not "none". */
    val workspaceIds: Set<String>,
    val language: Language,
    val foreground: Boolean,
    /** The conversations on screen right now. */
    val openConversationIds: Set<String>,
)

/**
 * A push that arrived with the app running, turned into what it should do.
 *
 * Two things, in this order:
 *
 *  1. **A targeted sync** of the conversation it names — the row in the
 *     inbox, and its thread if this phone holds it — through the same
 *     coordinator a realtime event goes through. Never a reload of the inbox
 *     or of the whole thread; and when realtime already delivered the same
 *     message, the delta finds it already there and it is one row, not two.
 *  2. **A notification**, unless the operator is looking at that very
 *     conversation. With the app in the background the system has already
 *     drawn one from the push's own `notification` block, and this is not
 *     called.
 *
 * A push for a workspace this operator does not belong to is dropped — it
 * can only be a message for whoever held this phone's token before, and
 * showing it would be showing one operator's customers to another.
 */
class PushRouter(
    private val sync: SyncCoordinator,
    private val context: () -> PushContext?,
    private val show: (PushPayload, String?, String?, Language) -> Unit,
    private val diag: Diag = Diag.Android,
) {
    fun onMessage(payload: PushPayload, title: String?, body: String?) {
        val now = context() ?: run {
            diag.info(AREA, "push dropped: nobody signed in")
            return
        }
        val workspace = payload.workspaceId
        if (workspace != null && now.workspaceIds.isNotEmpty() && workspace !in now.workspaceIds) {
            diag.warn(AREA, "push dropped: workspace ${Diag.id(workspace)} is not this operator's")
            return
        }
        if (workspace != null) {
            diag.info(AREA, "push-triggered sync (${payload.type ?: "?"}) for ${Diag.id(payload.conversationId)}")
            sync.onPush(workspace, payload.conversationId)
        }
        if (now.foreground && payload.conversationId != null && payload.conversationId in now.openConversationIds) {
            // The message is arriving on the screen the operator is reading.
            return
        }
        show(payload, title, body, now.language)
    }

    private companion object {
        const val AREA = "Push"
    }
}
