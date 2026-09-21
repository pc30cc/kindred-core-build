package com.webyar.operator.core.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

// Whether visitors can see this operator. Mirrors `/api/availability` and
// `src/lib/availability-api.ts`.
//
// Three switches decide it, and they are not independent: invisible mode wins
// over everything, and the other two are what turn presence on. The app sends
// each change on its own and takes the server's recomputed status back, rather
// than working the rule out a second time here — one place deciding who is
// online is the whole point.

@Serializable
data class AvailabilityPrefs(
    @SerialName("force_offline") val forceOffline: Boolean = false,
    @SerialName("available_when_using_app") val availableWhenUsingApp: Boolean = false,
    @SerialName("schedule_enabled") val scheduleEnabled: Boolean = false,
    val timezone: String? = null,
)

@Serializable
data class AvailabilityStatus(
    /** `online` or `offline`, as the server computes it. */
    val state: String? = null,
    /** Why — a key the server uses for its own copy. Not shown. */
    val reason: String? = null,
) {
    val isOnline: Boolean get() = state == "online"
}

@Serializable
data class AvailabilityResponse(val prefs: AvailabilityPrefs, val status: AvailabilityStatus)

/**
 * The one field of a PATCH. Sent alone so a toggle can never carry a stale
 * copy of the other two back to the server.
 */
@Serializable
data class AvailabilityUpdate(
    @SerialName("force_offline") val forceOffline: Boolean? = null,
    @SerialName("available_when_using_app") val availableWhenUsingApp: Boolean? = null,
    @SerialName("schedule_enabled") val scheduleEnabled: Boolean? = null,
)
