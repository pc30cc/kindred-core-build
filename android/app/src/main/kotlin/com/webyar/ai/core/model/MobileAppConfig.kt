package com.webyar.ai.core.model

import com.webyar.ai.i18n.Language
import kotlinx.serialization.Serializable
import java.time.Instant
import java.time.OffsetDateTime

/**
 * How this app should behave, as Super Admin → Mobile App → Android sets it.
 * `GET /api/mobile-app/config?platform=android`.
 *
 * Read at sign-in and whenever the app comes back to the foreground, and
 * kept between launches, so a switch flipped on the web reaches every phone
 * without a new build — and a phone that starts offline still honours the
 * last answer it had rather than flashing a hidden section.
 *
 * Every default leaves the app as operators know it without the switch, with
 * one deliberate exception: the operator's name is read-only unless allowed. An
 * unknown key from a newer server is ignored and a missing one takes its
 * default, so neither side has to ship first.
 */
@Serializable
data class MobileAppConfig(
    /** Settings → Storage: the cache sizes and Clear Cache. */
    val showStorage: Boolean = true,
    /** Settings → Security: the password and the app lock. */
    val showSecurity: Boolean = true,
    /** Settings → Notifications. Notifications themselves still arrive. */
    val showNotificationSettings: Boolean = true,
    /** Material You. Off keeps everyone on the brand colours. */
    val allowWallpaperColors: Boolean = true,
    val profileNameEditable: Boolean = false,
    val profilePhoneEditable: Boolean = false,
    val profilePhotoEditable: Boolean = true,
    /**
     * The Visitors tab. Can only take the tab away: a plan without
     * `visitor_tracking` never has it, whatever this says.
     */
    val showVisitors: Boolean = true,
    /**
     * The Website analytics tab. Can only take it away: it is still only for
     * owners and admins on plans with `web_analytics`.
     */
    val showWebAnalytics: Boolean = true,
    /**
     * The Firebase project push arrives through, as Super Admin → Mobile App
     * → Android → Identity sets it; null until all four values are there.
     * Kept apart by [com.webyar.ai.core.push.PushConfig], which starts
     * Firebase with it at every launch from then on.
     */
    val firebase: FirebaseClientConfig? = null,
    /**
     * The language the app opens in until the operator picks one: `fa`, `en`
     * or `tr`. Null from a server that predates the setting — and then the
     * app's own default, Persian.
     */
    val defaultLanguage: String? = null,
    /** Super Admin's maintenance notice; null from a server without one. */
    val maintenance: MaintenanceNotice? = null,
    /**
     * Where Settings → About → Support opens: the support link Super Admin →
     * Mobile App → Android → Identity holds. Null leaves the platform's own
     * help centre ([com.webyar.ai.core.storage.PlatformOrigin.supportUrl]).
     */
    val supportUrl: String? = null,
) {
    companion object {
        val DEFAULT = MobileAppConfig()
    }
}

/**
 * Super Admin → Mobile App → Android → Maintenance: while it is on nobody
 * signs in, and a signed-in operator sees the notice over the app — the Mac
 * app's maintenance overlay.
 *
 * Also read before sign-in, from `GET /api/mobile-app/public-config`, since
 * the sign-in screen is the first thing it has to cover.
 */
@Serializable
data class MaintenanceNotice(
    val enabled: Boolean = false,
    /** What to say, per language: `{ fa, en, tr }`, any of them missing. */
    val message: Map<String, String> = emptyMap(),
    /** ISO 8601; past it the notice is off by itself. */
    val until: String? = null,
) {
    val untilInstant: Instant?
        get() = until?.let { raw ->
            runCatching { OffsetDateTime.parse(raw).toInstant() }.getOrNull()
                ?: runCatching { Instant.parse(raw) }.getOrNull()
        }

    /** On, and not past its end time. */
    fun isActive(now: Instant = Instant.now()): Boolean {
        if (!enabled) return false
        val end = untilInstant ?: return true
        return end.isAfter(now)
    }

    /**
     * The notice in [language], else in whichever language it was written
     * in — a notice only in English still says something to a Persian
     * operator — else null, and the app's own wording.
     */
    fun message(language: Language): String? =
        sequenceOf(language.code, "fa", "en", "tr")
            .mapNotNull { message[it]?.trim()?.takeIf { text -> text.isNotEmpty() } }
            .firstOrNull()
}

/**
 * Firebase's client identifiers for this app: the four values of the
 * package's `google-services.json`. Not credentials — every build made with
 * them carries them in the clear — so they travel in the app's config and
 * are kept in ordinary preferences.
 */
@Serializable
data class FirebaseClientConfig(
    val appId: String = "",
    val apiKey: String = "",
    val projectId: String = "",
    val senderId: String = "",
) {
    /** All four: Firebase cannot start with fewer. */
    val isComplete: Boolean
        get() = appId.isNotBlank() && apiKey.isNotBlank() && projectId.isNotBlank() && senderId.isNotBlank()
}
