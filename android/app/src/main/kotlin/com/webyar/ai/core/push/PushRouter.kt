package com.webyar.ai.core.push

import com.webyar.ai.core.Diag
import com.webyar.ai.core.sync.SyncCoordinator
import com.webyar.ai.i18n.Language

/** What the router needs to know about the app at the moment a push arrives. */
data class PushContext(
    val accountId: String,
    /** The operator's workspaces, when known. Empty means "not loaded yet" — and nothing is shown. */
    val workspaceIds: Set<String>,
    val language: Language,
    val foreground: Boolean,
    /** The conversations on screen right now. */
    val openConversationIds: Set<String>,
    /** The colleagues whose team thread is on screen right now. */
    val openTeamPeerIds: Set<String> = emptySet(),
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
 * showing it would be showing one operator's customers to another. So is one
 * that arrives before the workspaces are known, or names none: there is then
 * nothing to check it against, and "not yet known" must not read as "fine".
 * With the app in front, the inbox shows the message anyway.
 *
 * A colleague's message in team chat is the same, about a thread instead of
 * a conversation: the screens that show team chat are told to read again,
 * and it is shown unless that colleague's thread is the one on screen.
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
        // Super Admin's test send: to the admin's own devices, about no
        // conversation and carrying none of anyone's messages. Shown as it
        // came, never synced — in the background the system draws it anyway,
        // and in front it must not vanish, or a working setup reads as a
        // broken one.
        if (payload.isTest) {
            diag.info(AREA, "test push shown")
            show(payload, title, body, now.language)
            return
        }
        val workspace = payload.workspaceId
        if (workspace == null || workspace !in now.workspaceIds) {
            diag.warn(
                AREA,
                if (now.workspaceIds.isEmpty()) "push dropped: workspaces not known yet"
                else "push dropped: workspace ${Diag.id(workspace)} is not this operator's",
            )
            return
        }
        if (payload.isTeamMessage) {
            val peer = payload.peerId ?: run {
                diag.warn(AREA, "team push dropped: names no colleague")
                return
            }
            diag.info(AREA, "team push from ${Diag.id(peer)}")
            sync.onTeamPush(workspace, peer)
            if (now.foreground && peer in now.openTeamPeerIds) return
            show(payload, title, body, now.language)
            return
        }
        if (payload.isEmail || payload.isCallback) {
            // About no conversation: nothing for the inbox to read, and no
            // thread on screen that could make it redundant.
            diag.info(AREA, "push (${payload.type}) shown")
            show(payload, title, body, now.language)
            return
        }
        diag.info(AREA, "push-triggered sync (${payload.type ?: "?"}) for ${Diag.id(payload.conversationId)}")
        sync.onPush(workspace, payload.conversationId)
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
