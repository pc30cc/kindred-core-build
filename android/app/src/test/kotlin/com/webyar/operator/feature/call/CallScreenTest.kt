package com.webyar.operator.feature.call

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import com.webyar.operator.core.model.CallChannel
import com.webyar.operator.i18n.Language
import com.webyar.operator.i18n.Str
import com.webyar.operator.ui.A11y
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * What the operator is told while a call is happening to them.
 *
 * The screen has one job beyond showing a face: say truthfully where the call
 * is. It has been wrong about that in the most expensive way — reporting "the
 * call could not connect" about a call that was ringing, and then still
 * reporting it while the same call was connected — so the phases are pinned
 * here one by one.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w420dp-h900dp")
class CallScreenTest {

    @get:Rule val compose = createComposeRule()

    private val fa = Language.FA

    private fun screen(
        phase: CallPhase,
        channel: CallChannel = CallChannel.AUDIO,
        onHangUp: () -> Unit = {},
        onDone: () -> Unit = {},
    ) = compose.setContent {
        CallScreen(
            phase = phase,
            channel = channel,
            contactName = "مریم حسینی",
            language = fa,
            onHangUp = onHangUp,
            onDone = onDone,
        )
    }

    // MARK: - What each phase says

    @Test
    fun `waiting says the visitor has not answered yet, not that anything failed`() {
        screen(CallPhase.Waiting)

        compose.onNodeWithTag(A11y.CALL_STATUS).assertTextEquals(Str.inviteSent(fa))
    }

    @Test
    fun `connecting says so`() {
        screen(CallPhase.Connecting)

        compose.onNodeWithTag(A11y.CALL_STATUS).assertTextEquals(Str.connectingCall(fa))
    }

    @Test
    fun `a declined call is not a failed one`() {
        screen(CallPhase.Ended(CallOutcome.Declined))

        compose.onNodeWithTag(A11y.CALL_STATUS).assertTextEquals(Str.callDeclined(fa))
    }

    /** "They said no" and "nobody picked up" are not the same evening. */
    @Test
    fun `nobody answering reads as no answer`() {
        screen(CallPhase.Ended(CallOutcome.Expired))

        compose.onNodeWithTag(A11y.CALL_STATUS).assertTextEquals(Str.callNoAnswer(fa))
    }

    // MARK: - The reason under a failure

    /**
     * The session has always carried the reason and the screen used to drop
     * it, so a 403 and an unreachable network both read "the call could not
     * connect" — which is what sent an operator to check their signal while
     * the server was telling them, precisely, that the ids were transposed.
     */
    @Test
    fun `a failure shows what actually went wrong underneath`() {
        screen(CallPhase.Ended(CallOutcome.Failed("not_a_workspace_member")))

        compose.onNodeWithTag(A11y.CALL_STATUS).assertTextEquals(Str.callFailed(fa))
        compose.onNodeWithTag(A11y.CALL_FAILURE_REASON)
            .assertIsDisplayed()
            .assertTextEquals("not_a_workspace_member")
    }

    /** No reason is better than an empty line pretending to be one. */
    @Test
    fun `a failure with nothing to add shows no second line`() {
        screen(CallPhase.Ended(CallOutcome.Failed("")))

        compose.onNodeWithTag(A11y.CALL_STATUS).assertTextEquals(Str.callFailed(fa))
        compose.onAllNodesWithTagCount(A11y.CALL_FAILURE_REASON, expected = 0)
    }

    @Test
    fun `an ended call keeps its reason line to itself`() {
        screen(CallPhase.Ended(CallOutcome.HungUp))

        compose.onAllNodesWithTagCount(A11y.CALL_FAILURE_REASON, expected = 0)
    }

    // MARK: - The one button

    @Test
    fun `a live call offers to end it`() {
        var hungUp = false
        screen(CallPhase.Connected, onHangUp = { hungUp = true })

        compose.onNodeWithText(Str.hangUpCall(fa)).performClick()

        assertTrue(hungUp)
    }

    /**
     * An ended call must not offer to end it again: the button is the same
     * button, and an operator who taps "end" on a call that is already over
     * has been told nothing by it.
     */
    @Test
    fun `an ended call offers only to leave`() {
        var done = 0
        screen(CallPhase.Ended(CallOutcome.Failed("x")), onDone = { done++ })

        compose.onNodeWithText(Str.done(fa)).performClick()

        assertEquals(1, done)
    }

    /** A voice call has no camera to toggle, so it is not drawn. */
    @Test
    fun `a voice call has no camera button`() {
        screen(CallPhase.Connected, channel = CallChannel.AUDIO)

        compose.onAllNodesWithTagCount(A11y.CALL_CAMERA, expected = 0)
        compose.onNodeWithTag(A11y.CALL_MUTE).assertIsDisplayed()
    }

    @Test
    fun `a video call has one`() {
        screen(CallPhase.Connected, channel = CallChannel.VIDEO)

        compose.onNodeWithTag(A11y.CALL_CAMERA).assertIsDisplayed()
    }

    /** Nothing to toggle on a call that is over. */
    @Test
    fun `an ended call hides the controls`() {
        screen(CallPhase.Ended(CallOutcome.VisitorLeft))

        compose.onAllNodesWithTagCount(A11y.CALL_MUTE, expected = 0)
        compose.onAllNodesWithTagCount(A11y.CALL_SPEAKER, expected = 0)
    }
}

/**
 * How many nodes carry a tag, asserted directly.
 *
 * `assertDoesNotExist` reads well until it fails, where it says only that
 * something existed. Counting says how many, which is the difference between
 * "still drawn" and "drawn twice".
 */
private fun androidx.compose.ui.test.junit4.ComposeContentTestRule.onAllNodesWithTagCount(
    tag: String,
    expected: Int,
) {
    val found = onAllNodes(androidx.compose.ui.test.hasTestTag(tag)).fetchSemanticsNodes().size
    assertEquals("nodes tagged $tag", expected, found)
}
