package com.platform.app.core.model

// The mobile app as a plan feature (docs/operations/MOBILE_APP_PLAN.md): Super
// Admin switches the iPhone and Android apps on or off per plan, and a
// workspace whose plan has it off shows the whole app faded under one card,
// with nothing in it working.

/** The plan registry's key (`server/services/billing/capabilityRegistry.ts`). */
const val MOBILE_APP_FEATURE = "mobile_app"

/**
 * The plan says, in so many words, that the mobile app is off.
 *
 * The one plan gate that fails OPEN. Every other gate in this app asks for
 * exactly `true` ([Entitlements.featureEnabled]), so a plan that is loading,
 * could not be read or does not carry a key hides what it gates. This one
 * locks only on an explicit `false`: a missing key, or one without a value,
 * never locks — the key's default is on, and a network blip must not lock a
 * whole team out of their phones. The iOS app's `Entitlements.mobileAppLocked`.
 */
val Entitlements.mobileAppLocked: Boolean
    get() = features?.get(MOBILE_APP_FEATURE)?.value == false

/** Locked only by a snapshot in hand that says `false`: [EntitlementsState.Loading] and [EntitlementsState.Failed] never lock. */
val EntitlementsState.mobileAppLocked: Boolean
    get() = value?.mobileAppLocked == true

/**
 * Which workspaces' plans last said the mobile app is off, after a snapshot
 * of [workspaceId]'s plan said [locked] — the iOS app's `MobileAppLock.record`.
 * Only ever applied for a snapshot that was read: a failed read changes
 * nothing, and a read with the key on, or without it, takes the workspace off.
 */
fun Set<String>.withMobileAppLock(workspaceId: String, locked: Boolean): Set<String> = when {
    workspaceId.isBlank() -> this
    locked -> this + workspaceId
    else -> this - workspaceId
}

/**
 * Where the lock card's Open the website goes on Android: the web panel's
 * billing page, `<panel origin>/app/billing` (docs/operations/MOBILE_APP_PLAN.md).
 * Null without an https panel origin — there is then no button to show.
 */
fun mobileAppBillingUrl(panelOrigin: String?): String? {
    val origin = panelOrigin?.trim()?.trimEnd('/')?.takeIf { it.startsWith("https://") && it.length > "https://".length }
        ?: return null
    return "$origin$BILLING_PATH"
}

/** The web panel's billing page (`src/App.tsx`, `/app/billing`). */
private const val BILLING_PATH = "/app/billing"
