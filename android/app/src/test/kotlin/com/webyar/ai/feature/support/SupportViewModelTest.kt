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
    fun `the history is one chat, each ended conversation closed and offered for rating`() = runTest(dispatcher) {
        val chat = opened()

        val loaded = chat.loaded
        val resolved = loaded.conversations.single()
        assertTrue(resolved.ended)
        assertTrue(resolved.canRate)
        assertNull(loaded.activeConversationId)
        // Nothing open, one ended: the next message starts a new one.
        assertTrue(loaded.startsNewConversation)

        val rows = supportTimeline(loaded.conversations, loaded.items, loaded.pending)
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
        val chat = opened()

        chat.setDraft("  سلام، ایمیل‌ها وصل نمی‌شود  ")
        chat.send()
        val sending = chat.loaded
        assertEquals(listOf("سلام، ایمیل‌ها وصل نمی‌شود"), sending.pending.map { it.body })
        assertFalse(sending.pending.single().failed)
        assertEquals("", chat.draft.value)
        val id = sending.pending.single().clientMessageId

        testScheduler.advanceUntilIdle()

        val sent = chat.loaded
        assertTrue(sent.pending.isEmpty())
        assertEquals(2, sent.conversations.size)
        assertEquals(sent.conversations.last().id, sent.activeConversationId)
        assertFalse(sent.startsNewConversation)
        val mine = sent.items.single { it.clientMessageId == id }
        assertEquals(sent.activeConversationId, mine.conversationId)
        // The team joined the new conversation and answered once.
        val theirs = sent.items.filter { it.conversationId == mine.conversationId && it.fromTeam }
        assertEquals(listOf(true, false), theirs.map { it.isJoin })

        val rows = supportTimeline(sent.conversations, sent.items, sent.pending)
        assertTrue(rows.any { it is SupportRow.NewConversation })
    }

    @Test
    fun `an empty message is not sent`() = runTest(dispatcher) {
        val api = StubSupportApi()
        val chat = opened(api)

        chat.setDraft("   ")
        chat.send()
        testScheduler.advanceUntilIdle()

        assertTrue(api.sent.isEmpty())
    }

    /** One id for every attempt: the server keeps the first and answers the retry with it. */
    @Test
    fun `a message that fails stays, marked, and its retry is the same message`() = runTest(dispatcher) {
        val api = StubSupportApi(failSends = 1)
        val chat = opened(api)

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
        val chat = opened(api)

        chat.sendFile(ByteArray(SupportChatViewModel.MAX_FILE_BYTES + 1), "scan.pdf", "application/pdf")
        testScheduler.advanceUntilIdle()

        assertTrue(api.uploads.isEmpty())
        assertTrue(chat.loaded.pending.isEmpty())
        assertEquals(StrAndroid.supportFileTooLarge(Language.FA), chat.notice.value)
    }

    @Test
    fun `a file of a type the server refuses is not sent either`() = runTest(dispatcher) {
        val api = StubSupportApi()
        val chat = opened(api)

        chat.sendFile(ByteArray(10), "voice.mp3", "audio/mpeg")
        testScheduler.advanceUntilIdle()

        assertTrue(api.uploads.isEmpty())
        assertEquals(Str.fileTypeNotAllowed(Language.FA), chat.notice.value)
    }

    /** A file that fails keeps its bytes, and the retry sends them again under the same id. */
    @Test
    fun `a file lands as an attachment, and its retry sends the same bytes`() = runTest(dispatcher) {
        val api = StubSupportApi(failUploads = 1)
        val chat = opened(api)
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
        val chat = opened(api)
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

    @Test
    fun `the server's own codes read as the operator's words`() {
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
        val ratings = mutableListOf<String>()
        var marked = 0
        var historyReads = 0

        override suspend fun supportStatus(): SupportStatus {
            statusError?.let { throw it }
            return real.supportStatus()
        }

        override suspend fun supportHistory() = real.supportHistory().also { historyReads++ }

        override suspend fun sendSupportMessage(body: String, clientMessageId: String, workspaceId: String?): SupportPostResult {
            sent += clientMessageId
            if (failSends > 0) {
                failSends--
                throw ApiError.Server(429, "rate_limited")
            }
            return real.sendSupportMessage(body, clientMessageId, workspaceId)
        }

        override suspend fun sendSupportAttachment(
            fileName: String,
            mimeType: String,
            bytes: ByteArray,
            clientMessageId: String,
            workspaceId: String?,
        ): SupportPostResult {
            uploads += clientMessageId
            if (failUploads > 0) {
                failUploads--
                throw ApiError.Transport(null)
            }
            return real.sendSupportAttachment(fileName, mimeType, bytes, clientMessageId, workspaceId)
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
