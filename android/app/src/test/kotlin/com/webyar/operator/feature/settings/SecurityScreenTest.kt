package com.webyar.operator.feature.settings

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.filter
import androidx.compose.ui.test.filterToOne
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import com.webyar.operator.core.model.AccountSession
import com.webyar.operator.i18n.Language
import com.webyar.operator.i18n.Str
import com.webyar.operator.ui.A11y
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * The screen that answers "is my account still mine?".
 *
 * Everything here is destructive in one direction or another, so the
 * assertions are mostly about what the screen refuses to offer: a revoke
 * control on the session you are holding, a "sign out everywhere" button
 * that would end nothing, and a submit button for a password the server is
 * going to reject anyway.
 */
@RunWith(RobolectricTestRunner::class)
// Tall enough for the whole list to compose. A `LazyColumn` in a phone-sized
// window never builds what is below the fold, which would make every "this
// is not on the screen" assertion below pass without testing anything.
@Config(sdk = [34], qualifiers = "w420dp-h3000dp")
class SecurityScreenTest {

    @get:Rule val compose = createComposeRule()

    private val en = Language.EN

    private fun session(id: String, isCurrent: Boolean? = null) = AccountSession(
        id = id,
        browser = "Webyar",
        os = "Android",
        city = "Istanbul",
        country = "Turkiye",
        isCurrent = isCurrent,
    )

    private fun screen(
        sessions: List<AccountSession>,
        currentSessionId: String? = null,
        currentPassword: String = "",
        newPassword: String = "",
        busy: Boolean = false,
        onRevoke: (AccountSession) -> Unit = {},
        onRevokeOthers: () -> Unit = {},
        onChangePassword: () -> Unit = {},
    ) {
        compose.setContent {
            SecurityScreen(
                language = en,
                currentPassword = currentPassword,
                newPassword = newPassword,
                sessions = sessions,
                currentSessionId = currentSessionId,
                busy = busy,
                message = null,
                isError = false,
                onCurrentPasswordChange = {},
                onNewPasswordChange = {},
                onChangePassword = onChangePassword,
                onRevoke = onRevoke,
                onRevokeOthers = onRevokeOthers,
            )
        }
    }

    /**
     * The one that matters. Revoking the session you are holding signs you out
     * mid-tap, which reads as a crash rather than as a choice — so the row for
     * this device carries a badge and no control at all.
     */
    @Test
    fun theSessionYouAreHoldingOffersNoWayToEndIt() {
        screen(sessions = listOf(session("a", isCurrent = true), session("b")))

        compose.onNodeWithText(Str.thisDevice(en)).assertIsDisplayed()
        // Two sessions, but only the other one may be ended.
        assertEquals(
            1,
            compose.onAllNodesWithText(Str.revokeSession(en)).fetchSemanticsNodes().size,
        )
    }

    /**
     * `is_current` comes from the server and `current_session_id` comes from
     * the same response's envelope; either one alone has to be enough, because
     * the deployed API does not always send both.
     */
    @Test
    fun currentSessionIdIdentifiesThisDeviceOnItsOwn() {
        screen(
            sessions = listOf(session("a"), session("b")),
            currentSessionId = "a",
        )

        compose.onNodeWithText(Str.thisDevice(en)).assertIsDisplayed()
        assertEquals(
            1,
            compose.onAllNodesWithText(Str.revokeSession(en)).fetchSemanticsNodes().size,
        )
    }

    @Test
    fun signOutEverywhereElseIsHiddenWhenThisIsTheOnlyDevice() {
        screen(sessions = listOf(session("a", isCurrent = true)))

        compose.onNodeWithTag(A11y.SECURITY_REVOKE_OTHERS).assertDoesNotExist()
    }

    @Test
    fun signOutEverywhereElseIsHiddenWhenThereAreNoSessionsAtAll() {
        screen(sessions = emptyList())

        compose.onNodeWithTag(A11y.SECURITY_REVOKE_OTHERS).assertDoesNotExist()
    }

