package com.webyar.operator.core.model

import kotlinx.serialization.EncodeDefault
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * How an operator wants to be told that something happened.
 *
 * **Every field is nullable, and null means "this server did not send it"** —
 * not "off". That is not defensive style, it is the shape of the problem: the
 * deployed API answers with `push_scope`, `push_preview` and
 * `push_internal_notes` and no `email_*` at all, while the copy of
 * `server/routes/notifications.ts` in this repository answers with six
 * `email_*` keys, no scope and no preview. One of them is ahead; both are
 * real. A screen that hard-coded either set would show an operator switches
 * their own server has never heard of.
 *
 * So the screen draws a row only where the server sent the key, and a PATCH
 * carries only the key that moved. A field this build has never heard of is
 * left alone rather than blanked.
 */
@Serializable
data class NotificationPrefs(
    /** The master switch. On means everything below is silenced. */
    @SerialName("disable_all") val disableAll: Boolean? = null,

    /**
     * Which threads are worth a notification: `all`, `assigned`, `mentions`
     * or `none` — see `pickRecipients` in
     * `server/services/push/recipients.ts`, which is the only place the four
     * actually mean anything.
     */
    @SerialName("push_scope") val pushScope: String? = null,
    /** Whether the notification may carry the message text itself. */
    @SerialName("push_preview") val pushPreview: Boolean? = null,
    /** Whether a colleague's internal note is worth waking someone for. */
    @SerialName("push_internal_notes") val pushInternalNotes: Boolean? = null,

    @SerialName("push_when_online") val pushWhenOnline: Boolean? = null,
    @SerialName("push_when_offline") val pushWhenOffline: Boolean? = null,
    @SerialName("push_visitor_browsing") val pushVisitorBrowsing: Boolean? = null,
    @SerialName("play_sound") val playSound: Boolean? = null,

    @SerialName("email_unread_messages") val emailUnreadMessages: Boolean? = null,
    @SerialName("email_transcripts") val emailTranscripts: Boolean? = null,
    @SerialName("email_user_ratings") val emailUserRatings: Boolean? = null,
    @SerialName("email_paid_invoices") val emailPaidInvoices: Boolean? = null,
    @SerialName("email_weekly_summary") val emailWeeklySummary: Boolean? = null,
    @SerialName("email_product_updates") val emailProductUpdates: Boolean? = null,

    @SerialName("quiet_hours_enabled") val quietHoursEnabled: Boolean? = null,
    /** `HH:mm`, 24-hour, or null. The server enforces the shape. */
    @SerialName("quiet_hours_start") val quietHoursStart: String? = null,
    @SerialName("quiet_hours_end") val quietHoursEnd: String? = null,
    @SerialName("quiet_hours_timezone") val quietHoursTimezone: String? = null,
) {
    /** The four values [pushScope] can carry, and what each one means. */
    companion object {
        /**
         * Which row on the server this app speaks for.
         *
         * Preferences are stored per surface — a browser row and a phone row —
         * and the endpoint reads 'web' when a request does not say, because the
         * console shipped before the column existed. A phone that stays silent
         * is therefore not using a default: it is reading and writing the
         * browser's settings. iOS names itself the same way.
         */
        const val SURFACE: String = "mobile"
    }

    enum class Scope(val wire: String) {
        /** Every new message in the workspace. */
        ALL("all"),

        /** Threads assigned to this operator, plus anything unassigned. */
        ASSIGNED("assigned"),

        /** Only where this operator was named. */
        MENTIONS("mentions"),

        /** Nothing. Distinct from [disableAll], which also silences email. */
        NONE("none"),
        ;

        companion object {
            fun of(wire: String?): Scope? = entries.firstOrNull { it.wire == wire }
        }
    }

    val scope: Scope? get() = Scope.of(pushScope)
}

/**
 * The server's answer.
 *
 * `platform` is the server saying which set of defaults it applied. It is
 * carried rather than ignored because it is the one field that explains why
 * two clients can see two different screens.
 */
@Serializable
data class NotificationPrefsResponse(
    val prefs: NotificationPrefs,
    val platform: String? = null,
)

/**
 * A change to one preference.
 *
 * Built one key at a time rather than by sending the whole row back: the
 * server reads a missing key as "leave alone", so two phones editing
 * different switches do not overwrite each other, and a key this build does
 * not know about is never blanked.
 *
 * `encodeDefaults = false` is kotlinx's default, which is what makes that
 * work — a null here is left out of the JSON entirely.
 */
@Serializable
data class NotificationPrefsUpdate(
    // Every other field here is null-by-default so that `encodeDefaults = false`
    // leaves it out and a PATCH carries only what changed. This one has to go in
    // every time, which is what `ALWAYS` overrides that rule for: without it the
    // write lands on the browser's row.
    @EncodeDefault(EncodeDefault.Mode.ALWAYS)
    val platform: String = NotificationPrefs.SURFACE,
    @SerialName("disable_all") val disableAll: Boolean? = null,
    @SerialName("push_scope") val pushScope: String? = null,
    @SerialName("push_preview") val pushPreview: Boolean? = null,
    @SerialName("push_internal_notes") val pushInternalNotes: Boolean? = null,
    @SerialName("push_when_online") val pushWhenOnline: Boolean? = null,
    @SerialName("push_when_offline") val pushWhenOffline: Boolean? = null,
    @SerialName("push_visitor_browsing") val pushVisitorBrowsing: Boolean? = null,
    @SerialName("play_sound") val playSound: Boolean? = null,
    @SerialName("email_unread_messages") val emailUnreadMessages: Boolean? = null,
    @SerialName("email_transcripts") val emailTranscripts: Boolean? = null,
    @SerialName("email_user_ratings") val emailUserRatings: Boolean? = null,
    @SerialName("email_paid_invoices") val emailPaidInvoices: Boolean? = null,
    @SerialName("email_weekly_summary") val emailWeeklySummary: Boolean? = null,
    @SerialName("email_product_updates") val emailProductUpdates: Boolean? = null,
    @SerialName("quiet_hours_enabled") val quietHoursEnabled: Boolean? = null,
    @SerialName("quiet_hours_start") val quietHoursStart: String? = null,
    @SerialName("quiet_hours_end") val quietHoursEnd: String? = null,
    @SerialName("quiet_hours_timezone") val quietHoursTimezone: String? = null,
)
