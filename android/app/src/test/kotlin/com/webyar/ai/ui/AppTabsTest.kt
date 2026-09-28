package com.webyar.ai.ui

import com.webyar.ai.core.model.EffectiveBool
import com.webyar.ai.core.model.Entitlements
import com.webyar.ai.core.model.EntitlementsState
import com.webyar.ai.core.model.MobileAppConfig
import com.webyar.ai.core.model.WorkspaceAccess
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

/**
 * Which tabs the bar shows: the plan decides what exists (the web's
 * `planAccess.ts`), the role keeps Website analytics to owners and admins,
 * and Super Admin's switches for the Android app can only take a tab away.
 */
class AppTabsTest {

    private fun plan(vararg modules: String) = EntitlementsState.Loaded(
        Entitlements(workspaceId = "w1", modules = modules.associateWith { EffectiveBool(value = true, source = "plan") }),
    )

    private val owner = WorkspaceAccess(role = "owner")
    private val agent = WorkspaceAccess(role = "agent")
    private val everything = plan("contacts", "visitor_tracking", "web_analytics")

    @Test
    fun `an owner whose plan has them gets both tabs, in the bar's order`() {
        assertEquals(
            listOf(AppTab.INBOX, AppTab.CONTACTS, AppTab.VISITORS, AppTab.ANALYTICS, AppTab.SETTINGS),
            appTabsFor(everything, owner, MobileAppConfig.DEFAULT),
        )
    }

    @Test
    fun `an agent sees the visitors but not the website analytics`() {
        val tabs = appTabsFor(everything, agent, MobileAppConfig.DEFAULT)
        assertEquals(listOf(AppTab.INBOX, AppTab.CONTACTS, AppTab.VISITORS, AppTab.SETTINGS), tabs)
        // Nor while the role is not yet known.
        assertFalse(AppTab.ANALYTICS in appTabsFor(everything, WorkspaceAccess.UNKNOWN, MobileAppConfig.DEFAULT))
    }

    @Test
    fun `a plan without them shows neither, whatever the switches say`() {
        assertEquals(
            listOf(AppTab.INBOX, AppTab.CONTACTS, AppTab.SETTINGS),
            appTabsFor(plan("contacts"), owner, MobileAppConfig(showVisitors = true, showWebAnalytics = true)),
        )
    }

    @Test
    fun `Super Admin's switches take a tab away`() {
        assertEquals(
            listOf(AppTab.INBOX, AppTab.CONTACTS, AppTab.ANALYTICS, AppTab.SETTINGS),
            appTabsFor(everything, owner, MobileAppConfig(showVisitors = false)),
        )
        assertEquals(
            listOf(AppTab.INBOX, AppTab.CONTACTS, AppTab.VISITORS, AppTab.SETTINGS),
            appTabsFor(everything, owner, MobileAppConfig(showWebAnalytics = false)),
        )
    }

    @Test
    fun `nothing gated shows while the plan loads or cannot be read`() {
        for (state in listOf(EntitlementsState.Loading, EntitlementsState.Failed)) {
            assertEquals(listOf(AppTab.INBOX, AppTab.SETTINGS), appTabsFor(state, owner, MobileAppConfig.DEFAULT))
        }
    }

    /** `GET /api/mobile-app/config?platform=android`: the switches' keys, and on when an older server sends neither. */
    @Test
    fun `the switches decode from the server's keys and default to on`() {
        val json = Json { ignoreUnknownKeys = true; explicitNulls = false; coerceInputValues = true }
        val off = json.decodeFromString(
            MobileAppConfig.serializer(),
            """{"platform":"android","showVisitors":false,"showWebAnalytics":false}""",
        )
        assertFalse(off.showVisitors)
        assertFalse(off.showWebAnalytics)
        val old = json.decodeFromString(MobileAppConfig.serializer(), """{"platform":"android"}""")
        assertEquals(true, old.showVisitors)
        assertEquals(true, old.showWebAnalytics)
    }
}
