package com.webyar.ai.feature.call

import com.webyar.ai.core.model.CallChannel
import com.webyar.ai.core.net.SampleApi
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Which id is which.
 *
 * `inviteToCall` takes two `String`s that are both UUIDs, and passing them the
 * other way round is caught by nothing else: zod on the server accepts either
 * as a uuid, so the request is well-formed and simply describes a workspace
 * that is really a conversation. The server answers
 * `403 not_a_workspace_member`, the app turns that into "the call could not be
 * connected", and every call an operator places — audio and video alike —
 * fails with a message that points at the network.
 *
 * The order is workspace-first, matching every other method on `WebyarApi`,
 * and the call site names its arguments. This pins the meaning so a future
 * reorder has to break a test rather than a call.
 */
class CallInviteTest {

    @Test
    fun `an invitation comes back for the conversation it was asked for`() = runTest {
        val invitation = SampleApi().inviteToCall(
            workspaceId = "ws-1",
            conversationId = "c-7",
            channel = CallChannel.AUDIO,
        )

        // Not "ws-1": that would be the transposition, and it is the whole bug.
        assertEquals("c-7", invitation.conversationId)
    }

    @Test
    fun `the channel asked for is the channel invited`() = runTest {
        val api = SampleApi()

        assertEquals(
            "audio",
            api.inviteToCall("ws-1", "c-7", CallChannel.AUDIO).channel,
        )
        assertEquals(
            "video",
            api.inviteToCall("ws-1", "c-7", CallChannel.VIDEO).channel,
        )
    }
}
