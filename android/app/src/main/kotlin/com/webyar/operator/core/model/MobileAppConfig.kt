package com.webyar.operator.core.model

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
) {
    companion object {
        val DEFAULT = MobileAppConfig()
    }
}
