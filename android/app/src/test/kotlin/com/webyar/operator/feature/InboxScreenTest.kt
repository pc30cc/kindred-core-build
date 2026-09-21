package com.webyar.operator.feature

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import com.webyar.operator.core.net.SampleApi
import com.webyar.operator.core.model.InboxFilter
import com.webyar.operator.feature.inbox.InboxScreen
import com.webyar.operator.feature.inbox.InboxState
import com.webyar.operator.feature.inbox.preview
import com.webyar.operator.i18n.Language
import com.webyar.operator.ui.A11y
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * The inbox, on the JVM.
 *
 * Robolectric rather than an emulator, deliberately: ADR-003 §5 keeps the
 * majority of this suite off a device so CI fits inside a host that is also
 * serving the database. What genuinely needs a real IME — the keyboard tests
 * that are the hardest part of the iOS suite — is a separate job on a
 * schedule.
 *
 * The sample backend is what makes this possible with no account, no network
 * and no credentials anywhere in the test target.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class InboxScreenTest {

    @get:Rule val compose = createComposeRule()

    @Test
    fun `the open queue lists the sample conversations`() = runTest {
        val conversations = SampleApi().conversations("ws-1", InboxFilter.OPEN)
        compose.setContent {
            InboxScreen(InboxState.Loaded(conversations), Language.EN, {})
        }
        compose.onNodeWithTag(A11y.INBOX_LIST).assertIsDisplayed()
        compose.onNodeWithTag(A11y.conversationRow("c-1")).assertIsDisplayed()
    }

    @Test
    fun `a visitor who never gave a name still gets a row`() = runTest {
        val conversations = SampleApi().conversations("ws-1", InboxFilter.OPEN)
        val anonymous = conversations.first { it.id == "c-3" }
        assertEquals(null, anonymous.contact?.name)

        compose.setContent { InboxScreen(InboxState.Loaded(conversations), Language.EN, {}) }
        compose.onNodeWithTag(A11y.conversationRow("c-3")).assertIsDisplayed()
    }

    /**
     * The bug this pins: a message that is only a photo has no body, and the
     * preview line used to come out blank. The list endpoint ships
     * `attachment_kind` so the sentence can be rebuilt instead.
     */
    @Test
    fun `an attachment-only message previews as a sentence, not as nothing`() = runTest {
        val resolved = SampleApi().conversations("ws-1", InboxFilter.RESOLVED)
        val photo = resolved.first { it.id == "c-5" }
        assertEquals(null, photo.lastMessage?.body)

        assertEquals("علی رضایی sent a photo", photo.preview(Language.EN))
        assertTrue(photo.preview(Language.FA).contains("تصویر"))
        assertTrue(photo.preview(Language.TR).contains("fotoğraf"))
    }

    @Test
    fun `tapping a row opens it`() = runTest {
        val conversations = SampleApi().conversations("ws-1", InboxFilter.OPEN)
        var opened: String? = null
        compose.setContent {
            InboxScreen(InboxState.Loaded(conversations), Language.EN, { opened = it.id })
        }
        compose.onNodeWithTag(A11y.conversationRow("c-2")).performClick()
        compose.waitForIdle()
        assertEquals("c-2", opened)
    }

    @Test
    fun `an empty queue says so rather than showing nothing`() {
        compose.setContent { InboxScreen(InboxState.Loaded(emptyList()), Language.FA, {}) }
        compose.onNodeWithTag(A11y.INBOX_EMPTY).assertIsDisplayed()
        // Persian, because that is the case the product ships in.
        compose.onNodeWithText(com.webyar.operator.i18n.Str.inboxEmptyTitle(Language.FA)).assertIsDisplayed()
    }
}
