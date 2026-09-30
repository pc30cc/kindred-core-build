package com.webyar.ai.feature.chat

import com.webyar.ai.core.model.CannedResponse
import com.webyar.ai.core.model.CannedText
import com.webyar.ai.core.model.InboxFilter
import com.webyar.ai.core.net.SampleApi
import com.webyar.ai.core.net.WebyarApi
import com.webyar.ai.i18n.Language
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * What the chat's view model decides, as against what the screen draws.
 *
 * The split matters for one of these in particular: trimming belongs here,
 * not in the composer, because the draft is hoisted so a saved reply can be
 * inserted from outside. A behaviour that sits between layers is exactly the
 * kind that gets lost, so it is pinned where it lives.
 */
@OptIn(ExperimentalCoroutinesApi::class)
// Robolectric for android.icu: the length notice formats its limit with the
// operator's digits (Format.number), which the plain JVM's stubbed android.jar
// cannot do — as TeamChatTest, which checks the same notice, already runs.
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class ChatViewModelTest {

    private val dispatcher = StandardTestDispatcher()

    @Before fun setUp() = Dispatchers.setMain(dispatcher)
    @After fun tearDown() = Dispatchers.resetMain()

    private fun model(api: SampleApi = SampleApi()) =
        ChatViewModel(api) { Language.FA }

    @Test
    fun `a draft of only whitespace is never sent`() = runTest(dispatcher) {
        val api = SampleApi()
        val conversation = api.conversations("ws-1", InboxFilter.OPEN).first()
        val before = api.messages(conversation.id).size

        val chat = model(api)
        chat.open(conversation, "ws-1")
        chat.setDraft("   \n  ")
        chat.send()
        testScheduler.advanceUntilIdle()

        assertEquals(before, api.messages(conversation.id).size)
    }

    @Test
    fun `the body reaches the server trimmed`() = runTest(dispatcher) {
        val api = SampleApi()
        val conversation = api.conversations("ws-1", InboxFilter.OPEN).first()

        val chat = model(api)
        chat.open(conversation, "ws-1")
        testScheduler.advanceUntilIdle()
        chat.setDraft("  روی راهم  ")
        chat.send()
        testScheduler.advanceUntilIdle()

        assertEquals("روی راهم", api.messages(conversation.id).last().body)
    }

    @Test
    fun `the draft clears once the send lands`() = runTest(dispatcher) {
        val api = SampleApi()
        val conversation = api.conversations("ws-1", InboxFilter.OPEN).first()

        val chat = model(api)
        chat.open(conversation, "ws-1")
        testScheduler.advanceUntilIdle()
        chat.setDraft("first")
        chat.send()
        testScheduler.advanceUntilIdle()

        assertEquals("", chat.draft.value)
    }

    /**
     * Past the server's limit a send is refused every time, so it is never
     * made: the words stay in the box, with the reason, instead of going to
     * a bubble whose Retry could never work.
     */
    @Test
    fun `a message over the server's limit stays in the draft and is not sent`() = runTest(dispatcher) {
        val api = SampleApi()
        val conversation = api.conversations("ws-1", InboxFilter.OPEN).first()
        val before = api.messages(conversation.id).size

        val chat = model(api)
        chat.open(conversation, "ws-1")
        testScheduler.advanceUntilIdle()
        val long = "a".repeat(MAX_BODY_CHARS + 1)
        chat.setDraft(long)
        chat.send()
        testScheduler.advanceUntilIdle()

        assertEquals(before, api.messages(conversation.id).size)
        assertEquals(long, chat.draft.value)
        assertTrue(chat.notice.value != null)
    }

    /**
     * A saved reply is APPENDED, not substituted.
     *
     * An operator who has written half a sentence and then reaches for a
     * greeting wants both — replacing the draft would throw away what they had
     * already typed, silently.
     */
    @Test
    fun `inserting a saved reply keeps what was already written`() = runTest(dispatcher) {
        val chat = model()
        chat.setDraft("سلام،")
        chat.insertShortcut(
            CannedResponse(
                id = "cr-1", shortcut = "hi", title = "Greeting",
                body = "به {{workspace.name}} خوش آمدید.", locale = "fa",
            ),
            CannedText.Context(workspaceName = "Sample Workspace"),
        )

        val draft = chat.draft.value
        assertTrue(draft.startsWith("سلام،"))
        assertTrue(draft.contains("Sample Workspace"))
    }

    @Test
    fun `an inserted reply has its placeholders resolved on the way in`() = runTest(dispatcher) {
        val chat = model()
        chat.insertShortcut(
            CannedResponse(
                id = "cr-1", shortcut = "hi", title = "Greeting",
                body = "Hello {{contact.name}} — {{workspace.name}}", locale = "en",
            ),
            CannedText.Context(contactName = "Maryam", workspaceName = "Sample Workspace"),
        )
        assertEquals("Hello Maryam — Sample Workspace", chat.draft.value)
        // And nothing half-resolved is left behind.
        assertNotEquals(true, chat.draft.value.contains("{{"))
    }

    /**
     * The picker searches as the operator types, one request per (debounced)
     * query — and the answers do not come back in the order they were asked.
     * The list on screen is the newest query's, whichever answer is slower.
     */
    @Test
    fun `a slow answer to an older search does not replace the newer one`() = runTest(dispatcher) {
        val api = SlowSearchApi()
        val conversation = api.conversations("ws-1", InboxFilter.OPEN).first()
        val chat = ChatViewModel(api) { Language.FA }
        chat.open(conversation, "ws-1")
        testScheduler.advanceUntilIdle()

        chat.loadShortcuts("hel") // slow
        chat.loadShortcuts("hello") // fast
        testScheduler.advanceUntilIdle()

        val shown = chat.shortcuts.value as ShortcutsState.Loaded
        assertEquals(listOf("cr-hello"), shown.items.map { it.id })
    }

    /** The sample server, with a search whose shorter queries answer last. */
    private class SlowSearchApi(private val real: SampleApi = SampleApi()) : WebyarApi by real {
        override suspend fun cannedResponses(workspaceId: String, locale: String, query: String): List<CannedResponse> {
            delay(if (query.length < 5) 2_000 else 10)
            return listOf(
                CannedResponse(id = "cr-$query", shortcut = query, title = query, body = query, locale = locale),
            )
        }
    }
}
