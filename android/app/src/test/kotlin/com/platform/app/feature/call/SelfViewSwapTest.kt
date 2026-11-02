package com.platform.app.feature.call

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertContentDescriptionEquals
import androidx.compose.ui.test.assertWidthIsEqualTo
import androidx.compose.ui.test.click
import androidx.compose.ui.test.doubleClick
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.swipe
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import com.platform.app.i18n.Language
import com.platform.app.i18n.StrAndroid
import com.platform.app.ui.A11y
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * The small picture of a video call, touched: a tap swaps the two pictures, a
 * double-tap sizes the card, a drag moves it — and a drag is never read as a
 * tap. And the swap's own memory: it ends with the picture it was made for.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w420dp-h900dp")
class SelfViewSwapTest {

    @get:Rule val compose = createComposeRule()

    private val en = Language.EN

    /**
     * The card alone, over an empty screen 900 dp tall, in a band from 100 dp
     * to 700 dp: well taller than the card at its largest step, at any density.
     */
    @Composable
    private fun Card(swapped: Boolean, onSwap: () -> Unit) {
        val density = LocalDensity.current
        SelfView(
            areaTop = with(density) { 100.dp.toPx() },
            areaBottom = with(density) { 700.dp.toPx() },
            language = en,
            swapped = swapped,
            onSwap = onSwap,
        ) {
            Box(Modifier.fillMaxSize())
        }
    }

    // MARK: - The swap's memory

    @Test
    fun `the swap ends when the own picture goes, and the picture that comes back starts small`() {
        val camera = Any()
        var own by mutableStateOf<Any?>(camera)
        lateinit var swap: MutableState<Boolean>
        compose.setContent { swap = rememberStageSwap(own) }

        compose.runOnIdle { swap.value = true }
        compose.waitForIdle()
        assertTrue(compose.runOnIdle { swap.value })

        // The camera off.
        own = null
        compose.waitForIdle()
        assertFalse(compose.runOnIdle { swap.value })

        // The same track back, as a camera turned on again gives it.
        own = camera
        compose.waitForIdle()
        assertFalse(compose.runOnIdle { swap.value })
    }

    @Test
    fun `a new track in place of the old one starts unswapped too`() {
        var own by mutableStateOf<Any?>(Any())
        lateinit var swap: MutableState<Boolean>
        compose.setContent { swap = rememberStageSwap(own) }

        compose.runOnIdle { swap.value = true }
        compose.waitForIdle()
        own = Any()
        compose.waitForIdle()

        assertFalse(compose.runOnIdle { swap.value })
    }

    // MARK: - What a screen reader is told

    @Test
    fun `the card is one element: what it shows, what is large, and a click that swaps`() {
        var swapped by mutableStateOf(false)
        var swaps = 0
        compose.setContent {
            Card(swapped) {
                swaps++
                swapped = !swapped
            }
        }

        val card = compose.onNodeWithTag(A11y.CALL_SELF_VIEW)
        card.assertContentDescriptionEquals(StrAndroid.callSelfViewYours(en))
        card.assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, StrAndroid.callSelfViewTheyLarge(en)))
        val config = card.fetchSemanticsNode().config
        assertEquals(StrAndroid.callSelfViewSwap(en), config[SemanticsActions.OnClick].label)
        assertEquals(
            listOf(StrAndroid.callSelfViewMove(en), StrAndroid.callSelfViewSmaller(en), StrAndroid.callSelfViewLarger(en)),
            config[SemanticsActions.CustomActions].map { it.label },
        )

        card.performSemanticsAction(SemanticsActions.OnClick)
        compose.waitForIdle()

        assertEquals(1, swaps)
        card.assertContentDescriptionEquals(StrAndroid.callSelfViewTheirs(en))
        card.assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, StrAndroid.callSelfViewYouLarge(en)))
    }

    // MARK: - Touch

    @Test
    fun `a tap swaps, once the double-tap time has passed`() {
        var swaps = 0
        compose.setContent { Card(swapped = false) { swaps++ } }

        compose.onNodeWithTag(A11y.CALL_SELF_VIEW).performTouchInput { click() }
        compose.mainClock.advanceTimeBy(1_000)
        compose.waitForIdle()

        assertEquals(1, swaps)
    }

    @Test
    fun `a double-tap steps the size and does not swap`() {
        var swaps = 0
        compose.setContent { Card(swapped = false) { swaps++ } }
        val card = compose.onNodeWithTag(A11y.CALL_SELF_VIEW)
        card.assertWidthIsEqualTo(SelfViewSize.DEFAULT.dp)

        card.performTouchInput { doubleClick() }
        compose.mainClock.advanceTimeBy(1_000)
        compose.waitForIdle()

        assertEquals(0, swaps)
        card.assertWidthIsEqualTo(150.dp)
    }

    @Test
    fun `a drag moves the card to the corner it was taken to and never swaps`() {
        var swaps = 0
        compose.setContent { Card(swapped = false) { swaps++ } }
        val card = compose.onNodeWithTag(A11y.CALL_SELF_VIEW)
        val before = card.fetchSemanticsNode().boundsInRoot

        // From the bottom right, where it opens, up and to the left by more
        // than twice its own size.
        card.performTouchInput {
            swipe(start = center, end = center - Offset(width * 2.5f, height * 2.5f), durationMillis = 300)
        }
        compose.mainClock.advanceTimeBy(1_000)
        compose.waitForIdle()

        assertEquals(0, swaps)
        val after = card.fetchSemanticsNode().boundsInRoot
        assertTrue("moved left: $before -> $after", after.left < before.left)
        assertTrue("moved up: $before -> $after", after.top < before.top)
    }

    /** Persian and Arabic lay the screen out right to left; the corner stays where it is on the glass. */
    @Test
    fun `right is right in a right-to-left language too`() {
        compose.setContent {
            CompositionLocalProvider(LocalLayoutDirection provides LayoutDirection.Rtl) {
                Card(swapped = false) {}
            }
        }

        val width = compose.onRoot().fetchSemanticsNode().boundsInRoot.width
        val card = compose.onNodeWithTag(A11y.CALL_SELF_VIEW).fetchSemanticsNode().boundsInRoot
        // It opens bottom right.
        assertTrue("card at $card on a screen $width wide", card.left > width / 2f)
    }

    /**
     * And a drag goes where the finger goes: a start-relative offset would
     * mirror the card's x in Persian, so a finger moving left pushed it right.
     */
    @Test
    fun `in a right-to-left language the card follows the finger to the left`() {
        var swaps = 0
        compose.setContent {
            CompositionLocalProvider(LocalLayoutDirection provides LayoutDirection.Rtl) {
                Card(swapped = false) { swaps++ }
            }
        }
        val card = compose.onNodeWithTag(A11y.CALL_SELF_VIEW)
        val screen = compose.onRoot().fetchSemanticsNode().boundsInRoot.width

        // Left by two and a half of its own widths, from the bottom right.
        card.performTouchInput {
            swipe(start = center, end = center - Offset(width * 2.5f, 0f), durationMillis = 300)
        }
        compose.mainClock.advanceTimeBy(1_000)
        compose.waitForIdle()

        assertEquals(0, swaps)
        val after = card.fetchSemanticsNode().boundsInRoot
        assertTrue("card at $after on a screen $screen wide", after.right < screen / 2f)
    }
}
