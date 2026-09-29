package com.webyar.ai.feature.promo

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.platform.UriHandler
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import com.webyar.ai.core.model.PromoCreative
import com.webyar.ai.i18n.Language
import com.webyar.ai.ui.A11y
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * A promotion's button on a phone that has nothing to open a link with.
 *
 * Compose's own handler throws there — a work profile with the browser
 * switched off is enough — and a throw out of a click closes the app. The
 * button may do nothing; it may not take the app down.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class PromoViewsTest {

    @get:Rule val compose = createComposeRule()

    private val creative = PromoCreative(
        title = "Webyar Pro",
        body = "Answer faster.",
        ctaLabel = "See plans",
        ctaUrl = "https://webyar.ai/pricing",
    )

    /** What a phone with no browser does when asked to open a link. */
    private class NoBrowser : UriHandler {
        val asked = mutableListOf<String>()
        override fun openUri(uri: String) {
            asked += uri
            throw IllegalArgumentException("Can't open $uri.")
        }
    }

    @Test
    fun `the banner's link with no browser to open it does not crash`() {
        val handler = NoBrowser()
        compose.setContent {
            CompositionLocalProvider(LocalUriHandler provides handler) {
                PromoBanner(creative, Language.EN, onDismiss = {})
            }
        }

        compose.onNodeWithText("See plans").performClick()
        compose.waitForIdle()

        assertEquals(listOf("https://webyar.ai/pricing"), handler.asked)
        compose.onNodeWithTag(A11y.PROMO_BANNER).assertIsDisplayed()
    }

    @Test
    fun `the full-screen button with no browser still closes the card`() {
        val handler = NoBrowser()
        var dismissed = false
        compose.setContent {
            CompositionLocalProvider(LocalUriHandler provides handler) {
                PromoFullScreen(creative, Language.EN, onDismiss = { dismissed = true })
            }
        }

        compose.onNodeWithText("See plans").performClick()
        compose.waitForIdle()

        assertEquals(listOf("https://webyar.ai/pricing"), handler.asked)
        assertTrue(dismissed)
    }
}
