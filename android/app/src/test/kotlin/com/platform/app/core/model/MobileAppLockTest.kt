package com.platform.app.core.model

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The mobile app as a plan feature (docs/operations/MOBILE_APP_PLAN.md): the
 * one plan gate that fails open. Locked only on an explicit `false`; loading,
 * a failed read, a missing key or a key without a value never lock.
 */
class MobileAppLockTest {

    private fun plan(value: Boolean?, source: String = "plan") =
        Entitlements(features = mapOf(MOBILE_APP_FEATURE to EffectiveBool(value, source)))

    @Test
    fun `only an explicit false locks`() {
        assertTrue(plan(false).mobileAppLocked)
        assertFalse(plan(true).mobileAppLocked)
        assertFalse("a key without a value", plan(null).mobileAppLocked)
        assertFalse("a plan without the key", Entitlements(features = mapOf("team_calls" to EffectiveBool(false))).mobileAppLocked)
        assertFalse("a snapshot without features", Entitlements().mobileAppLocked)
    }

    @Test
    fun `loading and a failed read never lock`() {
        assertFalse(EntitlementsState.Loading.mobileAppLocked)
        assertFalse(EntitlementsState.Failed.mobileAppLocked)
        assertTrue(EntitlementsState.Loaded(plan(false)).mobileAppLocked)
        assertFalse(EntitlementsState.Loaded(plan(true)).mobileAppLocked)
        assertFalse(EntitlementsState.Loaded(Entitlements()).mobileAppLocked)
    }

    /** Unlike every other gate, which asks for exactly `true`. */
    @Test
    fun `the other gates still fail closed`() {
        assertFalse(Entitlements().featureEnabled(MOBILE_APP_FEATURE))
        assertFalse(Entitlements().mobileAppLocked)
    }

    @Test
    fun `the key is the registry's`() {
        assertEquals("mobile_app", MOBILE_APP_FEATURE)
    }

    /** What the phone remembers for a ring and a tap: each read's verdict, per workspace. */
    @Test
    fun `each read records its workspace, and only its own`() {
        val none = emptySet<String>()
        val one = none.withMobileAppLock("ws-1", locked = true)
        assertEquals(setOf("ws-1"), one)
        val two = one.withMobileAppLock("ws-2", locked = true)
        assertEquals(setOf("ws-1", "ws-2"), two)
        assertEquals(setOf("ws-2"), two.withMobileAppLock("ws-1", locked = false))
        assertEquals(one, one.withMobileAppLock("ws-3", locked = false))
        assertEquals(one, one.withMobileAppLock(" ", locked = true))
    }

    @Test
    fun `the website button opens the panel's billing page`() {
        assertEquals("https://app.webyar.ai/app/billing", mobileAppBillingUrl("https://app.webyar.ai"))
        assertEquals("https://app.respok.app/app/billing", mobileAppBillingUrl("https://app.respok.app/"))
        assertNull("no panel known, no button", mobileAppBillingUrl(null))
        assertNull(mobileAppBillingUrl(""))
        assertNull("never http", mobileAppBillingUrl("http://app.webyar.ai"))
        assertNull(mobileAppBillingUrl("https://"))
    }
}
