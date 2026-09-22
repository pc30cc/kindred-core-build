package com.webyar.operator.feature.email

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import com.webyar.operator.core.net.SampleApi
import com.webyar.operator.i18n.Language
import com.webyar.operator.i18n.Str
import com.webyar.operator.ui.A11y
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class EmailTest {

    @get:Rule val compose = createComposeRule()

    private val dispatcher = StandardTestDispatcher()

    @Before fun setUp() = Dispatchers.setMain(dispatcher)
    @After fun tearDown() = Dispatchers.resetMain()

    private fun inbox(api: SampleApi = SampleApi()) = EmailInboxViewModel(api) { Language.FA }
    private fun thread(api: SampleApi = SampleApi()) = EmailThreadViewModel(api) { Language.FA }

    private fun ids(state: EmailInboxState) =
        (state as EmailInboxState.Loaded).threads.map { it.id }

    // MARK: - The mailbox

    @Test
    fun `binding loads the threads and names the mailbox`() = runTest(dispatcher) {
        val email = inbox()
        email.bind("ws-1")
        testScheduler.advanceUntilIdle()

        assertEquals(listOf("t-1", "t-2"), ids(email.state.value))
        assertEquals("support@webyar.app", email.mailbox.value)
        assertFalse(email.notConnected.value)
    }

    @Test
    fun `search reaches the subject, the snippet and the participants`() = runTest(dispatcher) {
        val email = inbox()
        email.bind("ws-1")
        testScheduler.advanceUntilIdle()

        email.setQuery("INVOICE")
        assertEquals(listOf("t-1"), ids(email.state.value))

        email.setQuery("تلگرام")
        assertEquals(listOf("t-2"), ids(email.state.value))

        // Nobody's subject or snippet carries this; only the address does.
        email.setQuery("billing@example.com")
        assertEquals(listOf("t-1"), ids(email.state.value))
    }

    /**
     * Unbolding is local. Opening the thread is what tells the server it was
     * read, and saying so twice would be two requests for one act.
     */
    @Test
    fun `opening a thread unbolds its row straight away`() = runTest(dispatcher) {
        val email = inbox()
        email.bind("ws-1")
        testScheduler.advanceUntilIdle()
        assertEquals(false, email.thread("t-1")?.isRead)

        email.markReadLocally("t-1")
        assertEquals(true, email.thread("t-1")?.isRead)
        // And nobody else moved.
        assertEquals(listOf("t-1", "t-2"), ids(email.state.value))
    }

    // MARK: - One thread

    @Test
    fun `opening a thread shows its subject before the trail arrives`() = runTest(dispatcher) {
        val api = SampleApi()
        val known = api.emailThreads("ws-1").first { it.id == "t-1" }

        val model = thread(api)
        model.open("ws-1", "t-1", known)
        // Nothing advanced: the summary the list already had is on screen
        // rather than a blank bar that fills in a second later.
        assertEquals(known.subject, model.thread.value?.subject)
        assertTrue(model.state.value is EmailThreadState.Loading)

        testScheduler.advanceUntilIdle()
        assertTrue(model.state.value is EmailThreadState.Loaded)
    }

    /**
     * A reply goes to the last person who wrote IN — which is what "reply"
     * means to anyone who has used a mail client, and not the same as "the
     * first address on the thread".
     */
    @Test
    fun `a reply is addressed to whoever wrote in last`() = runTest(dispatcher) {
        val api = SampleApi()
        val model = thread(api)
        model.open("ws-1", "t-1", api.emailThreads("ws-1").first())
        testScheduler.advanceUntilIdle()

        assertEquals(listOf("billing@example.com"), model.recipients("support@webyar.app"))
    }

    @Test
    fun `a draft of only whitespace is never sent`() = runTest(dispatcher) {
        val api = SampleApi()
        val model = thread(api)
        model.open("ws-1", "t-1", api.emailThreads("ws-1").first())
        testScheduler.advanceUntilIdle()
        val before = (model.state.value as EmailThreadState.Loaded).messages.size

        model.setDraft("   \n  ")
        model.send(mailbox = "support@webyar.app")
        testScheduler.advanceUntilIdle()

        assertEquals(before, (model.state.value as EmailThreadState.Loaded).messages.size)
        assertFalse(model.sendFailed.value)
    }

    @Test
    fun `sending clears the draft`() = runTest(dispatcher) {
        val api = SampleApi()
        val model = thread(api)
        model.open("ws-1", "t-1", api.emailThreads("ws-1").first())
        testScheduler.advanceUntilIdle()

        model.setDraft("  Received, thank you.  ")
        model.send(mailbox = "support@webyar.app")
        testScheduler.advanceUntilIdle()

        assertEquals("", model.draft.value)
        assertFalse(model.sendFailed.value)
    }

    /** The star flips under the thumb; the request follows. */
    @Test
    fun `starring is optimistic`() = runTest(dispatcher) {
        val api = SampleApi()
        val known = api.emailThreads("ws-1").first { it.id == "t-2" }
        assertEquals(false, known.isStarred)

        val model = thread(api)
        model.open("ws-1", "t-2", known)
        model.toggleStar()
        // Before the scheduler has run anything.
        assertTrue(model.isStarred)
    }

    // MARK: - The screens

    @Test
    fun `the list draws a row per thread`() = runTest {
        val threads = SampleApi().emailThreads("ws-1")
        compose.setContent { EmailInboxScreen(EmailInboxState.Loaded(threads), Language.FA, {}) }

        compose.onNodeWithTag(A11y.EMAIL_LIST).assertIsDisplayed()
        compose.onNodeWithTag(A11y.emailRow("t-1")).assertIsDisplayed()
        compose.onNodeWithTag(A11y.emailRow("t-2")).assertIsDisplayed()
    }

    @Test
    fun `tapping a row opens the thread`() = runTest {
        val threads = SampleApi().emailThreads("ws-1")
        var opened: String? = null
        compose.setContent {
            EmailInboxScreen(EmailInboxState.Loaded(threads), Language.FA, { opened = it.id })
        }
        compose.onNodeWithTag(A11y.emailRow("t-2")).performClick()
        compose.waitForIdle()

        assertEquals("t-2", opened)
    }

    /**
     * "No mailbox connected" is a setup step, not a failure, and it used to be
     * indistinguishable from an empty mailbox. Retrying cannot fix the first.
     */
    @Test
    fun `a workspace with no mailbox is told how to get one, not shown an empty inbox`() {
        compose.setContent {
            EmailInboxScreen(
                EmailInboxState.Loaded(emptyList()),
                Language.FA,
                {},
                notConnected = true,
            )
        }
        compose.onNodeWithTag(A11y.EMAIL_NOT_CONNECTED).assertIsDisplayed()
        compose.onNodeWithText(Str.emailNotConnectedTitle(Language.FA)).assertIsDisplayed()
    }

    @Test
    fun `a connected but empty mailbox says something else`() {
        compose.setContent {
            EmailInboxScreen(EmailInboxState.Loaded(emptyList()), Language.FA, {})
        }
        compose.onNodeWithTag(A11y.EMAIL_EMPTY).assertIsDisplayed()
        compose.onNodeWithText(Str.emailEmptyTitle(Language.FA)).assertIsDisplayed()
    }

    @Test
    fun `the trail draws a card per message`() = runTest {
        val api = SampleApi()
        val response = api.emailThread("ws-1", "t-1")
        compose.setContent {
            EmailThreadScreen(
                EmailThreadState.Loaded(response.messages),
                thread = response.thread,
                language = Language.FA,
            )
        }

        compose.onNodeWithTag(A11y.EMAIL_THREAD).assertIsDisplayed()
        response.messages.forEach {
            compose.onNodeWithTag(A11y.emailMessage(it.id)).assertIsDisplayed()
        }
    }

    /**
     * A mail written only in HTML is the common case, and showing its markup
     * would be showing the operator the tags.
     */
    @Test
    fun `an HTML-only message is shown as text`() = runTest {
        val html = SampleApi().emailThread("ws-1", "t-1").messages.first { it.id == "em-2" }
        assertEquals(null, html.textBody)

        val body = html.displayBody
        assertTrue(body.contains("Thanks"))
        assertTrue(body.contains("process it today"))
        assertFalse(body.contains("<"))
        // And the entities are resolved, not left as &mdash; and &#39;.
        assertFalse(body.contains("&"))
    }

    @Test
    fun `a thread with no subject is named rather than left blank`() = runTest {
        compose.setContent {
            EmailThreadScreen(
                EmailThreadState.Loaded(emptyList()),
                thread = SampleApi().emailThreads("ws-1").first().copy(subject = ""),
                language = Language.FA,
            )
        }
        compose.onNodeWithText(Str.emailNoSubject(Language.FA)).assertIsDisplayed()
    }
}
