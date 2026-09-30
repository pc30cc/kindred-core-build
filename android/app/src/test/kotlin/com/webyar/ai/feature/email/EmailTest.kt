package com.webyar.ai.feature.email

import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollToNode
import com.webyar.ai.core.net.SampleApi
import com.webyar.ai.i18n.Format
import com.webyar.ai.i18n.Language
import com.webyar.ai.i18n.Str
import com.webyar.ai.i18n.StrEmail
import com.webyar.ai.ui.A11y
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.launch
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
     * "No mailbox connected" is a setup step, not a failure, and must not look
     * like an empty mailbox. Retrying cannot fix the first.
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

    // MARK: - Loading

    /** Opening the mailbox says it is on its way, rather than showing nothing and then everything. */
    @Test
    fun `while the mailbox is read the screen says so`() {
        compose.setContent { EmailInboxScreen(EmailInboxState.Loading, Language.FA, {}) }
        compose.onNodeWithTag(A11y.EMAIL_LOADING).assertIsDisplayed()
        compose.onNodeWithText(StrEmail.loadingMail(Language.FA)).assertIsDisplayed()
    }

    /** A background re-read keeps the list on screen and shows only a thin bar above it. */
    @Test
    fun `a re-read in the background keeps the list and shows a bar`() = runTest {
        val threads = SampleApi().emailThreads("ws-1")
        compose.setContent { EmailInboxScreen(EmailInboxState.Loaded(threads), Language.FA, {}, syncing = true) }
        compose.onNodeWithTag(A11y.EMAIL_SYNCING).assertIsDisplayed()
        compose.onNodeWithTag(A11y.EMAIL_LIST).assertIsDisplayed()
        compose.onAllNodesWithTag(A11y.EMAIL_LOADING).assertCountEquals(0)
    }

    @Test
    fun `the list's re-read is over once it lands`() = runTest(dispatcher) {
        val email = inbox()
        email.bind("ws-1")
        assertTrue(email.syncing.value)
        testScheduler.advanceUntilIdle()
        assertFalse(email.syncing.value)
        assertTrue(email.state.value is EmailInboxState.Loaded)
    }

    /**
     * The screen's search box says "" as it opens. That must not replace the
     * loader with an empty list — "no mail" — until the mail arrives.
     */
    @Test
    fun `an empty search while the mailbox is read keeps the loader`() = runTest(dispatcher) {
        val email = inbox()
        email.bind("ws-1")
        email.setQuery("")
        email.setStarredLocally("t-1", true)
        email.markReadLocally("t-1")
        assertTrue(email.state.value is EmailInboxState.Loading)
        testScheduler.advanceUntilIdle()
        assertTrue(ids(email.state.value).isNotEmpty())
    }

    @Test
    fun `the folder menu shows a loader until its folders arrive`() {
        compose.setContent { EmailFolderDrawer(Language.FA, emptyList(), selected = "inbox", onSelect = {}, loading = true) }
        compose.onNodeWithTag(A11y.EMAIL_FOLDERS_LOADING).assertIsDisplayed()
    }

    /** A menu that could not be read still has the inbox in it, not a loader that never ends. */
    @Test
    fun `folders that cannot be read fall back to the inbox`() = runTest(dispatcher) {
        val api = object : com.webyar.ai.core.net.WebyarApi by SampleApi() {
            override suspend fun emailFolders(workspaceId: String, mailbox: String?): List<com.webyar.ai.core.model.EmailMailFolder> =
                throw java.io.IOException("offline")
        }
        val email = EmailInboxViewModel(api) { Language.FA }
        email.bind("ws-1")
        testScheduler.advanceUntilIdle()
        assertEquals(com.webyar.ai.core.model.EmailMailFolder.FALLBACK, email.folders.value)
    }

    @Test
    fun `opening a thread says it is opening`() {
        compose.setContent {
            EmailThreadScreen(EmailThreadState.Loading, thread = null, language = Language.FA)
        }
        compose.onNodeWithTag(A11y.EMAIL_LOADING).assertIsDisplayed()
        compose.onNodeWithText(StrEmail.openingMail(Language.FA)).assertIsDisplayed()
    }

    @Test
    fun `the thread is one page with every message on it`() = runTest {
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
        val page = EmailReader.document(response.thread.subject, response.messages, mailbox = null, language = Language.FA)
        assertTrue(page.contains("Please find attached the invoice for September."))
        assertTrue(page.contains("We&#39;ll process it today."))
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
        val untitled = SampleApi().emailThreads("ws-1").first().copy(subject = "")
        val page = EmailReader.document(untitled.subject, emptyList(), mailbox = null, language = Language.FA, snippet = untitled.lastMessageSnippet)
        assertTrue(page.contains(EmailReader.escape(Str.emailNoSubject(Language.FA))))
    }

    // MARK: - Folders

    @Test
    fun `the folder menu lists the mailbox's folders and labels, and a tap picks one`() = runTest {
        val folders = SampleApi().emailFolders("ws-1")
        var picked: String? = null
        compose.setContent {
            EmailFolderDrawer(Language.FA, folders, selected = "inbox", onSelect = { picked = it })
        }

        compose.onNodeWithText(StrEmail.folderName(Language.FA, "inbox")!!).assertIsDisplayed()
        compose.onNodeWithText(StrEmail.folderName(Language.FA, "sent")!!).assertIsDisplayed()
        // The inbox's unread count stands beside it.
        compose.onNodeWithTag(A11y.emailMailFolder("inbox")).assertTextContains(Format.number(1, Language.FA))

        compose.onNodeWithTag(A11y.EMAIL_DRAWER).performScrollToNode(hasTestTag(A11y.emailMailFolder("label:Label_news")))
        compose.onNodeWithText("خبرنامه‌ها").assertIsDisplayed()
        compose.onNodeWithTag(A11y.emailMailFolder("label:Label_news")).performClick()
        assertEquals("label:Label_news", picked)
    }

    @Test
    fun `a row names its sender, not the header they came in`() {
        val google = com.webyar.ai.core.model.EmailThreadSummary(
            id = "g-1",
            subject = "Security alert",
            participants = listOf(com.webyar.ai.core.model.EmailAddress("\"Google\" <no-reply@accounts.google.example>")),
        )
        compose.setContent { EmailInboxScreen(EmailInboxState.Loaded(listOf(google)), Language.FA, {}) }

        compose.onNodeWithText("Google").assertIsDisplayed()
        assertEquals(0, compose.onAllNodesWithText("no-reply", substring = true).fetchSemanticsNodes().size)
    }

    @Test
    fun `in Persian a row is still laid out left to right - the face on the left, the star on the right`() = runTest {
        val threads = SampleApi().emailThreads("ws-1")
        compose.setContent {
            androidx.compose.runtime.CompositionLocalProvider(
                androidx.compose.ui.platform.LocalLayoutDirection provides androidx.compose.ui.unit.LayoutDirection.Rtl,
            ) {
                EmailInboxScreen(EmailInboxState.Loaded(threads), Language.FA, {})
            }
        }
        val row = compose.onNodeWithTag(A11y.emailRow("t-1")).fetchSemanticsNode().boundsInRoot
        val star = compose.onNodeWithTag(A11y.emailStar("t-1"), useUnmergedTree = true).fetchSemanticsNode().boundsInRoot
        assertTrue("the star is on the right", star.left > row.center.x)
    }

    @Test
    fun `in Sent a row says whom the mail is to`() = runTest {
        val sent = SampleApi().emailThreadsPage("ws-1", com.webyar.ai.core.model.EmailFolder.INBOX, null, null, mailFolder = "sent").threads.single()
        compose.setContent {
            EmailInboxScreen(EmailInboxState.Loaded(listOf(sent)), Language.FA, {}, mailFolder = "sent")
        }
        compose.onNodeWithText("${StrEmail.to(Language.FA)}: \u2068ceo@example.com\u2069").assertIsDisplayed()
    }

    // MARK: - Mailboxes, counts, and following them live

    @Test
    fun `every mailbox is counted, and another one is shown on request`() = runTest(dispatcher) {
        val email = inbox()
        email.bind("ws-1")
        testScheduler.advanceUntilIdle()

        assertEquals(listOf("gmail", "yahoo"), email.mailboxes.value.map { it.provider })
        assertEquals(2, email.unread.value)
        assertEquals("gmail", email.provider.value)

        email.selectMailbox("yahoo")
        testScheduler.advanceUntilIdle()
        assertEquals(listOf("y-1"), ids(email.state.value))
        assertEquals("sales@webyar.app", email.mailbox.value)
    }

    @Test
    fun `opening an unread thread takes it off the count`() = runTest(dispatcher) {
        val email = inbox()
        email.bind("ws-1")
        testScheduler.advanceUntilIdle()

        email.markReadLocally("t-1")
        assertEquals(1, email.unread.value)
        assertEquals(0, email.mailboxes.value.first { it.provider == "gmail" }.unread)
    }

    /**
     * New mail: the signal says only that the mailbox changed. What changed
     * is asked of the server by id, from the list's cursor, and the list and
     * any open thread with new messages read again.
     */
    @Test
    fun `a mailbox change reads what changed since the cursor, then the list`() = runTest(dispatcher) {
        val signals = kotlinx.coroutines.flow.MutableSharedFlow<com.webyar.ai.core.sync.EmailSignal>()
        val api = object : com.webyar.ai.core.net.WebyarApi by SampleApi() {
            var pages = 0
            val asked = mutableListOf<String>()
            override suspend fun emailThreadsPage(
                workspaceId: String,
                folder: com.webyar.ai.core.model.EmailFolder,
                search: String?,
                before: String?,
                mailbox: String?,
                mailFolder: String?,
            ) = com.webyar.ai.core.model.EmailThreadsResponse(
                threads = listOf(com.webyar.ai.core.model.EmailThreadSummary("t-${++pages}")),
                historyId = "10$pages",
            )
            override suspend fun emailChanges(workspaceId: String, since: String, mailbox: String?) =
                com.webyar.ai.core.model.EmailChanges(historyId = "200", threadIds = listOf("t-1", "t-9"), contentThreadIds = listOf("t-1")).also { asked += since }
        }
        val email = EmailInboxViewModel(api, signals) { Language.FA }
        val changed = mutableListOf<Set<String>?>()
        backgroundScope.launch { email.threadChanges.collect { changed += it } }
        email.bind("ws-1")
        testScheduler.advanceUntilIdle()
        assertEquals(1, api.pages)

        signals.emit(com.webyar.ai.core.sync.EmailSignal("ws-1", "gmail", "200"))
        testScheduler.advanceUntilIdle()

        assertEquals(listOf("101"), api.asked)
        assertEquals(listOf<Set<String>?>(setOf("t-1")), changed)
        assertEquals(2, api.pages)
        assertTrue(email.consumeStale("t-1"))
        assertFalse(email.consumeStale("t-1"))
    }

    @Test
    fun `a thread read before is not asked for again while its content is unchanged`() = runTest(dispatcher) {
        val email = inbox()
        val response = SampleApi().emailThread("ws-1", "t-1")
        email.rememberThread("gmail", response)

        assertEquals(response, email.cachedThread("t-1", "gmail", response.thread.version))
        // A new message is a new version: read again.
        assertEquals(null, email.cachedThread("t-1", "gmail", response.thread.copy(messageCount = 9).version))
    }
}
