package com.webyar.operator.core.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * What the widget captured about a visitor's device and where they are.
 *
 * `POST /api/visitor-intel/network/batch`. The server applies the IP privacy
 * and entitlement policy, so the app never decides what it is allowed to see —
 * which is the right place for that decision to live, because a client that
 * decided for itself would be a client that could be persuaded otherwise.
 */
@Serializable
data class VisitorProfile(
    val geo: Geo? = null,
    val device: Device? = null,
) {
    @Serializable
    data class Geo(
        @SerialName("country_code") val countryCode: String? = null,
        val country: String? = null,
        val city: String? = null,
    )

    @Serializable
    data class Device(
        val browser: String? = null,
        val os: String? = null,
        val device: String? = null,
    )
}

@Serializable
data class VisitorIntelResponse(
    @SerialName("by_conversation") val byConversation: Map<String, VisitorProfile>? = null,
    /**
     * The same profiles keyed by contact, for surfaces that have a contact and
     * no conversation — the Contacts list and a contact's own page.
     */
    @SerialName("by_contact") val byContact: Map<String, VisitorProfile>? = null,
)
