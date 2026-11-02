package com.platform.app.feature.team

import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.assertHasClickAction
import androidx.compose.ui.test.assertHasNoClickAction
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import com.platform.app.core.model.CallChannel
import com.platform.app.core.model.Colleague
import com.platform.app.core.model.ColleaguesResponse
import com.platform.app.core.model.TeamCallOutcome
import com.platform.app.core.model.TeamChatCall
import com.platform.app.core.model.TeamMessage
import com.platform.app.core.model.TeamThreadResponse
import com.platform.app.core.net.SampleApi
import com.platform.app.i18n.Format
import com.platform.app.i18n.Language
import com.platform.app.i18n.Str
import com.platform.app.ui.A11y
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.time.Instant

/**
 * The call in the chat (docs/operations/TEAM_CALLS.md, "The call in the
 * chat"): the `call` a team-chat line carries, how it decodes, the title and
 * colour each side sees, the length, and the bubble and the list's preview.
 *
 * Robolectric: the reader's digits come from `android.icu`, and the bubble is
 * Compose.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class TeamCallLogTest {

    @get:Rule val compose = createComposeRule()

    /** The API client's own settings (`ApiClient`). */
    private val json = Json { ignoreUnknownKeys = true; explicitNulls = false; coerceInputValues = true }

    private fun call(
        outcome: TeamCallOutcome,
        channel: CallChannel = CallChannel.AUDIO,
        duration: Long? = null,
        callerId: String = ME,
    ) = TeamChatCall(id = "call-1", channel = channel, outcome = outcome, durationSeconds = duration, callerId = callerId)

    // MARK: - Decoding

    /** `GET /api/team-chat/thread`, as the route writes it. */
    @Test
    fun `a thread decodes its calls, and every other message is unchanged`() {
        val body = """
            {"ok":true,"me":"u-1","messages":[
              {"id":"m-1","sender_id":"u-2","recipient_id":"u-1","body":"hello","attachment_id":null,
               "reply_to_id":null,"read_at":null,"created_at":"2026-11-02T08:00:00.000Z","attachment":null},
              {"id":"m-2","sender_id":"u-1","recipient_id":"u-2","body":"hi","attachment_id":null,
               "read_at":null,"created_at":"2026-11-02T08:01:00.000Z","attachment":null,"call":null},
              {"id":"m-3","sender_id":"u-1","recipient_id":"u-2","body":"📹 2:05","attachment_id":null,
               "read_at":"2026-11-02T08:05:00.000Z","created_at":"2026-11-02T08:02:00.000Z","attachment":null,
               "call":{"id":"9d6c1f0e-5a43-4c51-9b55-1a1b2c3d4e5f","channel":"video","outcome":"completed",
                       "duration_seconds":125,"caller_id":"u-1"}},
              {"id":"m-4","sender_id":"u-2","recipient_id":"u-1","body":"📞","attachment_id":null,
               "read_at":null,"created_at":"2026-11-02T08:10:00.000Z","attachment":null,
               "call":{"id":"c-2","channel":"audio","outcome":"missed","duration_seconds":null,"caller_id":"u-2"}}
            ]}
        """.trimIndent()
        val thread = json.decodeFromString(TeamThreadResponse.serializer(), body)

        assertEquals(listOf("m-1", "m-2", "m-3", "m-4"), thread.messages.map { it.id })
        assertNull("a message without call has none", thread.messages[0].call)
        assertNull(thread.messages[1].call)
        assertEquals(
            TeamChatCall("9d6c1f0e-5a43-4c51-9b55-1a1b2c3d4e5f", CallChannel.VIDEO, TeamCallOutcome.COMPLETED, 125, "u-1"),
            thread.messages[2].call,
        )
        assertEquals(
            TeamChatCall("c-2", CallChannel.AUDIO, TeamCallOutcome.MISSED, null, "u-2"),
            thread.messages[3].call,
        )
        assertEquals("hello", thread.messages[0].body)
    }

    /**
     * A `call` this build does not understand is no call, and never takes the
     * thread down with it: the line stays the message its body makes it, as
     * the web panel reads it (`teamChatCallOf`).
     */
    @Test
    fun `a call this build cannot read is none, and the thread still decodes`() {
        fun line(call: String) = """
            {"id":"m","sender_id":"u-2","recipient_id":"u-1","body":"📞",
             "created_at":"2026-11-02T08:00:00.000Z","call":$call}
        """.trimIndent()
        val unreadable = listOf(
            """{"id":"c","channel":"audio","outcome":"transferred","caller_id":"u-2"}""",
            """{"id":"c","channel":"screen","outcome":"missed","caller_id":"u-2"}""",
            """{"id":"c","channel":"audio","outcome":"missed"}""",
            """{"channel":"audio","outcome":"missed","caller_id":"u-2"}""",
            """{"id":"","channel":"audio","outcome":"missed","caller_id":"u-2"}""",
            """{"id":7,"channel":["audio"],"outcome":{},"caller_id":"u-2"}""",
            "\"a call\"",
            "42",
            "[]",
        )
        unreadable.forEach { call ->
            val body = """{"me":"u-1","messages":[${line(call)},{"id":"m-2","sender_id":"u-1","body":"ok"}]}"""
            val thread = json.decodeFromString(TeamThreadResponse.serializer(), body)
            assertEquals(call, 2, thread.messages.size)
            assertNull(call, thread.messages[0].call)
            assertEquals("📞", thread.messages[0].body)
        }
    }

    @Test
    fun `a length the server cannot know is none, and a fractional one is whole seconds`() {
        fun duration(value: String) = json.decodeFromString(
            TeamMessage.serializer(),
            """{"id":"m","sender_id":"u-1","call":{"id":"c","channel":"audio","outcome":"completed",
                "duration_seconds":$value,"caller_id":"u-1"}}""",
        ).call?.durationSeconds
        assertEquals(125L, duration("125"))
        assertEquals(125L, duration("125.9"))
        assertNull(duration("-3"))
        assertNull(duration("null"))
        // Not a number: the length goes, the call stays (the web's `teamChatCallOf`).
        assertNull(duration("\"125\""))
        assertNull(duration("{}"))
        assertEquals(
            TeamCallOutcome.COMPLETED,
            json.decodeFromString(
                TeamMessage.serializer(),
                """{"id":"m","sender_id":"u-1","call":{"id":"c","channel":"audio","outcome":"completed",
                    "duration_seconds":"long","caller_id":"u-1"}}""",
            ).call?.outcome,
        )
    }

    /** `GET /api/team-chat/colleagues`: the preview's `call`, beside the fields it had. */
    @Test
    fun `the colleagues' last message carries its call`() {
        val body = """
            {"ok":true,"me":"u-1","total_unread":1,"colleagues":[
              {"user_id":"u-2","role":"agent","full_name":"Daniel Carter","email":"d@example.org","avatar_url":null,
               "unread":1,"last_message":{"body":"📞","created_at":"2026-11-02T08:10:00.000Z","outgoing":false,
               "attachment_kind":null,"call":{"id":"c-2","channel":"audio","outcome":"missed","duration_seconds":null,"caller_id":"u-2"}}},
              {"user_id":"u-3","last_message":{"body":"hi","created_at":"2026-11-02T08:00:00.000Z","outgoing":true}},
              {"user_id":"u-4","last_message":{"body":"yo","outgoing":true,"call":null}}
            ]}
        """.trimIndent()
        val team = json.decodeFromString(ColleaguesResponse.serializer(), body).colleagues

        assertEquals(TeamCallOutcome.MISSED, team[0].lastMessage?.call?.outcome)
        assertNull(team[1].lastMessage?.call)
        assertNull(team[2].lastMessage?.call)
    }

    // MARK: - Titles, colour, length

    /** The contract's table, both sides, both channels. */
    @Test
    fun `each side sees its own title`() {
        val audio = CallChannel.AUDIO
        val video = CallChannel.VIDEO
        val table = listOf(
            Triple(TeamCallOutcome.COMPLETED, audio, TeamCallLogTitle.VOICE to TeamCallLogTitle.VOICE),
            Triple(TeamCallOutcome.COMPLETED, video, TeamCallLogTitle.VIDEO to TeamCallLogTitle.VIDEO),
            Triple(TeamCallOutcome.MISSED, audio, TeamCallLogTitle.NO_ANSWER to TeamCallLogTitle.MISSED_VOICE),
            Triple(TeamCallOutcome.MISSED, video, TeamCallLogTitle.NO_ANSWER to TeamCallLogTitle.MISSED_VIDEO),
            Triple(TeamCallOutcome.CANCELLED, audio, TeamCallLogTitle.CANCELLED to TeamCallLogTitle.MISSED_VOICE),
            Triple(TeamCallOutcome.CANCELLED, video, TeamCallLogTitle.CANCELLED to TeamCallLogTitle.MISSED_VIDEO),
            Triple(TeamCallOutcome.DECLINED, audio, TeamCallLogTitle.DECLINED to TeamCallLogTitle.DECLINED),
            Triple(TeamCallOutcome.DECLINED, video, TeamCallLogTitle.DECLINED to TeamCallLogTitle.DECLINED),
            Triple(TeamCallOutcome.FAILED, audio, TeamCallLogTitle.FAILED to TeamCallLogTitle.FAILED),
            Triple(TeamCallOutcome.FAILED, video, TeamCallLogTitle.FAILED to TeamCallLogTitle.FAILED),
        )
        table.forEach { (outcome, channel, titles) ->
            val line = call(outcome, channel)
            assertEquals("$outcome $channel, caller", titles.first, line.logTitle(viewerIsCaller = true))
            assertEquals("$outcome $channel, callee", titles.second, line.logTitle(viewerIsCaller = false))
        }
    }

    @Test
    fun `the titles are the shared strings`() {
        Language.entries.forEach { l ->
            assertEquals(Str.teamCallLogVoice(l), TeamCallLogTitle.VOICE.text(l))
            assertEquals(Str.teamCallLogVideo(l), TeamCallLogTitle.VIDEO.text(l))
            assertEquals(Str.teamCallLogMissedVoice(l), TeamCallLogTitle.MISSED_VOICE.text(l))
            assertEquals(Str.teamCallLogMissedVideo(l), TeamCallLogTitle.MISSED_VIDEO.text(l))
            assertEquals(Str.teamCallLogNoAnswer(l), TeamCallLogTitle.NO_ANSWER.text(l))
            assertEquals(Str.teamCallLogDeclined(l), TeamCallLogTitle.DECLINED.text(l))
            assertEquals(Str.teamCallLogCancelled(l), TeamCallLogTitle.CANCELLED.text(l))
            assertEquals(Str.teamCallLogFailed(l), TeamCallLogTitle.FAILED.text(l))
        }
        assertEquals("No answer", TeamCallLogTitle.NO_ANSWER.text(Language.EN))
        assertEquals("تماس صوتی بی‌پاسخ", TeamCallLogTitle.MISSED_VOICE.text(Language.FA))
        assertEquals("Görüntülü arama", TeamCallLogTitle.VIDEO.text(Language.TR))
    }

    /** Missed for both; cancelled only for the one who was rung. */
    @Test
    fun `missed is the danger colour, and cancelled only for the callee`() {
        assertTrue(call(TeamCallOutcome.MISSED).isMissedFor(viewerIsCaller = true))
        assertTrue(call(TeamCallOutcome.MISSED).isMissedFor(viewerIsCaller = false))
        assertFalse(call(TeamCallOutcome.CANCELLED).isMissedFor(viewerIsCaller = true))
        assertTrue(call(TeamCallOutcome.CANCELLED).isMissedFor(viewerIsCaller = false))
        listOf(TeamCallOutcome.COMPLETED, TeamCallOutcome.DECLINED, TeamCallOutcome.FAILED).forEach {
            assertFalse(call(it).isMissedFor(viewerIsCaller = true))
            assertFalse(call(it).isMissedFor(viewerIsCaller = false))
        }
    }

    /** `m:ss`, `h:mm:ss` from an hour on: the server's body and the web's shape. */
    @Test
    fun `the length reads m colon ss, and h colon mm colon ss from an hour`() {
        assertEquals("0:00", teamCallLogDuration(0, Language.EN))
        assertEquals("0:05", teamCallLogDuration(5, Language.EN))
        assertEquals("1:05", teamCallLogDuration(65, Language.EN))
        assertEquals("12:34", teamCallLogDuration(754, Language.EN))
        assertEquals("59:59", teamCallLogDuration(3599, Language.EN))
        assertEquals("1:00:00", teamCallLogDuration(3600, Language.EN))
        assertEquals("1:02:05", teamCallLogDuration(3725, Language.EN))
        assertEquals("0:00", teamCallLogDuration(-4, Language.EN))
        // The reader's digits, the shape unchanged.
        assertEquals("۱۲:۳۴", teamCallLogDuration(754, Language.FA))
        assertEquals("۱:۰۲:۰۵", teamCallLogDuration(3725, Language.FA))
        assertEquals("12:34", teamCallLogDuration(754, Language.TR))
    }

    @Test
    fun `only a completed call shows a length`() {
        assertEquals("2:05", call(TeamCallOutcome.COMPLETED, duration = 125).logDuration(Language.EN))
        assertNull("a completed call the server could not time", call(TeamCallOutcome.COMPLETED).logDuration(Language.EN))
        TeamCallOutcome.entries.filter { it != TeamCallOutcome.COMPLETED }.forEach {
            assertNull(it.name, call(it, duration = 125).logDuration(Language.EN))
        }
    }

    /** The colleagues list's line: the title, and a completed call's length after it. */
    @Test
    fun `the headline adds a completed call's length to its title`() {
        assertEquals("Voice call · 4:05", call(TeamCallOutcome.COMPLETED, duration = 245).logHeadline(true, Language.EN))
        assertEquals("Video call", call(TeamCallOutcome.COMPLETED, CallChannel.VIDEO).logHeadline(false, Language.EN))
        assertEquals("Missed video call", call(TeamCallOutcome.MISSED, CallChannel.VIDEO, duration = 9).logHeadline(false, Language.EN))
        assertEquals("No answer", call(TeamCallOutcome.MISSED).logHeadline(true, Language.EN))
        assertEquals("${Str.teamCallLogVoice(Language.FA)} · ۴:۰۵", call(TeamCallOutcome.COMPLETED, duration = 245).logHeadline(true, Language.FA))
    }

    /** The iPhone's and the web's order: title, length, direction, time. */
    @Test
    fun `the screen reader hears the title, the direction and the time`() {
        val at = Instant.parse("2026-11-02T08:10:00Z")
        val time = Format.bubbleTime(at, Language.EN)
        assertEquals(
            "Missed voice call, ${Str.teamCallLogIncoming(Language.EN)}, $time",
            teamCallLogLabel(call(TeamCallOutcome.MISSED, callerId = PEER), viewerIsCaller = false, time = at, language = Language.EN),
        )
        assertEquals(
            "Video call, 12:34, ${Str.teamCallLogOutgoing(Language.EN)}, $time",
            teamCallLogLabel(call(TeamCallOutcome.COMPLETED, CallChannel.VIDEO, duration = 754), viewerIsCaller = true, time = at, language = Language.EN),
        )
        assertEquals(
            "Declined, ${Str.teamCallLogOutgoing(Language.EN)}",
            teamCallLogLabel(call(TeamCallOutcome.DECLINED), viewerIsCaller = true, time = null, language = Language.EN),
        )
        // Persian's own comma.
        assertTrue(
            teamCallLogLabel(call(TeamCallOutcome.DECLINED), viewerIsCaller = true, time = at, language = Language.FA)
                .startsWith(Str.teamCallLogDeclined(Language.FA) + "، " + Str.teamCallLogOutgoing(Language.FA)),
        )
    }

    // MARK: - The list's preview

    @Test
    fun `the list previews a call by its title, never its body`() = runTest {
        val daniel = SampleApi().colleagues("ws-1").colleagues.first { it.userId == "u-4" }
        assertNotNull(daniel.lastMessage?.call)
        assertEquals(Str.teamCallLogMissedVoice(Language.FA), daniel.preview(Language.FA))

        // The same missed call, placed by this member: "No answer".
        val mine = daniel.copy(lastMessage = daniel.lastMessage?.copy(outgoing = true, call = call(TeamCallOutcome.MISSED)))
        assertEquals(Str.teamCallLogNoAnswer(Language.EN), mine.preview(Language.EN))
    }

    @Test
    fun `the list draws the call's title in the row`() = runTest {
        val team = SampleApi().colleagues("ws-1").colleagues
        compose.setContent { ColleaguesScreen(ColleaguesState.Loaded(team), Language.FA, {}) }

        compose.onNodeWithTag(A11y.colleagueRow("u-4")).assertIsDisplayed()
        compose.onNodeWithText(Str.teamCallLogMissedVoice(Language.FA)).assertIsDisplayed()
        compose.onNodeWithText("📞", substring = true).assertDoesNotExist()
    }

    // MARK: - The bubble

    private fun thread(lines: List<TeamMessage>, channels: Set<CallChannel>, onCallBack: (CallChannel) -> Unit = {}) {
        compose.setContent {
            TeamThreadScreen(
                TeamThreadState.Loaded(lines),
                me = ME,
                language = Language.EN,
                callBackChannels = channels,
                onCallBack = onCallBack,
            )
        }
    }

    private val missedFromPeer = TeamMessage(
        id = "tm-call", senderId = PEER, recipientId = ME, body = "📞",
        createdAt = Instant.parse("2026-11-02T08:10:00Z"),
        call = TeamChatCall("c-1", CallChannel.AUDIO, TeamCallOutcome.MISSED, null, PEER),
    )

    @Test
    fun `a call's line is drawn as a call, labelled for the screen reader, and calls back`() {
        val called = mutableListOf<CallChannel>()
        thread(listOf(missedFromPeer), channels = setOf(CallChannel.AUDIO, CallChannel.VIDEO)) { called += it }

        val label = teamCallLogLabel(missedFromPeer.call!!, viewerIsCaller = false, time = missedFromPeer.createdAt, language = Language.EN)
        val line = compose.onNodeWithContentDescription(label)
        line.assertIsDisplayed()
        line.assertHasClickAction()
        assertEquals(
            Str.teamCallLogCallBack(Language.EN),
            line.fetchSemanticsNode().config[SemanticsActions.OnClick].label,
        )
        // The row is still the thread's own message row.
        compose.onNodeWithTag(A11y.messageRow("tm-call")).assertIsDisplayed()
        // Never its body, the fallback for builds that predate it.
        compose.onNodeWithText("📞", substring = true).assertDoesNotExist()

        line.performClick()
        compose.waitForIdle()
        assertEquals(listOf(CallChannel.AUDIO), called)
    }

    /** Not in the plan (the thread's own call buttons are not there either): a tap does nothing. */
    @Test
    fun `without the call in the plan, the line is not a button`() {
        val called = mutableListOf<CallChannel>()
        // Video allowed, voice not: this voice call's line calls nobody back.
        thread(listOf(missedFromPeer), channels = setOf(CallChannel.VIDEO)) { called += it }

        val label = teamCallLogLabel(missedFromPeer.call!!, viewerIsCaller = false, time = missedFromPeer.createdAt, language = Language.EN)
        val line = compose.onNodeWithContentDescription(label)
        line.assertIsDisplayed()
        line.assertHasNoClickAction()
        line.performClick()
        compose.waitForIdle()
        assertTrue(called.isEmpty())
    }

    /** The time is inside the bubble, beside the arrow: it is not drawn again under it. */
    @Test
    fun `a call's line carries its own time, once`() {
        val placed = TeamMessage(
            id = "tm-video", senderId = ME, recipientId = PEER, body = "📹 12:34",
            createdAt = Instant.parse("2026-11-02T09:00:00Z"),
            call = TeamChatCall("c-9", CallChannel.VIDEO, TeamCallOutcome.COMPLETED, 754, ME),
        )
        thread(listOf(placed), channels = emptySet())

        val label = teamCallLogLabel(placed.call!!, viewerIsCaller = true, time = placed.createdAt, language = Language.EN)
        compose.onNodeWithContentDescription(label).assertIsDisplayed()
        assertTrue(label.contains("12:34"))
        assertTrue(label.contains(Str.teamCallLogOutgoing(Language.EN)))
        // The bubble's own time under it would be a second Text with the clock.
        val time = Format.bubbleTime(placed.createdAt, Language.EN)
        compose.onNodeWithText(time, useUnmergedTree = true).assertDoesNotExist()
        assertEquals(
            label,
            compose.onNodeWithTag(teamCallLineTag("tm-video"), useUnmergedTree = true)
                .fetchSemanticsNode().config[SemanticsProperties.ContentDescription].single(),
        )
    }

    /**
     * A call's line stands on its own, as on the iPhone: the run before it
     * ends there, so the words just before it keep their time underneath
     * (the line's own time is inside it).
     */
    @Test
    fun `the message before a call's line keeps its time`() {
        val said = TeamMessage(
            id = "tm-said", senderId = ME, recipientId = PEER, body = "Calling you now",
            createdAt = Instant.parse("2026-11-02T08:58:00Z"),
        )
        val placed = TeamMessage(
            id = "tm-placed", senderId = ME, recipientId = PEER, body = "📞",
            createdAt = Instant.parse("2026-11-02T09:00:00Z"),
            call = TeamChatCall("c-10", CallChannel.AUDIO, TeamCallOutcome.MISSED, null, ME),
        )
        thread(listOf(said, placed), channels = emptySet())

        compose.onNodeWithText(Format.bubbleTime(said.createdAt, Language.EN), useUnmergedTree = true).assertExists()
    }

    @Test
    fun `a thread mixing messages and calls draws them all`() = runTest {
        val response = SampleApi().teamThread("ws-1", "u-4")
        assertTrue(response.messages.any { it.call != null })
        assertTrue(response.messages.any { it.call == null })
        compose.setContent {
            TeamThreadScreen(TeamThreadState.Loaded(response.messages), me = response.me, language = Language.FA)
        }
        response.messages.forEach { compose.onNodeWithTag(A11y.messageRow(it.id)).assertIsDisplayed() }
    }

    /** A sample call that ends leaves its line, once, as the server writes it. */
    @Test
    fun `an ended sample call leaves one line in the thread`() = runTest {
        val api = SampleApi()
        val before = api.teamThread("ws-1", "u-2").messages.size
        val placed = api.createTeamCall("ws-1", "u-2", CallChannel.VIDEO)
        api.hangUpTeamCall(placed.id)
        api.hangUpTeamCall(placed.id)

        val lines = api.teamThread("ws-1", "u-2").messages
        assertEquals(before + 1, lines.size)
        val line = lines.single { it.call != null }
        assertEquals(TeamChatCall(placed.id, CallChannel.VIDEO, TeamCallOutcome.CANCELLED, null, api.teamThread("ws-1", "u-2").me!!), line.call)
        assertNull("a cancelled call is unread for the callee", line.readAt)
    }

    private companion object {
        const val ME = "u-1"
        const val PEER = "u-4"
    }
}
