package com.webyar.operator.core.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

// What the app may show as a promotion, already resolved for one language by
// `GET /api/mobile-app/promotions`.
//
// The keys are the server's, which are camelCase with an upper-case URL
// (`ctaURL`, `imageURL`) — see `server/routes/mobilePromotions.ts`. They
// were once written here in snake_case, which decoded without complaint and
// silently dropped the button, the picture and the frequency caps.
//
// Nothing here is an advert in the store sense: the words and the picture come
// from the platform's own settings, no third-party SDK is involved, and no
// identifier or impression ever leaves the device. That is deliberate — it is
// what keeps the feature clear of the tracking rules rather than relying on a
// consent prompt to excuse it.

@Serializable
data class PromoCreative(
    val title: String,
    val body: String,
    /**
     * Absent when the server has stripped an unreviewed external link — the
     * promotion still says its piece, it just has no button.
     */
    val ctaLabel: String? = null,
    @SerialName("ctaURL") val ctaUrl: String? = null,
    @SerialName("imageURL") val imageUrl: String? = null,
) {
    /**
     * The link, if there is one and it is https.
     *
     * Scheme-checked here rather than at the tap: a `ctaUrl` of
     * `intent://…` or `javascript:` would otherwise be handed straight to the
     * system, and the one place to refuse it is the place that turns the
     * string into something openable.
     */
    val safeLink: String?
        get() = ctaUrl?.takeIf { it.startsWith("https://", ignoreCase = true) }
}

@Serializable
data class Promotions(
    val enabled: Boolean = false,
    val banner: PromoCreative? = null,
    val fullscreen: PromoCreative? = null,
    val minIntervalMinutes: Int? = null,
    val maxPerDay: Int? = null,
    val startAfterLaunches: Int? = null,
) {
    companion object {
        val NONE = Promotions()
    }
}
