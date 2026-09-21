package com.webyar.operator.core.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import java.time.Instant

/** The operator's own profile row. `GET /api/account/me`. */
@Serializable
data class AccountProfile(
    val id: String? = null,
    @SerialName("full_name") val fullName: String? = null,
    /**
     * Derived server-side from the storage key for whichever provider is
     * primary, so it is read-only here — an avatar is changed by uploading,
     * never by setting a URL.
     */
    @SerialName("avatar_url") val avatarUrl: String? = null,
    @SerialName("preferred_locale") val preferredLocale: String? = null,
)

@Serializable
data class Account(
    val id: String,
    val email: String? = null,
    val phone: String? = null,
    @SerialName("email_confirmed_at") val emailConfirmedAt: String? = null,
    @SerialName("created_at") @Serializable(InstantSerializer::class) val createdAt: Instant? = null,
    val profile: AccountProfile? = null,
) {
    val isEmailVerified: Boolean get() = emailConfirmedAt != null

    val displayName: String
        get() = profile?.fullName?.takeIf { it.isNotBlank() }
            ?: email?.takeIf { it.isNotEmpty() }
            ?: "—"
}

/**
 * A signed-in device or browser. `GET /api/account/security/sessions`.
 *
 * The server already parses the user agent into browser, OS and device and
 * resolves the IP to a city and country, so none of that is re-derived here —
 * a second parser in the client could only ever disagree with the one the web
 * console shows for the same session.
 */
@Serializable
data class AccountSession(
    val id: String,
    val browser: String? = null,
    val os: String? = null,
    val device: String? = null,
    val ip: String? = null,
    val city: String? = null,
    val country: String? = null,
    @SerialName("country_code") val countryCode: String? = null,
    @SerialName("is_current") val isCurrent: Boolean? = null,
    @SerialName("created_at") @Serializable(InstantSerializer::class) val createdAt: Instant? = null,
    @SerialName("last_active_at") @Serializable(InstantSerializer::class) val lastActiveAt: Instant? = null,
) {
    /** "Istanbul, Türkiye" when the server resolved it. */
    val locationLabel: String?
        get() = listOfNotNull(city, country).map { it.trim() }.filter { it.isNotEmpty() }
            .takeIf { it.isNotEmpty() }?.joinToString(", ")
}

@Serializable
data class AccountSessionsResponse(
    val sessions: List<AccountSession> = emptyList(),
    @SerialName("current_session_id") val currentSessionId: String? = null,
)
