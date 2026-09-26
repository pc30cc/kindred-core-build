package com.webyar.operator.feature.chat

import com.webyar.operator.core.model.AiState
import com.webyar.operator.core.model.Conversation

/**
 * Which composer controls a conversation should offer right now.
 *
 * One question decides this: is a person actually the one replying? **While
 * the AI owns a thread the operator is steering it, not talking to the
 * visitor** — the web replaces the whole composer with its guidance composer
 * for exactly this reason. Sending a file or a voice note into a conversation
 * the AI is answering would put content in front of the visitor that the AI
 * has no idea about.
 *
 * The plan is not asked. Its `widget_attachments`, `widget_voice_notes` and
 * `widget_emoji` keys (and every other `widget_*` key) govern the
 * customer-facing website widget, not the operator's composer — the web and
 * the desktop apps offer these tools whatever the plan says about the widget.
 */
data class ComposerCapabilities(
    val canAttach: Boolean,
    val canRecordVoice: Boolean,
    val canUseEmoji: Boolean,
    /**
     * True while the AI still owns the thread, so the UI can explain why the
     * controls are absent rather than just hiding them.
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

        /**
         * What an internal thread offers: everything. There is no AI and no
         * visitor here, so the one question answers itself.
         */
        val TEAM = ComposerCapabilities(
            canAttach = true,
            canRecordVoice = true,
            canUseEmoji = true,
            isAiManaged = false,
        )

        fun resolve(conversation: Conversation?): ComposerCapabilities {
            if (conversation == null) return NONE
            val aiManaged = AiState.resolve(conversation) == AiState.AI_MANAGED
            return ComposerCapabilities(
                canAttach = !aiManaged,
                canRecordVoice = !aiManaged,
                canUseEmoji = !aiManaged,
                isAiManaged = aiManaged,
            )
        }
    }
}
