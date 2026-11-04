package com.platform.app.feature.call

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.lifecycle.ViewModel
import androidx.navigation3.runtime.NavKey
import com.platform.app.i18n.Language
import com.platform.app.ui.design.LocalReducedMotion
import kotlinx.coroutines.flow.MutableStateFlow
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.time.Instant

/**
 * The picture-in-picture window's host: an activity recreated while pinned
 * (a new wallpaper, language or bold text) composes it already in the window,
 * and its first frame must not take "no call read yet" for "the call ended".
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class CallPictureInPictureHostTest {

    @get:Rule val compose = createComposeRule()

    private class Window(override val inWindow: Boolean) : PipWindow {
        var closes = 0
        val specs = mutableListOf<CallPictureInPicture.Spec?>()
        override fun update(next: CallPictureInPicture.Spec?) { specs += next }
        override fun close() { closes++ }
    }

    private class Owner : ViewModel()

    private object Screen : NavKey

    private fun host(window: Window, calls: ActiveCalls) {
        compose.setContent {
            CompositionLocalProvider(LocalReducedMotion provides true) {
                CallPictureInPictureHost(window, calls, Language.EN)
            }
        }
        compose.waitForIdle()
    }

    @Test
    fun `a live call composed already in the window keeps the window`() {
        val calls = ActiveCalls()
        calls.publish(
            ActiveCall(
                owner = Owner(),
                screen = Screen,
                colleague = true,
                state = MutableStateFlow(ActiveCallState(ActiveCallStage.LIVE, since = Instant.now())),
                room = null,
                toggleMute = {},
                hangUp = {},
            ),
        )
        val window = Window(inWindow = true)
        host(window, calls)

        assertEquals(0, window.closes)
        assertNotNull(window.specs.last())
    }

    @Test
    fun `a call over in the window closes it`() {
        val window = Window(inWindow = true)
        host(window, ActiveCalls())
        assertEquals(1, window.closes)
    }
}
