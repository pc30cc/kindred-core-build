package com.webyar.operator.feature.settings

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import com.webyar.operator.core.model.NotificationPrefs
import com.webyar.operator.core.model.NotificationPrefsUpdate
import com.webyar.operator.i18n.Language
import com.webyar.operator.i18n.Str
import com.webyar.operator.ui.A11y
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * What the screen draws, and what it refuses to draw.
 *
 * The rule under test is the one the deployed server forced: a row exists
 * only where the server sent that key. `api.webyar.ai` answers with
 * `push_scope`, `push_preview` and `push_internal_notes` and no `email_*`;
 * the copy of the route in this repository answers with six `email_*` keys
 * and none of those three. A screen built for either one alone is wrong in
 * front of the other.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class NotificationsScreenTest {

    @get:Rule val compose = createComposeRule()

    /** What `api.webyar.ai` actually answers. */
    private val deployed = NotificationPrefs(
        disableAll = false,
        pushScope = "all",
        pushPreview = true,
        pushInternalNotes = true,
        pushWhenOnline = true,
        pushWhenOffline = true,
        playSound = true,
        quietHoursEnabled = false,
    )

    /** What `server/routes/notifications.ts` in this repository answers. */
    private val inRepo = NotificationPrefs(
        disableAll = false,
        pushWhenOnline = true,
        pushWhenOffline = true,
        pushVisitorBrowsing = false,
        playSound = true,
        emailUnreadMessages = true,
        emailTranscripts = false,
        emailUserRatings = true,
        emailPaidInvoices = true,
        emailWeeklySummary = false,
        emailProductUpdates = false,
        quietHoursEnabled = false,
    )

    private var lastUpdate: NotificationPrefsUpdate? = null

    private fun show(
        prefs: NotificationPrefs?,
        language: Language = Language.EN,
        permission: SystemNotificationPermission? = null,
        state: NotificationsState = NotificationsState(prefs = prefs, loading = false),
    ) = compose.setContent {
        NotificationsScreen(
            language = language,
            state = state,
            systemPermission = permission,
            onSet = { _, field -> lastUpdate = field },
            onRetry = {},
        )
    }

    // MARK: - Drawing what the server sent

    @Test
    fun `the deployed server's keys each get a row`() {
        show(deployed)

        compose.onNodeWithText(Str.notificationsScopeTitle(Language.EN)).assertIsDisplayed()
        compose.onNodeWithText(Str.notificationsPreview(Language.EN)).assertIsDisplayed()
        compose.onNodeWithText(Str.notificationsInternalNotes(Language.EN)).assertIsDisplayed()
        compose.onNodeWithText(Str.notificationsPlaySound(Language.EN)).assertIsDisplayed()
    }

    @Test
    fun `no email section where the server has no email keys`() {
        show(deployed)

        compose.onNodeWithText(Str.notificationsEmailTitle(Language.EN)).assertDoesNotExist()
        compose.onNodeWithText(Str.notificationsEmailUnread(Language.EN)).assertDoesNotExist()
    }

    @Test
    fun `no scope control where the server has no scope`() {
        show(inRepo)

        compose.onNodeWithText(Str.notificationsScopeTitle(Language.EN)).assertDoesNotExist()
        compose.onNodeWithText(Str.notificationsPreview(Language.EN)).assertDoesNotExist()
        // …and its own keys are all there.
        compose.onNodeWithText(Str.notificationsEmailUnread(Language.EN)).assertIsDisplayed()
        compose.onNodeWithText(Str.notificationsNotifyVisitorBrowsing(Language.EN)).assertIsDisplayed()
    }

    // MARK: - The master switch

    @Test
    fun `the master switch leaves the rest visible but dead`() {
        show(deployed.copy(disableAll = true))

        // Shown, not hidden: somebody who silenced everything should be able
        // to see what they silenced.
        compose.onNodeWithText(Str.notificationsPlaySound(Language.EN)).assertIsDisplayed()
        compose.onNodeWithTag(A11y.NOTIFICATIONS_PREVIEW).assertIsNotEnabled()
        compose.onNodeWithTag(A11y.NOTIFICATIONS_QUIET_HOURS).assertIsNotEnabled()
        // …and itself stays live, or there would be no way back.
        compose.onNodeWithTag(A11y.NOTIFICATIONS_DISABLE_ALL).assertIsEnabled()
    }

    @Test
    fun `everything is live while the master switch is off`() {
        show(deployed)

        compose.onNodeWithTag(A11y.NOTIFICATIONS_PREVIEW).assertIsEnabled()
        compose.onNodeWithTag(A11y.NOTIFICATIONS_QUIET_HOURS).assertIsEnabled()
    }

    // MARK: - Sending

    @Test
    fun `picking a scope sends that scope and nothing else`() {
        show(deployed)

        compose.onNodeWithTag(A11y.notificationsScope("mentions")).performClick()

        assertEquals("mentions", lastUpdate?.pushScope)
        assertNull(lastUpdate?.disableAll)
        assertNull(lastUpdate?.playSound)
    }

    /**
     * The flag alone means nothing to the server without a window, and the
     * phone's zone is the only one the operator has told us about.
     */
    @Test
    fun `turning quiet hours on carries a window and a timezone`() {
        show(deployed)

        compose.onNodeWithTag(A11y.NOTIFICATIONS_QUIET_HOURS).performClick()

        assertEquals(true, lastUpdate?.quietHoursEnabled)
        assertEquals("22:00", lastUpdate?.quietHoursStart)
        assertEquals("07:00", lastUpdate?.quietHoursEnd)
        assertTrue(
            "a window with no zone is a window in no particular place",
            !lastUpdate?.quietHoursTimezone.isNullOrBlank(),
        )
    }

    @Test
    fun `the window is hidden while quiet hours are off`() {
        show(deployed)

        compose.onNodeWithTag(A11y.NOTIFICATIONS_QUIET_START).assertDoesNotExist()
    }

    @Test
    fun `the window shows the operator's own hours once it is on`() {
        show(deployed.copy(quietHoursEnabled = true, quietHoursStart = "23:30", quietHoursEnd = "06:15"))

        compose.onNodeWithTag(A11y.NOTIFICATIONS_QUIET_START).assertIsDisplayed()
        compose.onNodeWithText("23:30").assertIsDisplayed()
        compose.onNodeWithText("06:15").assertIsDisplayed()
    }

    // MARK: - The phone's own permission

    @Test
    fun `a phone that refuses notifications says so above the switches`() {
        show(
            deployed,
            permission = SystemNotificationPermission(
                granted = false, canAsk = true, onAsk = {}, onOpenSettings = {},
            ),
        )

        compose.onNodeWithTag(A11y.NOTIFICATIONS_PERMISSION).assertIsDisplayed()
        compose.onNodeWithText(Str.notificationsAllow(Language.EN)).assertIsDisplayed()
    }

    /** Android shows that dialog once; after a no, the settings page is the only way. */
    @Test
    fun `once refused the banner offers the settings page instead`() {
        show(
            deployed,
            permission = SystemNotificationPermission(
                granted = false, canAsk = false, onAsk = {}, onOpenSettings = {},
            ),
        )

        compose.onNodeWithText(Str.notificationsOpenSystemSettings(Language.EN)).assertIsDisplayed()
        compose.onNodeWithText(Str.notificationsAllow(Language.EN)).assertDoesNotExist()
    }

    @Test
    fun `no banner on a phone that allows them`() {
        show(
            deployed,
            permission = SystemNotificationPermission(
                granted = true, canAsk = false, onAsk = {}, onOpenSettings = {},
            ),
        )

        compose.onNodeWithTag(A11y.NOTIFICATIONS_PERMISSION).assertDoesNotExist()
    }

    /** Below API 33 there is no such permission, so there is nothing to warn about. */
    @Test
    fun `no banner where the platform has no permission to grant`() {
        show(deployed, permission = null)

        compose.onNodeWithTag(A11y.NOTIFICATIONS_PERMISSION).assertDoesNotExist()
    }

    // MARK: - Failures

    @Test
    fun `a screen that could not be read offers a retry`() {
        show(prefs = null, state = NotificationsState(prefs = null, loading = false, loadError = "no"))

        compose.onNodeWithTag(A11y.NOTIFICATIONS_RETRY).assertIsDisplayed()
    }

    @Test
    fun `a refused change is said out loud`() {
        show(
            deployed,
            state = NotificationsState(prefs = deployed, loading = false, saveError = "Server problem"),
        )

        compose.onNodeWithTag(A11y.NOTIFICATIONS_SAVE_ERROR).assertIsDisplayed()
        compose.onNodeWithText("Server problem").assertIsDisplayed()
    }
}
