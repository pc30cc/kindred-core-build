package com.webyar.ai.core.push

import android.Manifest
import android.app.Application
import android.app.Notification
import android.app.NotificationManager
import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.webyar.ai.core.model.CallChannel
import com.webyar.ai.i18n.Language
import com.webyar.ai.i18n.StrAndroid
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

/** A ringing call on this phone, and what it leaves behind when it stops. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class CallNotificationsTest {

    private val context: Context = ApplicationProvider.getApplicationContext()
    private val manager = context.getSystemService(NotificationManager::class.java)
    private val now = 1_000_000L

    private fun call(id: String = "call-1") = IncomingCall(
        callId = id,
        workspaceId = "ws-1",
        channel = CallChannel.AUDIO,
        caller = "Sara",
        workspaceName = "Webyar",
        expiresAt = now / 1000 + 45,
    )

    @Before
    fun grant() {
        shadowOf(context as Application).grantPermissions(Manifest.permission.POST_NOTIFICATIONS)
        // What rang in one test is not a missed call in the next.
        CallNotifications.forget("call-1")
    }

    @Test
    fun `a ring is one ongoing call notification on the calls channel`() {
        CallNotifications.showIncoming(context, call(), Language.FA, nowMillis = now)

        val posted = shadowOf(manager).allNotifications.single()
        assertEquals(CallNotifications.CHANNEL_CALLS, posted.channelId)
        assertEquals(Notification.CATEGORY_CALL, posted.category)
        assertTrue(posted.flags and Notification.FLAG_ONGOING_EVENT != 0)
        assertEquals("Sara", posted.extras.getCharSequence(Notification.EXTRA_TITLE)?.toString())
        assertTrue(CallNotifications.isRinging(context, "call-1"))
    }

    /** The name the inbox list gives an anonymous visitor: "Visitor" and their code. */
    @Test
    fun `an anonymous caller is named as the inbox list names them`() {
        CallNotifications.showIncoming(context, call().copy(caller = "", callerCode = "4ZTK"), Language.FA, nowMillis = now)
        val posted = shadowOf(manager).allNotifications.single()
        assertEquals("بازدیدکننده 4ZTK", posted.extras.getCharSequence(Notification.EXTRA_TITLE)?.toString())
    }

    @Test
    fun `the calls channel rings in the operator's language`() {
        CallNotifications.ensureChannel(context, Language.FA)
        assertEquals(StrAndroid.channelCalls(Language.FA), manager.getNotificationChannel(CallNotifications.CHANNEL_CALLS).name.toString())
    }

    @Test
    fun `a ring already past its expiry is not shown`() {
        CallNotifications.showIncoming(context, call(), Language.FA, nowMillis = now + 60_000)
        assertTrue(shadowOf(manager).allNotifications.isEmpty())
    }

    @Test
    fun `answered elsewhere, the ring just stops`() {
        CallNotifications.showIncoming(context, call(), Language.FA, nowMillis = now)
        CallNotifications.stop(context, "call-1", missed = false, language = Language.FA)
        assertTrue(shadowOf(manager).allNotifications.isEmpty())
    }

    @Test
    fun `a caller nobody answered leaves a missed call, named`() {
        CallNotifications.showIncoming(context, call(), Language.FA, nowMillis = now)
        CallNotifications.stop(context, "call-1", missed = true, language = Language.FA)

        val missed = shadowOf(manager).allNotifications.single()
        assertEquals(StrAndroid.missedCall(Language.FA), missed.extras.getCharSequence(Notification.EXTRA_TITLE)?.toString())
        assertEquals("Sara", missed.extras.getCharSequence(Notification.EXTRA_TEXT)?.toString())
        assertEquals(Notifications.CHANNEL_MESSAGES, missed.channelId)
    }

    @Test
    fun `a call declined or answered here was not missed`() {
        CallNotifications.showIncoming(context, call(), Language.FA, nowMillis = now)
        CallNotifications.stop(context, "call-1", missed = false, language = Language.FA)
        CallNotifications.forget("call-1")
        CallNotifications.stop(context, "call-1", missed = true, language = Language.FA)
        assertTrue(shadowOf(manager).allNotifications.isEmpty())
    }

    @Test
    fun `a call that never rang here is nobody's missed call`() {
        CallNotifications.stop(context, "call-unknown", missed = true, language = Language.FA)
        assertTrue(shadowOf(manager).allNotifications.isEmpty())
        assertNull(shadowOf(manager).allNotifications.firstOrNull())
    }

    @Test
    fun `an Answer tap comes back as the call to answer`() {
        val intent = android.content.Intent(CallNotifications.ACTION_ANSWER).apply {
            putExtra(CallNotifications.EXTRA_CALL, "call-1")
            putExtra(CallNotifications.EXTRA_WORKSPACE, "ws-1")
            putExtra(CallNotifications.EXTRA_CHANNEL, "video")
            putExtra(CallNotifications.EXTRA_CALLER, "Sara")
        }
        assertEquals(
            IncomingCallLink("call-1", "ws-1", CallChannel.VIDEO, "Sara", answer = true),
            IncomingCallLink.from(intent),
        )
        assertNull(IncomingCallLink.from(android.content.Intent("other")))
    }
}
