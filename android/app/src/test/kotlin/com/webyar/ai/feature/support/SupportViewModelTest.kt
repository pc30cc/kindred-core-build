package com.webyar.ai.feature.support

import com.webyar.ai.core.model.SupportConversation
import com.webyar.ai.core.model.SupportPostResult
import com.webyar.ai.core.model.SupportStatus
import com.webyar.ai.core.net.ApiError
import com.webyar.ai.core.net.SampleApi
import com.webyar.ai.core.net.WebyarApi
import com.webyar.ai.i18n.Language
import com.webyar.ai.i18n.Str
import com.webyar.ai.i18n.StrAndroid
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * Online support as the operator uses it: whether it is offered, one chat
 * with every conversation in it, a message that shows at once and becomes
 * the server's, a retry that is the same message, a file refused before it
 * is sent, a rating given once, and the chat read while it is on screen.
 *
 * Plain JUnit — nothing here draws.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class SupportViewModelTest {

    private val dispatcher = StandardTestDispatcher()

    @Before fun setUp() = Dispatchers.setMain(dispatcher)
    @After fun tearDown() = Dispatchers.resetMain()

    private fun TestScope.opened(api: WebyarApi = StubSupportApi()): SupportChatViewModel {
        val chat = SupportChatViewModel(api) { Language.FA }
        chat.open(workspaceId = "ws-1")
        testScheduler.advanceUntilIdle()
        return chat
    }

    /** Opened on the sample, whose one conversation has ended: a fresh page, ready to write. */
    private fun TestScope.writing(api: WebyarApi = StubSupportApi()): SupportChatViewModel = opened(api)

    private val SupportChatViewModel.loaded: SupportChatState.Loaded
        get() = state.value as SupportChatState.Loaded

    // MARK: - Settings' view

    @Test
    fun `the team's status is read, with its hours and what is unread`() = runTest(dispatcher) {
        val settings = SupportStatusViewModel(SampleApi())
        assertNull(settings.status.value)

        settings.refresh()
        testScheduler.advanceUntilIdle()

        val status = settings.status.value!!
        assertTrue(status.shown && status.online)
        assertEquals("پشتیبانی وب‌یار", status.teamName)
        assertEquals("Asia/Tehran", status.hours?.timezone)
        // The team's answer three days ago has not been read yet.
        assertEquals(1, status.unread)
    }

    /** "Online" was true a minute ago; a read that fails does not make it "off". */
    @Test
    fun `a status read that fails keeps the last answer`() = runTest(dispatcher) {
        val api = StubSupportApi()
        val settings = SupportStatusViewModel(api)
        settings.refresh()
        testScheduler.advanceUntilIdle()
        assertTrue(settings.status.value!!.online)

        api.statusError = ApiError.Transport(null)
        settings.refresh()
        testScheduler.advanceUntilIdle()

        assertTrue(settings.status.value!!.online)
    }

    @Test
    fun `a backend without support offers nothing`() = runTest(dispatcher) {
        val bare = object : WebyarApi by SampleApi() {
            override suspend fun supportStatus(): SupportStatus = SupportStatus()
        }
        val settings = SupportStatusViewModel(bare)
        settings.refresh()
        testScheduler.advanceUntilIdle()

        assertFalse(settings.status.value!!.shown)
    }

    // MARK: - The history

    @Test
    fun `arriving with nothing open, the chat is a fresh page and the ended conversation is closed`() = runTest(dispatcher) {
        val chat = opened()

        val loaded = chat.loaded
        val resolved = loaded.conversations.single()
        assertTrue(resolved.ended)
        assertTrue(resolved.canRate)
        assertNull(loaded.activeConversationId)
        // Nothing open: the page is as fresh as the first — the ended one is
        // behind the bar's "closed" button, not in the chat.
        assertEquals(SupportComposer.Fresh, loaded.composer)
        assertNull(loaded.shown)
        assertTrue(loaded.isEmpty)
        assertEquals(listOf(resolved.id), loaded.closed.map { it.id })

        // Read back on its own, it is closed by its line and offered for rating.
        val rows = supportTimeline(listOf(resolved), loaded.items.filter { it.conversationId == resolved.id }, emptyList())
        assertEquals(
            listOf(
                SupportRow.Bubble::class,
                SupportRow.Joined::class,
                SupportRow.Bubble::class,
                SupportRow.Ended::class,
                SupportRow.Rating::class,
            ),
            rows.map { it::class },
        )
        val (mine, joined, theirs) = Triple(rows[0] as SupportRow.Bubble, rows[1] as SupportRow.Joined, rows[2] as SupportRow.Bubble)
        assertTrue(mine.mine)
        assertNotNull(mine.dayHeader)
        assertEquals("رضا نوری", joined.name)
        assertFalse(theirs.mine)
        // Same day: no second header.
        assertNull(theirs.dayHeader)
        assertEquals("پشتیبانی وب‌یار", chat.status.value?.teamName)
    }

    // MARK: - Sending

    /** Shown at once as "sending"; then the server's, in the new conversation it started. */
    @Test
    fun `a message is pending at once and becomes the server's item`() = runTest(dispatcher) {
        val api = StubSupportApi()
        val chat = writing(api)
        assertEquals(SupportComposer.Fresh, chat.loaded.composer)

        chat.setDraft("  سلام، ایمیل‌ها وصل نمی‌شود  ")
        chat.send()
        val sending = chat.loaded
        assertEquals(listOf("سلام، ایمیل‌ها وصل نمی‌شود"), sending.pending.map { it.body })
        assertFalse(sending.pending.single().failed)
        // The first message of a new conversation names none.
        assertNull(sending.pending.single().conversationId)
        assertEquals("", chat.draft.value)
        val id = sending.pending.single().clientMessageId

        testScheduler.advanceUntilIdle()

        val sent = chat.loaded
        assertTrue(sent.pending.isEmpty())
        assertEquals(2, sent.conversations.size)
        assertEquals(sent.conversations.last().id, sent.activeConversationId)
        assertEquals(SupportComposer.Active, sent.composer)
        assertEquals(sent.activeConversationId, sent.shown?.id)
        val mine = sent.items.single { it.clientMessageId == id }
        assertEquals(sent.activeConversationId, mine.conversationId)
        // The team joined the new conversation and answered once.
        val theirs = sent.items.filter { it.conversationId == mine.conversationId && it.fromTeam }
        assertEquals(listOf(true, false), theirs.map { it.isJoin })

        // The chat shows that conversation alone; the ended one stays closed.
        assertTrue(sent.shownItems.all { it.conversationId == sent.activeConversationId })
        // The operator's message, the team joining, its answer.
        assertEquals(listOf(false, true, false), sent.shownItems.map { it.isJoin })
        assertEquals(1, sent.closed.size)

        // The next one is written to the conversation now open, by name.
        chat.setDraft("و یک سؤال دیگر")
        chat.send()
        testScheduler.advanceUntilIdle()
        assertEquals(listOf(null, sent.activeConversationId), api.targets)
        assertEquals(2, chat.loaded.conversations.size)
    }

    @Test
    fun `an empty message is not sent`() = runTest(dispatcher) {
        val api = StubSupportApi()
        val chat = writing(api)

        chat.setDraft("   ")
        chat.send()
        testScheduler.advanceUntilIdle()

        assertTrue(api.sent.isEmpty())
    }

    /** One id for every attempt: the server keeps the first and answers the retry with it. */
    @Test
    fun `a message that fails stays, marked, and its retry is the same message`() = runTest(dispatcher) {
        val api = StubSupportApi(failSends = 1)
        val chat = writing(api)

        chat.setDraft("کمک")
        chat.send()
        testScheduler.advanceUntilIdle()

        val pending = chat.loaded.pending.single()
        assertTrue(pending.failed)
        assertEquals(StrAndroid.supportRateLimited(Language.FA), chat.notice.value)

        chat.retry(pending.clientMessageId)
        testScheduler.advanceUntilIdle()

        val sent = chat.loaded
        assertTrue(sent.pending.isEmpty())
        assertEquals(1, sent.items.count { it.clientMessageId == pending.clientMessageId })
        assertEquals(listOf(pending.clientMessageId, pending.clientMessageId), api.sent)
    }

    @Test
    fun `a file over 2 MB is refused before a byte is sent`() = runTest(dispatcher) {
        val api = StubSupportApi()
        val chat = writing(api)

        chat.sendFile(ByteArray(SupportChatViewModel.MAX_FILE_BYTES + 1), "scan.pdf", "application/pdf")
        testScheduler.advanceUntilIdle()

        assertTrue(api.uploads.isEmpty())
        assertTrue(chat.loaded.pending.isEmpty())
        assertEquals(StrAndroid.supportFileTooLarge(Language.FA), chat.notice.value)
    }

    @Test
    fun `a file of a type the server refuses is not sent either`() = runTest(dispatcher) {
        val api = StubSupportApi()
        val chat = writing(api)

        chat.sendFile(ByteArray(10), "voice.mp3", "audio/mpeg")
        testScheduler.advanceUntilIdle()

        assertTrue(api.uploads.isEmpty())
        assertEquals(Str.fileTypeNotAllowed(Language.FA), chat.notice.value)
    }

    /** A file that fails keeps its bytes, and the retry sends them again under the same id. */
    @Test
    fun `a file lands as an attachment, and its retry sends the same bytes`() = runTest(dispatcher) {
        val api = StubSupportApi(failUploads = 1)
        val chat = writing(api)
        val bytes = "hello".toByteArray()

        chat.sendFile(bytes, "note.txt", "text/plain")
        assertEquals("note.txt", chat.loaded.pending.single().file?.fileName)
        testScheduler.advanceUntilIdle()
        val failed = chat.loaded.pending.single()
        assertTrue(failed.failed)

        chat.retry(failed.clientMessageId)
        testScheduler.advanceUntilIdle()

        assertTrue(chat.loaded.pending.isEmpty())
        val item = chat.loaded.items.single { it.clientMessageId == failed.clientMessageId }
        val attachment = item.attachments.single()
        assertEquals("note.txt", attachment.fileName)
        assertEquals(listOf(failed.clientMessageId, failed.clientMessageId), api.uploads)
        assertTrue(api.real.supportAttachmentData(attachment.id).contentEquals(bytes))
    }

    // MARK: - Rating

    @Test
    fun `a rating is submitted once, however often it is tapped`() = runTest(dispatcher) {
        val api = StubSupportApi()
        val chat = opened(api)
        val id = chat.loaded.conversations.single().id

        chat.rate(id, 5, "  عالی بود  ")
        chat.rate(id, 5, "عالی بود")
        assertEquals(setOf(id), chat.rating.value)
        testScheduler.advanceUntilIdle()
        chat.rate(id, 4, null)
        testScheduler.advanceUntilIdle()

        assertEquals(listOf(id), api.ratings)
        val rated = chat.loaded.conversations.single()
        assertEquals(5, rated.rating?.score)
        assertEquals("عالی بود", rated.rating?.comment)
        assertFalse(rated.canRate)
        assertTrue(chat.rating.value.isEmpty())
    }

    /** Rated on another device meanwhile: nothing to say, the chat is read again. */
    @Test
    fun `a conversation the server says is rated already is read again`() = runTest(dispatcher) {
        val api = StubSupportApi(ratingError = ApiError.Server(409, "already_rated"))
        val chat = opened(api)
        val reads = api.historyReads

        chat.rate(chat.loaded.conversations.single().id, 3, null)
        testScheduler.advanceUntilIdle()

        assertNull(chat.notice.value)
        assertEquals(reads + 1, api.historyReads)
    }

    // MARK: - Reading

    @Test
    fun `the chat on screen with something unread is marked read`() = runTest(dispatcher) {
        val api = StubSupportApi()
        val chat = opened(api)
        // Opened, not yet on screen: nothing is read.
        assertEquals(0, api.marked)

        backgroundScope.launch { chat.follow(null) }
        // Background work waits for a nudge; the reads it starts do not.
        testScheduler.runCurrent()
        testScheduler.advanceUntilIdle()

        assertEquals(1, api.marked)
        assertEquals(0, chat.status.value?.unread)
        assertEquals(0, api.real.supportStatus().unread)
    }

    @Test
    fun `a chat with nothing unread is not marked`() = runTest(dispatcher) {
        val api = StubSupportApi()
        api.real.markSupportRead()
        val chat = opened(api)

        backgroundScope.launch { chat.follow(null) }
        // Background work waits for a nudge; the reads it starts do not.
        testScheduler.runCurrent()
        testScheduler.advanceUntilIdle()

        assertEquals(0, api.marked)
    }

    /** The team answers while the operator watches: read as it arrives, not at the next visit. */
    @Test
    fun `a reply that arrives while the chat is on screen is marked read`() = runTest(dispatcher) {
        val api = StubSupportApi()
        api.real.markSupportRead()
        val chat = writing(api)
        backgroundScope.launch { chat.follow(null) }
        testScheduler.runCurrent()
        testScheduler.advanceUntilIdle()
        assertEquals(0, api.marked)

        chat.setDraft("سلام")
        chat.send()
        testScheduler.advanceUntilIdle()

        assertEquals(1, api.marked)
        assertEquals(0, api.real.supportStatus().unread)
    }

    // MARK: - The end of a conversation

    /**
     * The bug this guards: after a close, words typed into the old
     * conversation went somewhere else. Now a conversation that ends on
     * screen takes nothing more, and a new one is the operator's choice.
     */
    @Test
    fun `a conversation that ends on screen takes nothing more until the operator starts a new one`() = runTest(dispatcher) {
        val api = StubSupportApi()
        val chat = writing(api)
        chat.setDraft("سلام")
        chat.send()
        testScheduler.advanceUntilIdle()
        val open = chat.loaded.activeConversationId!!
        api.real.endSupportConversation(open)
        chat.loadHistory()
        testScheduler.advanceUntilIdle()
        assertEquals(SupportComposer.Ended, chat.loaded.composer)
        val sentBefore = api.sent.size

        chat.setDraft("ادامهٔ همان گفتگو")
        chat.send()
        chat.sendFile("x".toByteArray(), "a.txt", "text/plain")
        testScheduler.advanceUntilIdle()
        assertEquals(sentBefore, api.sent.size)
        assertTrue(api.uploads.isEmpty())
        assertTrue(chat.loaded.pending.isEmpty())
        // Kept for the new conversation.
        assertEquals("ادامهٔ همان گفتگو", chat.draft.value)

        chat.startNewConversation()
        assertEquals(SupportComposer.Fresh, chat.loaded.composer)
        assertTrue(chat.loaded.isEmpty)
        // Read again meanwhile: still a fresh page.
        chat.loadHistory()
        testScheduler.advanceUntilIdle()
        assertEquals(SupportComposer.Fresh, chat.loaded.composer)

        chat.send()
        testScheduler.advanceUntilIdle()
        assertEquals(null, api.targets.last())
        val loaded = chat.loaded
        assertEquals(SupportComposer.Active, loaded.composer)
        assertEquals(loaded.conversations.last().id, loaded.activeConversationId)
        assertEquals(2, loaded.closed.size)
    }

    /** Whenever the chat is opened: the open conversation if there is one, a fresh page if not. */
    @Test
    fun `opened again, the chat shows the open conversation, or a fresh page once it has ended`() = runTest(dispatcher) {
        val api = StubSupportApi()
        val first = writing(api)
        first.setDraft("سلام")
        first.send()
        testScheduler.advanceUntilIdle()
        val open = first.loaded.activeConversationId!!

        val again = opened(api)
        assertEquals(SupportComposer.Active, again.loaded.composer)
        assertEquals(open, again.loaded.shown?.id)

        api.real.endSupportConversation(open)
        val later = opened(api)
        assertEquals(SupportComposer.Fresh, later.loaded.composer)
        assertNull(later.loaded.shown)
        assertEquals(listOf(open, "sc-1"), later.loaded.closed.map { it.id })
    }

    @Test
    fun `the team ending the conversation closes the composer`() = runTest(dispatcher) {
        val api = StubSupportApi()
        val chat = writing(api)
        chat.setDraft("سلام")
        chat.send()
        testScheduler.advanceUntilIdle()
        val open = chat.loaded.activeConversationId!!

        api.real.endSupportConversation(open, SupportConversation.STATUS_CLOSED)
        chat.loadHistory()
        testScheduler.advanceUntilIdle()

        val loaded = chat.loaded
        assertNull(loaded.activeConversationId)
        assertEquals(SupportComposer.Ended, loaded.composer)
        // Its end stays on screen, with its rating, until a new one is started.
        assertEquals(open, loaded.shown?.id)
        assertEquals(SupportConversation.STATUS_CLOSED, loaded.shown?.status)
    }

    /** Closed while the message was on its way: refused, not moved — and not lost either. */
    @Test
    fun `a message the close overtook goes back to the composer`() = runTest(dispatcher) {
        val api = StubSupportApi()
        val chat = writing(api)
        chat.setDraft("سلام")
        chat.send()
        testScheduler.advanceUntilIdle()
        val open = chat.loaded.activeConversationId!!
        val itemsBefore = chat.loaded.items.size

        // The team closes it; the app has not heard yet.
        api.real.endSupportConversation(open)
        chat.setDraft("یک چیز دیگر")
        chat.send()
        assertEquals(open, chat.loaded.pending.single().conversationId)
        testScheduler.advanceUntilIdle()

        val loaded = chat.loaded
        assertTrue(loaded.pending.isEmpty())
        assertEquals(itemsBefore, loaded.items.size)
        assertEquals(SupportComposer.Ended, loaded.composer)
        assertEquals("یک چیز دیگر", chat.draft.value)
        assertEquals(StrAndroid.supportConversationEnded(Language.FA), chat.notice.value)
        assertEquals(listOf(null, open), api.targets)

        // Started again, it goes to a conversation of its own.
        chat.startNewConversation()
        assertEquals(SupportComposer.Fresh, chat.loaded.composer)
        chat.send()
        testScheduler.advanceUntilIdle()
        assertEquals(null, api.targets.last())
        assertEquals(3, chat.loaded.conversations.size)
        assertEquals(SupportComposer.Active, chat.loaded.composer)
    }

    // MARK: - Closed conversations

    @Test
    fun `the closed list is every ended conversation, the newest first, each known by its first words`() = runTest(dispatcher) {
        val api = StubSupportApi()
        val chat = writing(api)
        chat.setDraft("ایمیل‌ها وصل نمی‌شود\nجزئیات بیشتر")
        chat.send()
        testScheduler.advanceUntilIdle()
        val second = chat.loaded.activeConversationId!!
        api.real.endSupportConversation(second, SupportConversation.STATUS_CLOSED)

        val archive = SupportArchiveViewModel(api) { Language.FA }
        archive.open()
        testScheduler.advanceUntilIdle()

        val loaded = archive.state.value as SupportArchiveState.Loaded
        assertEquals(listOf(second, "sc-1"), loaded.closed.map { it.id })
        assertEquals("ایمیل‌ها وصل نمی‌شود", loaded.preview(second))
        assertEquals("سلام، مبلغ فاکتور این ماه دو بار از کارتم کم شده است.", loaded.preview("sc-1"))
        assertEquals(3, loaded.itemsOf(second).size)
    }

    @Test
    fun `a closed conversation is rated from its own screen, once`() = runTest(dispatcher) {
        val api = StubSupportApi()
        val archive = SupportArchiveViewModel(api) { Language.FA }
        archive.open()
        testScheduler.advanceUntilIdle()

        archive.rate("sc-1", 4, "  خوب  ")
        archive.rate("sc-1", 4, null)
        assertEquals(setOf("sc-1"), archive.rating.value)
        testScheduler.advanceUntilIdle()

        assertEquals(listOf("sc-1"), api.ratings)
        val rated = (archive.state.value as SupportArchiveState.Loaded).conversation("sc-1")!!
        assertEquals(4, rated.rating?.score)
        assertEquals("خوب", rated.rating?.comment)
        assertFalse(rated.canRate)
        assertTrue(archive.rating.value.isEmpty())
    }

    @Test
    fun `the server's own codes read as the operator's words`() {
        assertEquals(
            StrAndroid.supportConversationEnded(Language.EN),
            supportErrorText(ApiError.Server(409, "conversation_ended"), Language.EN),
        )
        assertEquals(
            StrAndroid.supportRateLimited(Language.EN),
            supportErrorText(ApiError.Server(429, "rate_limited"), Language.EN),
        )
        assertEquals(
            StrAndroid.supportFileTooLarge(Language.EN),
            supportErrorText(ApiError.Server(413, "file_too_large"), Language.EN),
        )
        assertEquals(
            Str.fileTypeNotAllowed(Language.EN),
            supportErrorText(ApiError.Server(400, "file_type_not_allowed"), Language.EN),
        )
        assertEquals(
            StrAndroid.supportUnavailable(Language.EN),
            supportErrorText(ApiError.Server(404, "support_disabled"), Language.EN),
        )
        assertEquals(
            StrAndroid.supportUnavailable(Language.EN),
            supportErrorText(ApiError.Server(404, "support_not_configured"), Language.EN),
        )
    }

    /**
     * The sample backend, with failures on call and a record of what was
     * sent: client ids of every message and file attempt, ratings, reads.
     */
    private class StubSupportApi(
        val real: SampleApi = SampleApi(),
        private var failSends: Int = 0,
        private var failUploads: Int = 0,
        private val ratingError: Throwable? = null,
    ) : WebyarApi by real {
        var statusError: Throwable? = null
        val sent = mutableListOf<String>()
        val uploads = mutableListOf<String>()

        /** The conversation each message and file named; null for "a new one". */
        val targets = mutableListOf<String?>()
        val ratings = mutableListOf<String>()
        var marked = 0
        var historyReads = 0

        override suspend fun supportStatus(): SupportStatus {
            statusError?.let { throw it }
            return real.supportStatus()
        }

        override suspend fun supportHistory() = real.supportHistory().also { historyReads++ }

        override suspend fun sendSupportMessage(
            body: String,
            clientMessageId: String,
            conversationId: String?,
            workspaceId: String?,
        ): SupportPostResult {
            sent += clientMessageId
            targets += conversationId
            if (failSends > 0) {
                failSends--
                throw ApiError.Server(429, "rate_limited")
            }
            return real.sendSupportMessage(body, clientMessageId, conversationId, workspaceId)
        }

        override suspend fun sendSupportAttachment(
            fileName: String,
            mimeType: String,
            bytes: ByteArray,
            clientMessageId: String,
            conversationId: String?,
            workspaceId: String?,
        ): SupportPostResult {
            uploads += clientMessageId
            targets += conversationId
            if (failUploads > 0) {
                failUploads--
                throw ApiError.Transport(null)
            }
            return real.sendSupportAttachment(fileName, mimeType, bytes, clientMessageId, conversationId, workspaceId)
        }

        override suspend fun rateSupportConversation(conversationId: String, score: Int, comment: String?): SupportConversation {
            ratings += conversationId
            ratingError?.let { throw it }
            return real.rateSupportConversation(conversationId, score, comment)
        }

        override suspend fun markSupportRead() {
            marked++
            real.markSupportRead()
        }
    }
}
