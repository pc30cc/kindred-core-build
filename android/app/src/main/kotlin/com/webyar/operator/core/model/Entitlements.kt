package com.webyar.operator.core.model

import kotlinx.serialization.Serializable

/** One capability's resolved state, and where the value came from. */
@Serializable
data class EffectiveBool(val value: Boolean? = null, val source: String? = null, val note: String? = null)

@Serializable
data class EffectiveInt(val value: Int? = null, val source: String? = null, val note: String? = null)

/**
 * The plan snapshot for a workspace: what this account is actually entitled to.
 *
 * Mirrors `GET /api/plans/workspace/:id/effective`. Only the buckets the app
 * gates on are decoded; the plan and usage objects the admin console needs are
 * left alone.
 */
@Serializable
data class Entitlements(
    val workspaceId: String? = null,
    val features: Map<String, EffectiveBool>? = null,
    val modules: Map<String, EffectiveBool>? = null,
    val channels: Map<String, EffectiveBool>? = null,
    val limits: Map<String, EffectiveInt>? = null,
    val plan: PlanSummary? = null,
) {
    @Serializable
    data class PlanSummary(val slug: String? = null, val name: String? = null, val tier: String? = null)

    // The web console's one rule (src/lib/planAccess.ts): a capability is
    // available only when its value is exactly `true`. A key the snapshot does
    // not carry is not available — the server sends every key it knows and
    // denies the ones it does not.

    /** Whether a top-level section belongs in this plan. */
    fun moduleInPlan(key: String): Boolean = modules?.get(key)?.value == true

    /**
     * Whether a capability is actually granted. Fail-closed: a missing key or
     * an unresolved lookup is never treated as enabled.
     */
    fun moduleEnabled(key: String): Boolean = modules?.get(key)?.value == true

    /** Fail-closed, for individual features inside a section. */
    fun featureEnabled(key: String): Boolean = features?.get(key)?.value == true

    fun channelEnabled(key: String): Boolean = channels?.get(key)?.value == true

    fun limit(key: String): Int? = limits?.get(key)?.value

    companion object {
        /**
         * Channel keys the plan itself governs; any other channel inbox is
         * decided by the plugin's own plan check (the catalog's `planAllowed`).
         */
        val PLAN_CHANNELS: Set<String> = setOf(
            "chat_widget", "email", "whatsapp", "sms", "instagram", "telegram", "bale", "gmail", "yahoomail", "voice", "video",
        )

        /**
         * A channel inbox from the plugin catalog (already installed,
         * inbox-capable and `planAllowed`), as the web's `channelInboxVisible`:
         * a channel the plan governs must be on in a snapshot that is in —
         * so not while it loads or cannot be read; any other is the plugin's call.
         */
        fun channelInboxVisible(entitlements: Entitlements?, key: String): Boolean {
            val k = key.lowercase()
            return k !in PLAN_CHANNELS || entitlements?.channelEnabled(k) == true
        }
    }
}

/**
 * How far the plan snapshot has got.
 *
 * The distinction between `Loading` and `Failed` is what stops a plan-gated
 * tab from appearing for a moment and then disappearing: nothing gated is
 * rendered until this resolves either way.
 */
sealed interface EntitlementsState {
    data object Loading : EntitlementsState
    data class Loaded(val entitlements: Entitlements) : EntitlementsState
    data object Failed : EntitlementsState

    val value: Entitlements? get() = (this as? Loaded)?.entitlements
    val isResolved: Boolean get() = this !is Loading
}
