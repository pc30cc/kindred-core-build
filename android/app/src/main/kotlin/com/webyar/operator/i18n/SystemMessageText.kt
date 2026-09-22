package com.webyar.operator.i18n

import com.webyar.operator.core.model.get
import com.webyar.operator.core.model.string
import com.webyar.operator.core.model.intOrNull
import com.webyar.operator.core.model.stringOrNull
import kotlinx.serialization.json.JsonElement

/**
 * One place that turns a system notice into text the reader can understand.
 *
 * This is the app's half of `src/lib/systemMessageText.ts`, and it exists for
 * the same reason that file does: **the server writes system message bodies in
 * English and freezes them into the row at insert time**, so the stored body
 * can never follow the reader's language. `Call ended by operator · 00:39` is
 * what is in the database whoever is looking at it.
 *
 * Every surface that shows one therefore has to rebuild the sentence from
 * `metadata`. The web console learned that the hard way — four surfaces each
 * knowing a different subset of kinds, so the thread said one thing and the
 * list beside it said another — which is why the copy here is taken key for
 * key from `src/i18n/locales` rather than written afresh.
 */
object SystemMessage {

    /**
     * Localised text for a system notice, or null when the kind is unknown —
     * in which case the caller falls back to the stored body rather than
     * showing nothing. A kind added server-side after this build shipped still
     * reads as an English sentence, which beats an empty row.
     */
    fun text(meta: JsonElement?, language: Language): String? {
        val kind = meta.string("kind")?.takeIf { it.isNotEmpty() } ?: return null

        fun value(key: String): String = meta.string(key).orEmpty().trim()

        return when (kind) {
            "conversation_transferred" ->
                StrManual.sysTransferred(language, actor = value("actor_name"), to = value("to_name"))

            "conversation_unassigned" ->
                StrManual.sysUnassigned(language, actor = value("actor_name"))

            "routing_agent_joined" -> {
                val name = value("agent_name")
                if (name.isEmpty()) {
                    Str.sysAgentJoinedGeneric(language)
                } else {
                    StrManual.sysAgentJoined(language, name = name)
                }
            }

            "routing_no_agent_available" -> Str.sysNoAgentAvailable(language)

            "routing_in_queue" -> Str.sysInQueue(language)

            "call_invitation" -> {
                val isVideo = value("channel") == "video"
                val operator = value("operator_name")
                val text = when {
                    operator.isEmpty() && isVideo -> Str.sysCallInviteVideo(language)
                    operator.isEmpty() -> Str.sysCallInviteAudio(language)
                    isVideo -> StrManual.sysCallInviteVideoFrom(language, op = operator)
                    else -> StrManual.sysCallInviteAudioFrom(language, op = operator)
                }
                val status = value("status").ifEmpty { "pending" }
                "$text · ${invitationStatus(status, language)}"
            }

            "call_ended" -> {
                val seconds = meta["duration_seconds"]?.intOrNull ?: 0
                // A call that never connected has no duration worth reporting.
                if (value("end_reason") == "failed" || seconds <= 0) {
                    Str.callEndedNotConnected(language)
                } else {
                    val duration = Format.duration(seconds, language)
                    when (value("ended_by")) {
                        "operator" -> StrManual.callEndedByOperator(language, duration = duration)
                        "visitor" -> StrManual.callEndedByVisitor(language, duration = duration)
                        else -> StrManual.callEndedBySystem(language, duration = duration)
                    }
                }
            }

            else -> null
        }
    }

    /** The status word shown beside a call invitation. */
    fun invitationStatus(status: String, language: Language): String = when (status) {
        "joined" -> Str.inviteStatusJoined(language)
        "expired" -> Str.inviteStatusExpired(language)
        "cancelled" -> Str.inviteStatusCancelled(language)
        "declined" -> Str.inviteStatusDeclined(language)
        else -> Str.inviteStatusPending(language)
    }

    /**
     * Describe a message whose only content is an attachment.
     *
     * Its body is empty, so a list that previews the body alone claims "no
     * messages yet" about a conversation somebody just sent a photo to.
     *
     * The sentence comes from a whole template per case rather than a name
     * glued onto a verb fragment, for the reason the web file records:
     * **Persian conjugates for the subject**, so "you" needs «ارسال کردید»
     * where a third party needs «ارسال کرد», and the concatenated form
     * produced «شما: یک تصویر ارسال کرد» — "you: sent a photo" with the wrong
     * person.
     */
    fun attachmentPreview(
        kind: String,
        isMe: Boolean,
        name: String?,
        language: Language,
    ): String {
        if (isMe) {
            return when (kind) {
                "image" -> Str.previewYouSentImage(language)
                "audio" -> Str.previewYouSentAudio(language)
                "video" -> Str.previewYouSentVideo(language)
                else -> Str.previewYouSentFile(language)
            }
        }
        // An unidentified visitor still gets a subject — "sent a photo" with
        // no subject reads like a fragment in every language this ships in.
        val sender = name?.trim()?.takeIf { it.isNotEmpty() } ?: Str.previewSomeone(language)
        return when (kind) {
            "image" -> StrManual.previewSentByImage(language, name = sender)
            "audio" -> StrManual.previewSentByAudio(language, name = sender)
            "video" -> StrManual.previewSentByVideo(language, name = sender)
            else -> StrManual.previewSentByFile(language, name = sender)
        }
    }
}
