package com.webyar.ai.core.model

import kotlinx.serialization.Serializable

/**
 * How this app should behave, as Super Admin → Mobile App → Android sets it.
 * `GET /api/mobile-app/config?platform=android`.
 *
 * Read at sign-in and whenever the app comes back to the foreground, and
 * kept between launches, so a switch flipped on the web reaches every phone
 * without a new build — and a phone that starts offline still honours the
 * last answer it had rather than flashing a hidden section.
 *
 * Every default is how the app behaved before these switches existed, with
 * one deliberate change: the operator's name is read-only unless allowed. An
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
) {
    companion object {
        val DEFAULT = MobileAppConfig()
    }
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
