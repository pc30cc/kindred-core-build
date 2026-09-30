package com.webyar.ai.feature.auth

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.assertIsNotFocused
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import com.webyar.ai.i18n.Language
import com.webyar.ai.i18n.Str
import com.webyar.ai.i18n.StrAndroid
import com.webyar.ai.ui.A11y
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * The way in: the keyboard must open on the email field.
 *
 * What a JVM test CAN pin: the field exists, it takes focus on arrival
 * without anybody tapping, a tap focuses it, and typing reaches it. Robolectric
 * has no real IME, so whether the soft keyboard physically appears is NOT
 * claimed here — that depends on the device's own keyboard settings. Focus is
 * the part the app controls, and the part that breaks when a modifier order
 * or an inset changes.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class LoginScreenTest {

    @get:Rule val compose = createComposeRule()

    private fun show(language: Language = Language.FA) {
        compose.setContent {
            LoginScreen(language = language, onSubmit = { _, _ -> Result.success(Unit) })
        }
    }

    /**
     * The whole screen is one form with one thing to do, so the field takes
     * focus on arrival. Making somebody tap first is a tap that carries no
     * information — and when the tap is the ONLY way in, a screen that does
     * not respond to it has no way in at all.
     */
    @Test
    fun `the email field takes focus without being tapped`() {
        show()
        compose.onNodeWithTag(A11y.LOGIN_EMAIL).assertIsFocused()
    }

    /**
     * Under the maintenance notice the field waits: focused there, it would put
     * the keyboard over the notice and every key into a field nobody can see.
     * It takes focus once the notice goes.
     */
    @Test
    fun `the email field waits while the maintenance notice covers the screen`() {
        var covered by mutableStateOf(true)
        compose.setContent {
            LoginScreen(language = Language.EN, onSubmit = { _, _ -> Result.success(Unit) }, covered = covered)
        }
        compose.onNodeWithTag(A11y.LOGIN_EMAIL).assertIsNotFocused()

        covered = false
        compose.onNodeWithTag(A11y.LOGIN_EMAIL).assertIsFocused()
    }

    @Test
    fun `both fields are there and reachable`() {
        show()
        compose.onNodeWithTag(A11y.LOGIN_EMAIL).assertIsDisplayed()
        compose.onNodeWithTag(A11y.LOGIN_PASSWORD).assertIsDisplayed()
    }

    /** A tap must focus it too — auto-focus is lost the moment anything else takes it. */
    @Test
    fun `tapping the email field focuses it`() {
        show()
        compose.onNodeWithTag(A11y.LOGIN_PASSWORD).performClick()
        compose.onNodeWithTag(A11y.LOGIN_PASSWORD).assertIsFocused()

        compose.onNodeWithTag(A11y.LOGIN_EMAIL).performClick()
        compose.onNodeWithTag(A11y.LOGIN_EMAIL).assertIsFocused()
    }

    /**
     * Typing reaches the field. A field that is focused and swallows input is
     * indistinguishable, to the person holding the phone, from one that never
     * focused.
     */
    @Test
    fun `typing reaches both fields`() {
        show()
        compose.onNodeWithTag(A11y.LOGIN_EMAIL).performTextInput("operator@webyar.app")
        compose.onNodeWithTag(A11y.LOGIN_PASSWORD).performTextInput("a-password")

        // The button is the proof: it enables only when both carry something.
        compose.onNodeWithTag(A11y.LOGIN_SUBMIT).assertIsEnabled()
    }

    @Test
    fun `sign in stays disabled until both fields have something`() {
        show()
        compose.onNodeWithTag(A11y.LOGIN_SUBMIT).assertIsNotEnabled()

        compose.onNodeWithTag(A11y.LOGIN_EMAIL).performTextInput("operator@webyar.app")
        compose.onNodeWithTag(A11y.LOGIN_SUBMIT).assertIsNotEnabled()

        compose.onNodeWithTag(A11y.LOGIN_PASSWORD).performTextInput("a-password")
        compose.onNodeWithTag(A11y.LOGIN_SUBMIT).assertIsEnabled()
    }

    /** The direction of the layout must not change any of it. */
    @Test
    fun `the same holds in English`() {
        show(Language.EN)
        compose.onNodeWithTag(A11y.LOGIN_EMAIL).assertIsFocused()
        compose.onNodeWithTag(A11y.LOGIN_EMAIL).performTextInput("operator@webyar.app")
        compose.onNodeWithTag(A11y.LOGIN_PASSWORD).performTextInput("a-password")
        compose.onNodeWithTag(A11y.LOGIN_SUBMIT).assertIsEnabled()
    }

    // MARK: - The signature and the way back from "forgot password"

    /** iOS signs sign-in with "WEBYAR AI" at the foot; so does this screen. */
    @Test
    fun `the brand signature is at the foot of sign in`() {
        show()
        compose.onNodeWithTag(A11y.BRAND_FOOTER).assertIsDisplayed()
    }

    /**
     * "Forgot password?" is a place with its own way back, as on iOS: the
     * arrow at the top, not a second button under the form. Whatever address
     * was typed there comes back with it.
     */
    @Test
    fun `forgot password opens the reset screen and its arrow comes back`() {
        compose.setContent {
            LoginScreen(
                language = Language.EN,
                onSubmit = { _, _ -> Result.success(Unit) },
                onRequestReset = { Result.success(Unit) },
            )
        }
        compose.onNodeWithTag(A11y.LOGIN_EMAIL).performTextInput("operator@webyar.app")
        compose.onNodeWithText(Str.forgotPassword(Language.EN)).performClick()

        compose.onNodeWithText(Str.resetTitle(Language.EN)).assertIsDisplayed()
        compose.onNodeWithTag(A11y.BRAND_FOOTER).assertIsDisplayed()

        compose.onNodeWithTag(A11y.RESET_BACK).performClick()
        compose.onNodeWithTag(A11y.LOGIN_EMAIL).assertTextContains("operator@webyar.app")
    }

    /** The launch's own screen: iOS's — the loader turning and the signature, no mark, no text. */
    @Test
    fun `the restoring screen is the loader and the signature`() {
        compose.setContent { RestoringScreen(Language.EN) }
        compose.onNodeWithTag(A11y.RESTORING).assertIsDisplayed()
        compose.onNodeWithContentDescription(StrAndroid.restoringSession(Language.EN)).assertIsDisplayed()
        compose.onNodeWithText(StrAndroid.restoringSession(Language.EN)).assertDoesNotExist()
        compose.onNodeWithTag(A11y.BRAND_FOOTER).assertIsDisplayed()
    }
}
