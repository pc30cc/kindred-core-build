package com.webyar.operator.feature.chat

import com.webyar.operator.core.model.CannedResponse
import com.webyar.operator.core.model.CannedText
import com.webyar.operator.core.model.InboxFilter
import com.webyar.operator.core.net.SampleApi
import com.webyar.operator.i18n.Language
import kotlinx.coroutines.Dispatchers
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

/**
 * What the chat's view model decides, as against what the screen draws.
 *
 * The split matters for one of these in particular: trimming used to happen in
 * the composer, and moved here when the draft was hoisted so a saved reply
 * could be inserted from outside. A behaviour that moves between layers is
 * exactly the kind that gets lost, so it is pinned where it now lives.
 */
@OptIn(ExperimentalCoroutinesApi::class)
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
}
