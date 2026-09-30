package com.webyar.ai.feature.settings

import androidx.compose.foundation.layout.Column
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import com.webyar.ai.core.model.SupportStatus
import com.webyar.ai.i18n.Language
import com.webyar.ai.i18n.StrAndroid
import com.webyar.ai.ui.A11y
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Settings → Online support: a chat while the team is online, a ticket while
 * it is not, the operator's requests with what is new in them — and nothing
 * at all where support is not offered.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class SupportSectionTest {

    @get:Rule val compose = createComposeRule()

    private val online = SupportStatus(enabled = true, available = true, online = true, ticketsEnabled = true, teamName = "پشتیبانی")
    private val offline = online.copy(online = false)

    private val opened = mutableListOf<String>()

    private fun show(summary: SupportSummary, language: Language = Language.EN) {
        compose.setContent {
            Column {
                SupportSection(
                    summary = summary,
                    language = language,
                    onStartChat = { opened += "chat" },
                    onNewTicket = { opened += "ticket" },
                    onOpenRequests = { opened += "requests" },
                )
            }
        }
    }

    @Test
    fun `while the team is online, the row starts a chat`() {
        show(SupportSummary(online, requests = 0, unread = 0))

        compose.onNodeWithText(StrAndroid.supportSection(Language.EN)).assertIsDisplayed()
        compose.onNodeWithTag(A11y.SETTINGS_SUPPORT_CHAT).assertIsDisplayed().performClick()
        compose.onNodeWithTag(A11y.SETTINGS_SUPPORT_TICKET).assertDoesNotExist()
        compose.onNodeWithTag(A11y.SETTINGS_SUPPORT_REQUESTS).assertDoesNotExist()
        assertEquals(listOf("chat"), opened)
    }

    @Test
    fun `while nobody is online, the row files a ticket`() {
        show(SupportSummary(offline, requests = 0, unread = 0))

        compose.onNodeWithTag(A11y.SETTINGS_SUPPORT_CHAT).assertDoesNotExist()
        compose.onNodeWithTag(A11y.SETTINGS_SUPPORT_TICKET).assertIsDisplayed().performClick()
        assertEquals(listOf("ticket"), opened)
    }

    @Test
    fun `earlier requests are listed with the count of what is new`() {
        show(SupportSummary(offline, requests = 2, unread = 3))

        compose.onNodeWithTag(A11y.SETTINGS_SUPPORT_REQUESTS).assertIsDisplayed()
        compose.onNodeWithText("3").assertIsDisplayed()
        compose.onNodeWithTag(A11y.SETTINGS_SUPPORT_REQUESTS).performClick()
        assertEquals(listOf("requests"), opened)
    }

    /** Offline with tickets off: no way in, but the requests to follow up stay. */
    @Test
    fun `with tickets off and nobody online, only the requests remain`() {
        show(SupportSummary(offline.copy(ticketsEnabled = false), requests = 1, unread = 0))

        compose.onNodeWithTag(A11y.SETTINGS_SUPPORT_CHAT).assertDoesNotExist()
        compose.onNodeWithTag(A11y.SETTINGS_SUPPORT_TICKET).assertDoesNotExist()
        compose.onNodeWithTag(A11y.SETTINGS_SUPPORT_REQUESTS).assertIsDisplayed()
    }

    @Test
    fun `support that is off, or the team's own operator, shows nothing`() {
        val off = SupportSummary(SupportStatus(), requests = 0, unread = 0)
        val member = SupportSummary(online.copy(available = false), requests = 1, unread = 1)
        assertFalse(off.shown)
        assertFalse(member.shown)
        assertTrue(SupportSummary(online, 0, 0).shown)

        show(member)

        compose.onNodeWithText(StrAndroid.supportSection(Language.EN)).assertDoesNotExist()
        compose.onNodeWithTag(A11y.SETTINGS_SUPPORT_CHAT).assertDoesNotExist()
        compose.onNodeWithTag(A11y.SETTINGS_SUPPORT_REQUESTS).assertDoesNotExist()
    }
}
