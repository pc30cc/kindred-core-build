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

    // These mirror `AppSidebar.tsx` exactly, including the difference between
    // the two. Getting them the same way round matters: one decides whether a
    // whole menu exists, the other whether a single action is allowed.

    /**
     * Whether a top-level section belongs in this plan.
     *
     * A key the registry does not know about counts as visible, so a module
     * added server-side does not vanish from an older build. An explicit
     * `false` hides it.
     */
    fun moduleInPlan(key: String): Boolean {
        val modules = modules ?: return false
        val state = modules[key] ?: return true
        return state.value == true
    }

    /**
     * Whether a capability is actually granted. Fail-closed: a missing key or
     * an unresolved lookup is never treated as enabled.
     */
    fun moduleEnabled(key: String): Boolean = modules?.get(key)?.value == true

    /** Fail-closed, for individual features inside a section. */
    fun featureEnabled(key: String): Boolean = features?.get(key)?.value == true

    fun channelEnabled(key: String): Boolean = channels?.get(key)?.value == true

    fun limit(key: String): Int? = limits?.get(key)?.value
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
