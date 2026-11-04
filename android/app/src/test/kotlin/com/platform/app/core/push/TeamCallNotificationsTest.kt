package com.platform.app.core.push

import android.Manifest
import android.app.Application
import android.app.Notification
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationCompat
import androidx.test.core.app.ApplicationProvider
import com.platform.app.core.model.CallChannel
import com.platform.app.i18n.Language
import com.platform.app.i18n.Str
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

/** A colleague's ring on this phone, and the missed call it leaves when nobody answered. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class TeamCallNotificationsTest {

    private val context: Context = ApplicationProvider.getApplicationContext()
    private val manager = context.getSystemService(NotificationManager::class.java)
    private val now = 1_000_000L

    private fun ring(id: String = "team-1", name: String = "Daniel Carter", channel: CallChannel = CallChannel.AUDIO) = TeamCallRing(
        callId = id,
        workspaceId = "ws-1",
        workspaceName = "Webyar",
        channel = channel,
        callerName = name,
        callerAvatarUrl = null,
        callerUserId = "u-2",
        expiresAt = now / 1000 + 45,
    )

    @Before
    fun grant() {
        shadowOf(context as Application).grantPermissions(Manifest.permission.POST_NOTIFICATIONS)
        CallNotifications.forget("team-1")
    }

    @Test
    fun `a colleague's ring is an ongoing call notification with their face`() {
        CallNotifications.showTeamIncoming(context, ring(), Language.EN, photo = null, nowMillis = now)

        val posted = shadowOf(manager).allNotifications.single()
        assertEquals(CallNotifications.CHANNEL_CALLS, posted.channelId)
        assertEquals(Notification.CATEGORY_CALL, posted.category)
        assertTrue(posted.flags and Notification.FLAG_ONGOING_EVENT != 0)
        assertEquals("Daniel Carter", posted.extras.getCharSequence(Notification.EXTRA_TITLE)?.toString())
        assertEquals(Str.teamCallIncomingVoice(Language.EN), posted.extras.getCharSequence(Notification.EXTRA_TEXT)?.toString())
        // Never left to the system, which would draw the person as a letter.
        assertNotNull(NotificationCompat.getPeople(posted).single().icon)
    }

    @Test
    fun `a colleague who set no name rings as a colleague`() {
        CallNotifications.showTeamIncoming(context, ring(name = ""), Language.FA, photo = null, nowMillis = now)
        val posted = shadowOf(manager).allNotifications.single()
        assertEquals(ring(name = "").displayName(Language.FA), posted.extras.getCharSequence(Notification.EXTRA_TITLE)?.toString())
    }

    @Test
    fun `answered here or elsewhere, the ring just stops`() {
        CallNotifications.showTeamIncoming(context, ring(), Language.EN, photo = null, nowMillis = now)
        CallNotifications.stopTeam(context, "team-1", missed = false, language = Language.EN)
        assertTrue(shadowOf(manager).allNotifications.isEmpty())
    }

    /**
     * Missed: "Missed video call" with their name, opening their thread, and
     * under the server's own key for the same call (`team_call:<id>`, id 0)
     * so the push's missed call and this one are a single notification.
     */
    @Test
    fun `a colleague nobody answered leaves a missed call that opens their thread`() {
        CallNotifications.showTeamIncoming(context, ring(channel = CallChannel.VIDEO), Language.EN, photo = null, nowMillis = now)
        CallNotifications.stopTeam(context, "team-1", missed = true, language = Language.EN)

        val missed = manager.activeNotifications.single()
        assertEquals("team_call:team-1", missed.tag)
        assertEquals(0, missed.id)
        val notification = missed.notification
        assertEquals(Str.teamCallMissedVideo(Language.EN), notification.extras.getCharSequence(Notification.EXTRA_TITLE)?.toString())
        assertEquals("Daniel Carter", notification.extras.getCharSequence(Notification.EXTRA_TEXT)?.toString())
        assertEquals(Notification.CATEGORY_MISSED_CALL, notification.category)
        assertEquals(Notifications.CHANNEL_MESSAGES, notification.channelId)

        val tap: Intent = shadowOf(notification.contentIntent).savedIntent
        val link = PushPayload.from(tap)
        assertNotNull(link)
        assertTrue(link!!.opensTeamThread)
        assertEquals("u-2", link.peerId)
        assertEquals("ws-1", link.workspaceId)
    }

    @Test
    fun `a colleague's call declined or answered here was not missed`() {
        CallNotifications.showTeamIncoming(context, ring(), Language.EN, photo = null, nowMillis = now)
        CallNotifications.stopTeam(context, "team-1", missed = false, language = Language.EN)
        CallNotifications.forget("team-1")
        CallNotifications.stopTeam(context, "team-1", missed = true, language = Language.EN)
        assertTrue(shadowOf(manager).allNotifications.isEmpty())
    }

    @Test
    fun `a colleague's Answer tap comes back as their call`() {
        val intent = Intent(CallNotifications.ACTION_ANSWER).apply {
            putExtra(CallNotifications.EXTRA_CALL, "team-1")
            putExtra(CallNotifications.EXTRA_WORKSPACE, "ws-1")
            putExtra(CallNotifications.EXTRA_CHANNEL, "video")
            putExtra(CallNotifications.EXTRA_CALLER, "Daniel Carter")
            putExtra(CallNotifications.EXTRA_COLLEAGUE, "u-2")
            putExtra(CallNotifications.EXTRA_AVATAR, "https://cdn.example.org/u-2.jpg")
        }
        val link = IncomingCallLink.from(intent)
        assertEquals(
            IncomingCallLink(
                callId = "team-1",
                workspaceId = "ws-1",
                channel = CallChannel.VIDEO,
                caller = "Daniel Carter",
                answer = true,
                colleagueId = "u-2",
                callerAvatarUrl = "https://cdn.example.org/u-2.jpg",
            ),
            link,
        )
        assertTrue(link!!.isColleague)
    }

    /** A colleague's ring is asked for as one: what MainActivity checks before it answers. */
    @Test
    fun `a colleague's ring is ringing as a colleague's`() {
        CallNotifications.showTeamIncoming(context, ring(), Language.EN, photo = null, nowMillis = now)
        assertTrue(CallNotifications.isRinging(context, "team-1", colleague = true))
        assertFalse(CallNotifications.isRinging(context, "team-1"))
        CallNotifications.stopTeam(context, "team-1", missed = false, language = Language.EN)
        assertFalse(CallNotifications.isRinging(context, "team-1", colleague = true))
    }
}
