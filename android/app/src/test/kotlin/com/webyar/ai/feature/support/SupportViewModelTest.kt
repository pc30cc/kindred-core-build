package com.webyar.ai.feature.support

import com.webyar.ai.core.model.SupportPostResult
import com.webyar.ai.core.model.SupportStatus
import com.webyar.ai.core.net.ApiError
import com.webyar.ai.core.net.SampleApi
import com.webyar.ai.core.net.WebyarApi
import com.webyar.ai.i18n.Language
import com.webyar.ai.i18n.StrAndroid
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * Online support as the operator uses it: whether it is offered, a chat that
 * starts with its first message, a message that fails and is tried again,
 * and a ticket for when nobody is online.
 *
 * Plain JUnit — nothing here draws.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class SupportViewModelTest {

    private val dispatcher = StandardTestDispatcher()

    @Before fun setUp() = Dispatchers.setMain(dispatcher)
    @After fun tearDown() = Dispatchers.resetMain()

    // MARK: - Settings' view

    @Test
    fun `the team's status and the earlier requests are read`() = runTest(dispatcher) {
        val home = SupportHomeViewModel(SampleApi()) { Language.FA }
        assertNull(home.status.value)
        assertFalse(home.loaded.value)

        home.refresh()
        testScheduler.advanceUntilIdle()

        val status = home.status.value!!
        assertTrue(status.shown && status.online && status.canStart)
        assertTrue(home.loaded.value)
        val ticket = home.threads.value.single()
        assertEquals(1042L, ticket.number)
        // The team's answer has not been read yet.
        assertEquals(1, ticket.unread)
        assertTrue(ticket.isAnswered)
    }

    /** "Online" was true a minute ago; a read that fails does not make it "off". */
    @Test
    fun `a status read that fails keeps the last answer`() = runTest(dispatcher) {
        val api = StubSupportApi()
        val home = SupportHomeViewModel(api) { Language.FA }
        home.refresh()
        testScheduler.advanceUntilIdle()
        assertTrue(home.status.value!!.online)

        api.statusError = ApiError.Transport(null)
        home.refresh()
        testScheduler.advanceUntilIdle()

        assertTrue(home.status.value!!.online)
    }

    @Test
    fun `a backend without support offers nothing`() = runTest(dispatcher) {
        val bare = object : WebyarApi by SampleApi() {
            override suspend fun supportStatus(): SupportStatus = SupportStatus()
        }
        val home = SupportHomeViewModel(bare) { Language.FA }
        home.refresh()
        testScheduler.advanceUntilIdle()

        assertFalse(home.status.value!!.shown)
        assertFalse(home.status.value!!.canStart)
    }

    // MARK: - A thread

    /** A new chat has no thread until its first message lands; then it is that thread. */
    @Test
    fun `the first message starts the chat, and the team's answer is read with it`() = runTest(dispatcher) {
        val chat = SupportThreadViewModel(SampleApi()) { Language.FA }
        chat.open(threadId = null, workspaceId = "ws-1")
        val empty = chat.state.value as SupportThreadState.Loaded
        assertNull(empty.thread)
        assertTrue(empty.messages.isEmpty())

        chat.setDraft("  سلام، ایمیل‌ها وصل نمی‌شود  ")
        chat.send()
        // Shown at once, as "sending", and the field is empty for the next.
        val sending = chat.state.value as SupportThreadState.Loaded
        assertEquals(listOf("سلام، ایمیل‌ها وصل نمی‌شود"), sending.pending.map { it.body })
        assertEquals("", chat.draft.value)

        testScheduler.advanceUntilIdle()

        val loaded = chat.state.value as SupportThreadState.Loaded
        assertEquals("st-chat-2", chat.threadId.value)
        assertEquals("st-chat-2", loaded.thread?.id)
        assertTrue(loaded.pending.isEmpty())
        assertEquals(listOf(false, true), loaded.messages.map { it.fromTeam })
    }

    @Test
    fun `an empty message is not sent`() = runTest(dispatcher) {
        val api = StubSupportApi()
        val chat = SupportThreadViewModel(api) { Language.FA }
        chat.open(threadId = null, workspaceId = "ws-1")

        chat.setDraft("   ")
        chat.send()
        testScheduler.advanceUntilIdle()

        assertTrue(api.sent.isEmpty())
    }

    /** One id for every attempt: the server keeps the first and answers the retry with it. */
    @Test
    fun `a message that fails stays, marked, and its retry is the same message`() = runTest(dispatcher) {
        val api = StubSupportApi(failSends = 1)
        val chat = SupportThreadViewModel(api) { Language.FA }
        chat.open(threadId = null, workspaceId = "ws-1")

        chat.setDraft("کمک")
        chat.send()
        testScheduler.advanceUntilIdle()

        val failed = chat.state.value as SupportThreadState.Loaded
        val pending = failed.pending.single()
        assertTrue(pending.failed)
        assertTrue(failed.messages.isEmpty())
        assertEquals(StrAndroid.supportRateLimited(Language.FA), chat.notice.value)

        chat.retry(pending.clientMessageId)
        testScheduler.advanceUntilIdle()

        val sent = chat.state.value as SupportThreadState.Loaded
        assertTrue(sent.pending.isEmpty())
        assertEquals(1, sent.messages.count { !it.fromTeam })
        assertEquals(listOf(pending.clientMessageId, pending.clientMessageId), api.sent)
    }

    @Test
    fun `opening a thread with an unread answer marks it read`() = runTest(dispatcher) {
        val api = StubSupportApi()
        val thread = SupportThreadViewModel(api) { Language.FA }
        thread.open(threadId = "st-ticket-1", workspaceId = "ws-1")
        testScheduler.advanceUntilIdle()

        val loaded = thread.state.value as SupportThreadState.Loaded
        assertEquals(1042L, loaded.thread?.number)
        assertEquals(2, loaded.messages.size)
        assertEquals(listOf("st-ticket-1"), api.marked)
    }

    @Test
    fun `a thread that cannot be read says so`() = runTest(dispatcher) {
        val thread = SupportThreadViewModel(SampleApi()) { Language.FA }
        thread.open(threadId = "st-missing", workspaceId = "ws-1")
        testScheduler.advanceUntilIdle()

        assertTrue(thread.state.value is SupportThreadState.Failed)
    }

    @Test
    fun `a closed thread takes no more messages`() = runTest(dispatcher) {
        val api = StubSupportApi(closed = true)
        val thread = SupportThreadViewModel(api) { Language.FA }
        thread.open(threadId = "st-ticket-1", workspaceId = "ws-1")
        testScheduler.advanceUntilIdle()
        assertTrue((thread.state.value as SupportThreadState.Loaded).closed)

        thread.setDraft("یک سؤال دیگر")
        thread.send()
        testScheduler.advanceUntilIdle()

        assertTrue(api.sent.isEmpty())
        assertEquals("یک سؤال دیگر", thread.draft.value)
    }

    // MARK: - A ticket

    @Test
    fun `a ticket needs a subject and a message`() = runTest(dispatcher) {
        val ticket = SupportTicketViewModel(SampleApi()) { Language.FA }
        assertFalse(ticket.canSubmit)
        ticket.setSubject("فاکتور")
        assertFalse(ticket.canSubmit)
        ticket.setBody("   ")
        assertFalse(ticket.canSubmit)
        ticket.setBody("مبلغ دو بار کم شده")
        assertTrue(ticket.canSubmit)
    }

    /** A submit that failed and is tried again is the same ticket, not a second one. */
    @Test
    fun `a ticket is filed once, however often it is submitted`() = runTest(dispatcher) {
        val api = StubSupportApi(failTickets = 1)
        val ticket = SupportTicketViewModel(api) { Language.FA }
        ticket.setSubject(" فاکتور ")
        ticket.setBody("مبلغ دو بار کم شده")

        ticket.submit("ws-1")
        testScheduler.advanceUntilIdle()
        assertEquals(StrAndroid.supportRateLimited(Language.FA), ticket.error.value)
        assertNull(ticket.created.value)

        ticket.submit("ws-1")
        testScheduler.advanceUntilIdle()
        val created = ticket.created.value!!
        assertTrue(created.isTicket)
        assertEquals("فاکتور", created.subject)

        ticket.submit("ws-1")
        testScheduler.advanceUntilIdle()
        assertEquals(2, api.tickets.size)
        assertEquals(1, api.tickets.toSet().size)
    }

    @Test
    fun `the server's own codes read as the operator's words`() {
        assertEquals(
            StrAndroid.supportClosed(Language.EN),
            supportErrorText(ApiError.Server(409, "thread_closed"), Language.EN),
        )
        assertEquals(
            StrAndroid.supportUnavailable(Language.EN),
            supportErrorText(ApiError.Server(403, "support_member"), Language.EN),
        )
        assertEquals(
            StrAndroid.supportUnavailable(Language.EN),
            supportErrorText(ApiError.Server(404, "support_disabled"), Language.EN),
        )
    }

    /**
     * The sample backend, with failures on call and a record of what was
     * sent: client ids of every message and ticket attempt, threads marked read.
     */
    private class StubSupportApi(
        private val real: SampleApi = SampleApi(),
        private var failSends: Int = 0,
        private var failTickets: Int = 0,
        private val closed: Boolean = false,
    ) : WebyarApi by real {
        var statusError: Throwable? = null
        val sent = mutableListOf<String>()
        val tickets = mutableListOf<String>()
        val marked = mutableListOf<String>()

        override suspend fun supportStatus(): SupportStatus {
            statusError?.let { throw it }
            return real.supportStatus()
        }

        override suspend fun supportThread(threadId: String) = real.supportThread(threadId).let { detail ->
            if (closed) detail.copy(thread = detail.thread.copy(status = "closed")) else detail
        }

        override suspend fun sendSupportChat(body: String, clientMessageId: String, workspaceId: String?): SupportPostResult {
            sent += clientMessageId
            if (failSends > 0) {
                failSends--
                throw ApiError.Server(429, "rate_limited")
            }
            return real.sendSupportChat(body, clientMessageId, workspaceId)
        }

        override suspend fun replySupportThread(threadId: String, body: String, clientMessageId: String): SupportPostResult {
            sent += clientMessageId
            return real.replySupportThread(threadId, body, clientMessageId)
        }

        override suspend fun createSupportTicket(
            subject: String,
            body: String,
            clientMessageId: String,
            workspaceId: String?,
        ): SupportPostResult {
            tickets += clientMessageId
            if (failTickets > 0) {
                failTickets--
                throw ApiError.Server(429, "rate_limited")
            }
            return real.createSupportTicket(subject, body, clientMessageId, workspaceId)
        }

        override suspend fun markSupportThreadRead(threadId: String) {
            marked += threadId
            real.markSupportThreadRead(threadId)
        }
    }
}
