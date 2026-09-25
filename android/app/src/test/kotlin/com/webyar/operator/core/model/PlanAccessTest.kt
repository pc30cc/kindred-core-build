package com.webyar.operator.core.model

import com.webyar.operator.feature.chat.ComposerCapabilities
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The plan, read by the web console's one rule (src/lib/planAccess.ts) — the
 * same expectations as windows-native's PlanTests: a capability is on only
 * when the snapshot is in and says exactly true; nothing gated shows while it
 * loads or when it cannot be read; a key the snapshot does not carry is off;
 * channel inboxes the plan does not govern are the plugin catalog's call.
 */
class PlanAccessTest {

    private fun flags(vararg pairs: Pair<String, Boolean?>) =
        pairs.associate { (key, value) -> key to EffectiveBool(value = value, source = "plan") }

    private fun plan(
        modules: Map<String, EffectiveBool> = emptyMap(),
        features: Map<String, EffectiveBool> = emptyMap(),
        channels: Map<String, EffectiveBool> = emptyMap(),
    ) = Entitlements(workspaceId = "w1", modules = modules, features = features, channels = channels)

    @Test
    fun `a key the snapshot does not carry is not available`() {
        val empty = plan()
        assertFalse(empty.moduleInPlan("contacts"))
        assertFalse(empty.featureEnabled("inbox_team_chat"))
        assertFalse(Entitlements.channelInboxVisible(empty, "telegram"))
        assertEquals(CallChannels.NONE, CallChannels.resolve(empty))
        // No bucket at all is no different.
        assertFalse(Entitlements(workspaceId = "w1").moduleInPlan("contacts"))
    }

    @Test
    fun `only exactly true turns a key on`() {
        val p = plan(modules = flags("contacts" to true, "visitor_tracking" to false, "call_center" to null))
        assertTrue(p.moduleInPlan("contacts"))
        assertFalse(p.moduleInPlan("visitor_tracking"))
        assertFalse(p.moduleInPlan("call_center"))
    }

    @Test
    fun `nothing gated shows while loading or when the plan cannot be read`() {
        for (state in listOf(EntitlementsState.Loading, EntitlementsState.Failed)) {
            val value = state.value
            assertFalse(value?.moduleInPlan("contacts") == true)
            assertFalse(InboxFilter.available(value).contains(InboxFilter.AI))
            assertFalse(InboxFilter.available(value).contains(InboxFilter.NEEDS_HUMAN))
            assertEquals(CallChannels.NONE, CallChannels.resolve(value))
            assertFalse(Entitlements.channelInboxVisible(value, "telegram"))
            // Not a plan channel: the plugin's own plan check decides.
            assertTrue(Entitlements.channelInboxVisible(value, "x"))
        }
    }

    @Test
    fun `voice and video calls need the module and their channel exactly on`() {
        assertEquals(CallChannels.NONE, CallChannels.resolve(plan(modules = flags("voice_video" to false), channels = flags("voice" to true))))
        assertEquals(CallChannels.NONE, CallChannels.resolve(plan(channels = flags("voice" to true, "video" to true))))
        assertEquals(
            CallChannels(voice = true, video = false),
            CallChannels.resolve(plan(modules = flags("voice_video" to true), channels = flags("voice" to true))),
        )
    }

    @Test
    fun `channel inboxes the plan governs need it on`() {
        val p = plan(channels = flags("telegram" to true, "whatsapp" to false))
        assertTrue(Entitlements.channelInboxVisible(p, "telegram"))
        assertFalse(Entitlements.channelInboxVisible(p, "WhatsApp"))
        assertFalse(Entitlements.channelInboxVisible(p, "bale")) // a plan channel the snapshot does not turn on
        assertTrue(Entitlements.channelInboxVisible(p, "x"))
    }

    @Test
    fun `the inbox queues follow the inbox features`() {
        val p = plan(
            features = flags("inbox_ai_queue" to false, "inbox_needs_human" to true),
            modules = flags("inbox_ai_queue" to true),
        )
        assertFalse(InboxFilter.available(p).contains(InboxFilter.AI)) // a feature, not a module
        assertTrue(InboxFilter.available(p).contains(InboxFilter.NEEDS_HUMAN))
    }

    @Test
    fun `the composer is not gated by the widget keys`() {
        val human = Conversation(id = "c1", workspaceId = "w1", aiState = "human_active")
        val tools = ComposerCapabilities.resolve(human)
        assertTrue(tools.canAttach && tools.canRecordVoice && tools.canUseEmoji)
        assertFalse(tools.isAiManaged)
        val team = ComposerCapabilities.TEAM
        assertTrue(team.canAttach && team.canRecordVoice && team.canUseEmoji)
    }

    @Test
    fun `the AI owning the thread still hides the composer tools`() {
        val ai = ComposerCapabilities.resolve(Conversation(id = "c1", workspaceId = "w1", aiState = "ai_managed"))
        assertTrue(ai.isAiManaged)
        assertFalse(ai.hasAnyControl)
        assertEquals(ComposerCapabilities.NONE, ComposerCapabilities.resolve(null))
    }
}
