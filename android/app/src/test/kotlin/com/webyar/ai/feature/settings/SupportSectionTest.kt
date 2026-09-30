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
 * Settings → Online support: one row into the chat, saying whether the team
 * is there and how much it wrote that is unread — and nothing at all where
 * support is not offered, or Super Admin hides it from the app.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class SupportSectionTest {

    @get:Rule val compose = createComposeRule()

    private val online = SupportStatus(enabled = true, available = true, online = true, teamName = "پشتیبانی")
    private val offline = online.copy(online = false)

    private val opened = mutableListOf<String>()

    private fun show(summary: SupportSummary, language: Language = Language.EN) {
        compose.setContent {
            Column {
                SupportSection(
                    summary = summary,
                    language = language,
                    onOpenChat = { opened += "chat" },
                )
            }
        }
    }

    @Test
    fun `one row opens the chat, and says the team is online`() {
        show(SupportSummary(online))

        compose.onNodeWithText(StrAndroid.supportSection(Language.EN)).assertIsDisplayed()
        compose.onNodeWithText(StrAndroid.supportOnline(Language.EN)).assertIsDisplayed()
        compose.onNodeWithText(StrAndroid.supportOfflineLeaveMessage(Language.EN)).assertDoesNotExist()
        compose.onNodeWithTag(A11y.SETTINGS_SUPPORT_CHAT).assertIsDisplayed().performClick()
        assertEquals(listOf("chat"), opened)
    }

    /** Offline is the same row: a message still reaches the team. */
    @Test
    fun `offline, the row asks for a message`() {
        show(SupportSummary(offline), Language.FA)

        compose.onNodeWithText(StrAndroid.supportOfflineLeaveMessage(Language.FA)).assertIsDisplayed()
        compose.onNodeWithText(StrAndroid.supportOnline(Language.FA)).assertDoesNotExist()
        compose.onNodeWithTag(A11y.SETTINGS_SUPPORT_CHAT).assertIsDisplayed().performClick()
        assertEquals(listOf("chat"), opened)
    }

    @Test
    fun `the team's unread messages are counted on the row`() {
        show(SupportSummary(offline.copy(unread = 3)))

        compose.onNodeWithText("3").assertIsDisplayed()
    }

    @Test
    fun `nothing unread, no badge`() {
        show(SupportSummary(online))

        compose.onNodeWithText("0").assertDoesNotExist()
    }

    @Test
    fun `support that is off, or not offered to this operator, shows nothing`() {
        val off = SupportSummary(SupportStatus())
        val notOffered = SupportSummary(online.copy(available = false, unread = 1))
        assertFalse(off.shown)
        assertFalse(notOffered.shown)
        assertTrue(SupportSummary(online).shown)

        show(notOffered)

        compose.onNodeWithText(StrAndroid.supportSection(Language.EN)).assertDoesNotExist()
        compose.onNodeWithTag(A11y.SETTINGS_SUPPORT_CHAT).assertDoesNotExist()
    }

    /** Super Admin → Mobile App → Android → Show "Online support", switched off. */
    @Test
    fun `hidden from the app by Super Admin, it shows nothing`() {
        val hidden = SupportSummary(online, showSupport = false)
        assertFalse(hidden.shown)

        show(hidden)

        compose.onNodeWithText(StrAndroid.supportSection(Language.EN)).assertDoesNotExist()
        compose.onNodeWithTag(A11y.SETTINGS_SUPPORT_CHAT).assertDoesNotExist()
    }
}
