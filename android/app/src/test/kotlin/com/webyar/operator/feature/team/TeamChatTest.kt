package com.webyar.operator.feature.team

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
import org.junit.Assert.assertNotEquals
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
class TeamChatTest {

    @get:Rule val compose = createComposeRule()

    private val dispatcher = StandardTestDispatcher()

    @Before fun setUp() = Dispatchers.setMain(dispatcher)
    @After fun tearDown() = Dispatchers.resetMain()

    private fun list(api: SampleApi = SampleApi()) = ColleaguesViewModel(api) { Language.FA }
    private fun thread(api: SampleApi = SampleApi()) = TeamThreadViewModel(api) { Language.FA }

    private fun ids(state: ColleaguesState) =
        (state as ColleaguesState.Loaded).colleagues.map { it.userId }

    // MARK: - The list

    @Test
    fun `binding loads the team`() = runTest(dispatcher) {
        val colleagues = list()
        colleagues.bind("ws-1")
        testScheduler.advanceUntilIdle()

        assertEquals(listOf("u-2", "u-3", "u-9"), ids(colleagues.state.value))
    }

    @Test
    fun `search reaches the name and the address`() = runTest(dispatcher) {
        val colleagues = list()
        colleagues.bind("ws-1")
        testScheduler.advanceUntilIdle()

        colleagues.setQuery("reza")
        assertEquals(listOf("u-2"), ids(colleagues.state.value))

        // The colleague with no name at all, findable only by address.
        colleagues.setQuery("NEWCOMER@")
        assertEquals(listOf("u-9"), ids(colleagues.state.value))
    }

    /**
     * The badge goes as the thread opens, not one refresh later. The server is
     * told separately; this is only so an operator does not watch a count they
     * have just read sit there.
     */
    @Test
    fun `opening a thread clears its badge straight away`() = runTest(dispatcher) {
        val colleagues = list()
        colleagues.bind("ws-1")
        testScheduler.advanceUntilIdle()
        assertEquals(2, colleagues.colleague("u-2")?.unread)

        colleagues.markRead("u-2")
        assertEquals(0, colleagues.colleague("u-2")?.unread)
        // And nobody else was touched.
        assertEquals(3, ids(colleagues.state.value).size)
    }

    /** A colleague who sent a photo has not sent you nothing. */
    @Test
    fun `an attachment-only message previews as what it is`() = runTest {
        val team = SampleApi().colleagues("ws-1").colleagues
        val photo = team.first { it.userId == "u-3" }
        assertEquals(null, photo.lastMessage?.body)

        assertEquals(Str.photo(Language.FA), photo.preview(Language.FA))
        assertEquals(Str.photo(Language.EN), photo.preview(Language.EN))
    }

    /** No name at all: `displayName` falls through to the address. */
    @Test
    fun `a colleague with no name is shown by their address`() = runTest {
        val newcomer = SampleApi().colleagues("ws-1").colleagues.first { it.userId == "u-9" }
        assertEquals(null, newcomer.fullName)
        assertEquals("newcomer@webyar.app", newcomer.displayName)
    }

    // MARK: - The thread

    @Test
    fun `opening a thread loads it and learns who we are`() = runTest(dispatcher) {
        val api = SampleApi()
        val team = thread(api)
        team.open("ws-1", "u-2")
        testScheduler.advanceUntilIdle()

        assertTrue(team.state.value is TeamThreadState.Loaded)
        // From the server, not from the session: it is how a message is known
        // to be ours, and two sources for that is one drift.
        assertNotEquals(null, team.me.value)
    }

    @Test
    fun `a draft of only whitespace is never sent`() = runTest(dispatcher) {
        val api = SampleApi()
        val team = thread(api)
        team.open("ws-1", "u-2")
        testScheduler.advanceUntilIdle()
        val before = (team.state.value as TeamThreadState.Loaded).messages.size

        team.setDraft("   \n ")
        team.send()
        testScheduler.advanceUntilIdle()

        assertEquals(before, (team.state.value as TeamThreadState.Loaded).messages.size)
    }

