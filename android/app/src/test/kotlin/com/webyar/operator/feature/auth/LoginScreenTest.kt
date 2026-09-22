package com.webyar.operator.feature.auth

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import com.webyar.operator.i18n.Language
import com.webyar.operator.ui.A11y
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * The way in, and the one thing about it that has been reported twice.
 *
 * "The keyboard does not open when I tap the email field" came back after it
 * was first fixed, and the screen had no tests at all — so nothing could have
 * told us whether a change had broken it. These are the assertions that would
 * have.
 *
 * What a JVM test CAN pin: the field exists, it takes focus on arrival
 * without anybody tapping, a tap focuses it, and typing reaches it. Robolectric
 * has no real IME, so whether the soft keyboard physically appears is NOT
 * claimed here — that is the emulator's business, and twice it was the
 * emulator's fault (a hardware keyboard in the AVD, then Gboard left in
 * floating mode). Focus is the part the app controls, and the part that
 * breaks when a modifier order or an inset changes.
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

    /** RTL must not change any of it. The first report was on a Persian screen. */
    @Test
    fun `the same holds in English`() {
        show(Language.EN)
        compose.onNodeWithTag(A11y.LOGIN_EMAIL).assertIsFocused()
        compose.onNodeWithTag(A11y.LOGIN_EMAIL).performTextInput("operator@webyar.app")
        compose.onNodeWithTag(A11y.LOGIN_PASSWORD).performTextInput("a-password")
        compose.onNodeWithTag(A11y.LOGIN_SUBMIT).assertIsEnabled()
    }
}
