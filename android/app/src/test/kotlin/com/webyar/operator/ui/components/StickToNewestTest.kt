package com.webyar.operator.ui.components

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * A transcript has to end on its newest message, and stay there while that
 * message finishes measuring itself.
 *
 * This is the shape of a bug that shipped and was seen on device: a photo
 * bubble is short until its bytes decode and then grows by a couple of
 * hundred pixels, so a one-shot scroll left the bottom of every picture
 * under the composer. The first fix watched the last row's height, which
 * only works while that row is on screen — and an animated scroll past rows
 * that are still growing undershoots, so it stopped a bubble short and had
 * nothing to recover from.
 *
 * The test grows the last row after the list has settled, which is the part
 * that a scroll-once implementation cannot survive.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class StickToNewestTest {

    @get:Rule val compose = createComposeRule()

    private val rows = 30

    @Test
    fun `a transcript opens on its newest row`() {
        compose.setContent { Feed(lastRowHeight = 60.dp) }
        compose.waitForIdle()

        compose.onNodeWithTag("row-${rows - 1}").assertIsDisplayed()
    }

    @Test
    fun `the newest row stays in view when it grows afterwards`() {
        var tall by mutableStateOf(false)
        compose.setContent { Feed(lastRowHeight = if (tall) 420.dp else 60.dp) }
        compose.waitForIdle()

        // What a photo does when its bytes land.
        tall = true
        compose.waitForIdle()

        compose.onNodeWithTag("row-${rows - 1}").assertIsDisplayed()
        assertTrue("the list stopped short of its own end", !canScrollForward)
    }

    @Test
    fun `a row growing several times still ends in view`() {
        var height by mutableStateOf(60.dp)
        compose.setContent { Feed(lastRowHeight = height) }
        compose.waitForIdle()

        listOf(140.dp, 280.dp, 420.dp).forEach {
            height = it
            compose.waitForIdle()
        }

        compose.onNodeWithTag("row-${rows - 1}").assertIsDisplayed()
        assertTrue("the list stopped short of its own end", !canScrollForward)
    }

    private lateinit var listState: LazyListState

    /** Read on the composition's thread, which is where the state lives. */
    private val canScrollForward: Boolean
        get() = compose.runOnIdle { listState.canScrollForward }

    @Composable
    private fun Feed(lastRowHeight: Dp) {
        listState = rememberLazyListState()
        StickToNewest(listState, rows)
        LazyColumn(state = listState, modifier = Modifier.size(320.dp, 600.dp)) {
            items(rows) { index ->
                Box(
                    Modifier
                        .fillMaxWidth()
                        .height(if (index == rows - 1) lastRowHeight else 60.dp)
                        .testTag("row-$index"),
                )
            }
        }
    }
}
