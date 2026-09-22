package com.webyar.operator.core.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * How an operator wants to be told that something happened.
 *
 * One row per user, and the server fills in its own defaults for anything
 * missing (`DEFAULTS` in `server/routes/notifications.ts`), so a new account
 * with no row reads exactly like a saved one. Every field here is therefore
 * non-null with the server's own default behind it: a missing key means "the
 * server did not send it", not "off".
 */
@Serializable
data class NotificationPrefs(
    /** The master switch. On means everything below is silenced. */
    @SerialName("disable_all") val disableAll: Boolean = false,

    @SerialName("push_when_online") val pushWhenOnline: Boolean = true,
    @SerialName("push_when_offline") val pushWhenOffline: Boolean = true,
    @SerialName("push_visitor_browsing") val pushVisitorBrowsing: Boolean = false,
    @SerialName("play_sound") val playSound: Boolean = true,

    @SerialName("email_unread_messages") val emailUnreadMessages: Boolean = true,
    @SerialName("email_transcripts") val emailTranscripts: Boolean = false,
    @SerialName("email_user_ratings") val emailUserRatings: Boolean = true,
    @SerialName("email_paid_invoices") val emailPaidInvoices: Boolean = true,
    @SerialName("email_weekly_summary") val emailWeeklySummary: Boolean = false,
    @SerialName("email_product_updates") val emailProductUpdates: Boolean = false,

    @SerialName("quiet_hours_enabled") val quietHoursEnabled: Boolean = false,
    /** `HH:mm`, 24-hour, or null when never set. The server enforces the shape. */
    @SerialName("quiet_hours_start") val quietHoursStart: String? = null,
    @SerialName("quiet_hours_end") val quietHoursEnd: String? = null,
    @SerialName("quiet_hours_timezone") val quietHoursTimezone: String? = null,
)

@Serializable
data class NotificationPrefsResponse(val prefs: NotificationPrefs)

/**
 * A change to one preference.
 *
 * The server's PATCH takes a partial object and every field is optional, so
 * this is built one key at a time rather than by sending the whole row back:
 * two phones editing different switches then do not overwrite each other, and
 * a field this app does not know about is never blanked.
 *
 * `encodeDefaults = false` is kotlinx's default, which is exactly what makes
 * that work — a null here is omitted from the JSON entirely, so a field left
 * alone is never sent. Turning quiet hours off therefore leaves the two times
 * where they were, and turning them back on restores the window the operator
 * had chosen rather than an empty one.
 */
@Serializable
data class NotificationPrefsUpdate(
    @SerialName("disable_all") val disableAll: Boolean? = null,
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
