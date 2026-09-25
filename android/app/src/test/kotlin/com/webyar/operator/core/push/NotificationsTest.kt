package com.webyar.operator.core.push

import android.Manifest
import android.app.Application
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import androidx.test.core.app.ApplicationProvider
import com.webyar.operator.i18n.Language
import com.webyar.operator.i18n.StrAndroid
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

/** The notification a foreground push posts, and the tap that comes back from it. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class NotificationsTest {

    private val context: Context = ApplicationProvider.getApplicationContext()
    private val manager = context.getSystemService(NotificationManager::class.java)
    private val payload = PushPayload(type = "new_message", workspaceId = "ws-1", conversationId = "c-1", messageId = "m-1")

    @Test
    fun `the channel is the one the server names, in the operator's language`() {
        Notifications.ensureChannels(context, Language.FA)
        val channel = manager.getNotificationChannel(Notifications.CHANNEL_MESSAGES)
        assertEquals(StrAndroid.channelMessages(Language.FA), channel.name.toString())

        Notifications.ensureChannels(context, Language.TR)
        assertEquals(StrAndroid.channelMessages(Language.TR), manager.getNotificationChannel(Notifications.CHANNEL_MESSAGES).name.toString())
    }

    @Test
    fun `a push with permission posts one notification per conversation`() {
        shadowOf(context as Application).grantPermissions(Manifest.permission.POST_NOTIFICATIONS)
        Notifications.ensureChannels(context, Language.EN)

        Notifications.showMessage(context, payload, "Maryam", "Hello", Language.EN)
        Notifications.showMessage(context, payload, "Maryam", "Are you there?", Language.EN)

        assertEquals(1, shadowOf(manager).allNotifications.size)
    }

    @Test
    fun `without permission nothing is posted`() {
        shadowOf(context as Application).denyPermissions(Manifest.permission.POST_NOTIFICATIONS)
        Notifications.showMessage(context, payload, "Maryam", "Hello", Language.EN)
        assertTrue(shadowOf(manager).allNotifications.isEmpty())
    }

    @Test
    fun `sign-out clears every notification`() {
        shadowOf(context as Application).grantPermissions(Manifest.permission.POST_NOTIFICATIONS)
        Notifications.showMessage(context, payload, "Maryam", "Hello", Language.EN)
        Notifications.cancelAll(context)
        assertTrue(shadowOf(manager).allNotifications.isEmpty())
    }

    @Test
    fun `a tap brings back the conversation it was about`() {
        val intent = Notifications.openIntent(context, payload)
        assertEquals(payload, PushPayload.from(intent))
    }

    @Test
    fun `a tap on a notification the system drew carries the same keys`() {
        // FCM puts the message's data into the launch intent's extras.
        val intent = Intent().apply {
            putExtra("type", "new_message")
            putExtra("workspaceId", "ws-1")
            putExtra("conversationId", "c-1")
        }
        assertEquals("c-1", PushPayload.from(intent)?.conversationId)
        assertNull(PushPayload.from(Intent()))
    }
}
