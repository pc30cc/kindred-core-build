package com.webyar.operator.feature.chat

import com.webyar.operator.core.model.AiState
import com.webyar.operator.core.model.Conversation
import com.webyar.operator.core.model.Entitlements

/**
 * Which composer controls a conversation should offer right now.
 *
 * Two independent questions decide this, and both have to say yes:
 *
 * 1. Does the workspace's plan include the capability at all?
 * 2. Is a person actually the one replying?
 *
 * The second is the important one. **While the AI owns a thread the operator
 * is steering it, not talking to the visitor** — the web replaces the whole
 * composer with its guidance composer for exactly this reason. Sending a file
 * or a voice note into a conversation the AI is answering would put content in
 * front of the visitor that the AI has no idea about.
 */
data class ComposerCapabilities(
    val canAttach: Boolean,
    val canRecordVoice: Boolean,
    val canUseEmoji: Boolean,
    /**
     * True while the AI still owns the thread, so the UI can explain why the
     * controls are absent rather than just hiding them. A control that is
     * missing for a reason and a control that is missing because the plan
     * never had it look identical, and only one of them is worth saying
     * anything about.
     */
    val isAiManaged: Boolean,
) {
    val hasAnyControl: Boolean get() = canAttach || canRecordVoice || canUseEmoji

    companion object {
        val NONE = ComposerCapabilities(
            canAttach = false,
            canRecordVoice = false,
            canUseEmoji = false,
            isAiManaged = false,
        )

        fun resolve(conversation: Conversation?, entitlements: Entitlements?): ComposerCapabilities {
            if (conversation == null) return NONE
            val aiManaged = AiState.resolve(conversation) == AiState.AI_MANAGED

            // Fail-closed on the plan: an unresolved snapshot shows nothing
            // rather than offering a control that would fail on use.
            fun plan(key: String) = entitlements?.featureEnabled(key) == true

            return ComposerCapabilities(
                canAttach = !aiManaged && plan("widget_attachments"),
                canRecordVoice = !aiManaged && plan("widget_voice_notes"),
                canUseEmoji = !aiManaged && plan("widget_emoji"),
                isAiManaged = aiManaged,
            )
        }
    }
}