    @Test
    fun signOutEverywhereElseAppearsAndReportsOnceWhenThereIsAnotherDevice() {
        var calls = 0
        screen(
            sessions = listOf(session("a", isCurrent = true), session("b")),
            onRevokeOthers = { calls++ },
        )

        compose.onNodeWithTag(A11y.SECURITY_REVOKE_OTHERS).assertIsEnabled().performClick()
        assertEquals(1, calls)
    }

    /** A second tap while the first is still in flight would end nothing twice. */
    @Test
    fun signOutEverywhereElseIsDeadWhileTheLastRequestIsInFlight() {
        screen(
            sessions = listOf(session("a", isCurrent = true), session("b")),
            busy = true,
        )

        compose.onNodeWithTag(A11y.SECURITY_REVOKE_OTHERS).assertIsNotEnabled()
    }

    @Test
    fun revokeReportsTheRowThatWasTapped() {
        var ended: AccountSession? = null
        screen(
            sessions = listOf(session("a", isCurrent = true), session("b")),
            onRevoke = { ended = it },
        )

        compose.onAllNodesWithText(Str.revokeSession(en))[0].performClick()
        assertEquals("b", ended?.id)
    }

    /**
     * The eight-character rule is the server's; checking it here only saves a
     * round trip. What the button must not do is offer to send something that
     * is going to come back as an error.
     */
    @Test
    fun changePasswordStaysDeadWhenNeitherFieldIsFilled() {
        screen(sessions = emptyList())

        compose.onAllNodesWithText(Str.changePassword(en))
            .filterToOne(hasClickAction())
            .assertIsNotEnabled()
    }

    @Test
    fun changePasswordStaysDeadOnAPasswordOneCharacterTooShort() {
        screen(
            sessions = emptyList(),
            currentPassword = "whatever",
            newPassword = "1234567",
        )

        compose.onAllNodesWithText(Str.changePassword(en))
            .filterToOne(hasClickAction())
            .assertIsNotEnabled()
    }

    @Test
    fun changePasswordStaysDeadWhenOnlyTheNewPasswordIsFilled() {
        screen(
            sessions = emptyList(),
            currentPassword = "",
            newPassword = "12345678",
        )

        compose.onAllNodesWithText(Str.changePassword(en))
            .filterToOne(hasClickAction())
            .assertIsNotEnabled()
    }

    @Test
    fun changePasswordComesAliveOnceBothFieldsPass() {
        var submitted = 0
        screen(
            sessions = emptyList(),
            currentPassword = "whatever",
            newPassword = "12345678",
            onChangePassword = { submitted++ },
        )

        compose.onAllNodesWithText(Str.changePassword(en))
            .filterToOne(hasClickAction())
            .assertIsEnabled()
            .performClick()
        assertEquals(1, submitted)
    }

    /**
     * A submit in flight has to close both doors. `PrimaryButton` swaps the
     * label for a spinner while busy, so the only node left carrying this
     * string is the section heading above the form — and a heading is not
     * tappable. Underneath, the button is `enabled && !busy` as well; either
     * alone would stop a second submit, and the assertion is written against
     * the one a person actually experiences.
     */
    @Test
    fun changePasswordCannotBeSubmittedAgainWhileTheFirstIsInFlight() {
        screen(
            sessions = emptyList(),
            currentPassword = "whatever",
            newPassword = "12345678",
            busy = true,
        )

        assertEquals(
            0,
            compose.onAllNodesWithText(Str.changePassword(en))
                .filter(hasClickAction())
                .fetchSemanticsNodes().size,
        )
    }

    /** A sanity check that `assertDoesNotExist` above is not passing for free. */
    @Test
    fun theListItselfIsOnTheScreen() {
        screen(sessions = listOf(session("a", isCurrent = true), session("b")))

        compose.onNodeWithText(Str.activeSessions(en)).assertIsDisplayed()
        compose.onNodeWithTag(A11y.SECURITY_REVOKE_OTHERS).assertIsDisplayed()
    }
}