    @Test
    fun `the body reaches the server trimmed, and the draft clears`() = runTest(dispatcher) {
        val api = SampleApi()
        val team = thread(api)
        team.open("ws-1", "u-2")
        testScheduler.advanceUntilIdle()

        team.setDraft("  بررسی می‌کنم  ")
        team.send()
        testScheduler.advanceUntilIdle()

        val sent = (team.state.value as TeamThreadState.Loaded).messages.last()
        assertEquals("بررسی می‌کنم", sent.body)
        assertEquals("", team.draft.value)
    }

    /**
     * A send must not blank the transcript.
     *
     * Reloading through `Loading` would throw the thread away and put a
     * placeholder where the operator's own message had just appeared — which
     * is the difference between `load` and `reload` in the model.
     */
    @Test
    fun `sending never puts the thread back into loading`() = runTest(dispatcher) {
        val api = SampleApi()
        val team = thread(api)
        team.open("ws-1", "u-2")
        testScheduler.advanceUntilIdle()

        team.setDraft("سلام")
        team.send()
        // Mid-flight, before the reload has landed.
        assertTrue(team.state.value is TeamThreadState.Loaded)
        testScheduler.advanceUntilIdle()
        assertTrue(team.state.value is TeamThreadState.Loaded)
    }

    // MARK: - The screens

    @Test
    fun `the list draws a row per colleague`() = runTest {
        val team = SampleApi().colleagues("ws-1").colleagues
        compose.setContent { ColleaguesScreen(ColleaguesState.Loaded(team), Language.FA, {}) }

        compose.onNodeWithTag(A11y.COLLEAGUES_LIST).assertIsDisplayed()
        compose.onNodeWithTag(A11y.colleagueRow("u-2")).assertIsDisplayed()
        compose.onNodeWithTag(A11y.colleagueRow("u-9")).assertIsDisplayed()
    }

    @Test
    fun `tapping a colleague opens their thread`() = runTest {
        val team = SampleApi().colleagues("ws-1").colleagues
        var opened: String? = null
        compose.setContent {
            ColleaguesScreen(ColleaguesState.Loaded(team), Language.FA, { opened = it.userId })
        }
        compose.onNodeWithTag(A11y.colleagueRow("u-3")).performClick()
        compose.waitForIdle()

        assertEquals("u-3", opened)
    }

    @Test
    fun `an empty team says so`() {
        compose.setContent { ColleaguesScreen(ColleaguesState.Loaded(emptyList()), Language.FA, {}) }

        compose.onNodeWithTag(A11y.COLLEAGUES_EMPTY).assertIsDisplayed()
        compose.onNodeWithText(Str.colleaguesEmptyTitle(Language.FA)).assertIsDisplayed()
    }

    @Test
    fun `the transcript draws a bubble per message`() = runTest {
        val api = SampleApi()
        val response = api.teamThread("ws-1", "u-2")
        compose.setContent {
            TeamThreadScreen(
                TeamThreadState.Loaded(response.messages),
                me = response.me,
                language = Language.FA,
            )
        }

        compose.onNodeWithTag(A11y.TEAM_TRANSCRIPT).assertIsDisplayed()
        response.messages.forEach {
            compose.onNodeWithTag(A11y.messageRow(it.id)).assertIsDisplayed()
        }
    }

    /**
     * A thread whose `me` never arrived would otherwise draw every message as
     * incoming — which is wrong but survivable, and must not crash.
     */
    @Test
    fun `a transcript with no me still renders`() = runTest {
        val response = SampleApi().teamThread("ws-1", "u-2")
        compose.setContent {
            TeamThreadScreen(TeamThreadState.Loaded(response.messages), me = null, language = Language.FA)
        }
        compose.onNodeWithTag(A11y.TEAM_TRANSCRIPT).assertIsDisplayed()
    }
}
