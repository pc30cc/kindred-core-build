package com.webyar.ai.core.push

import android.Manifest
import android.annotation.SuppressLint
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import com.webyar.ai.MainActivity
import com.webyar.ai.R
import com.webyar.ai.i18n.Language
import com.webyar.ai.i18n.StrAndroid

/** From a notification tap: ours, or one FCM drew in the background. */
fun PushPayload.Companion.from(intent: Intent?): PushPayload? {
    val extras = intent?.extras ?: return null
    val payload = PushPayload(
        type = extras.getString(KEY_TYPE),
        workspaceId = extras.getString(KEY_WORKSPACE)?.takeIf { isId(it) },
        conversationId = extras.getString(KEY_CONVERSATION)?.takeIf { isId(it) },
        messageId = extras.getString(KEY_MESSAGE)?.takeIf { isId(it) },
        peerId = extras.getString(KEY_PEER)?.takeIf { isId(it) },
        threadId = extras.getString(KEY_THREAD)?.takeIf { isId(it) },
        callbackId = extras.getString(KEY_CALLBACK)?.takeIf { isId(it) },
    )
    return payload.takeIf { it.opensSomething }
}

/**
 * The app's notifications: one channel, and the messages it carries.
 *
 * One channel, `webyar_messages` — the id the server names in every FCM
 * message it sends (`android.notification.channel_id`), so the system files
 * a background notification under the same channel the app's own settings
 * describe. No second channel for calls: this platform receives no call
 * pushes (the server rings calls over APNs VoIP only), and a channel with
 * nothing in it is one more switch that does nothing.
 */
object Notifications {
    const val CHANNEL_MESSAGES = "webyar_messages"

    /**
     * Creates the channel, or renames it into the operator's language. The
     * system shows channel names in its own settings, so they follow the
     * language the operator chose in the app, not the phone's.
     */
    fun ensureChannels(context: Context, language: Language, rename: Boolean = true) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = ContextCompat.getSystemService(context, NotificationManager::class.java) ?: return
        // At launch, before the chosen language is known, only make sure the
        // channel exists; renaming it to English for a moment would be wrong.
        if (!rename && manager.getNotificationChannel(CHANNEL_MESSAGES) != null) return
        val channel = NotificationChannel(
            CHANNEL_MESSAGES,
            StrAndroid.channelMessages(language),
            NotificationManager.IMPORTANCE_HIGH,
        ).apply {
            description = StrAndroid.channelMessagesDescription(language)
        }
        runCatching { manager.createNotificationChannel(channel) }
    }

    /** Whether a notification posted now would be shown at all. */
    fun canPost(context: Context): Boolean {
        if (!NotificationManagerCompat.from(context).areNotificationsEnabled()) return false
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            return ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) ==
                PackageManager.PERMISSION_GRANTED
        }
        return true
    }

    /**
     * A message notification for a push that arrived with the app in front.
     *
     * The title and body are the server's — already in the operator's
     * language, already reduced to "New message" when the operator turned
     * previews off — and are shown as they came. One notification per
     * conversation, and one per colleague: a second message replaces the
     * first, as the server's `collapse_key` does for the ones it has not
     * delivered yet.
     *
     * Posted under the key itself with id [SYSTEM_ID] — exactly as Firebase
     * posts the ones it draws with the app closed, whose `tag` the server
     * sets to the same key (`androidNotificationTag` in
     * server/services/push/fcm.ts). So either kind replaces the other,
     * opening the conversation clears whichever is there, and the icon's
     * number, on launchers that show one, counts conversations with
     * something new — as the iOS badge does — rather than messages.
     */
    @SuppressLint("MissingPermission") // canPost() is the check, and it runs first.
    fun showMessage(context: Context, payload: PushPayload, title: String?, body: String?, language: Language) {
        if (!canPost(context)) return
        // A test send, which names nothing, has its own.
        val key = keyOf(payload) ?: TEST_KEY.takeIf { payload.isTest } ?: return
        val tap = PendingIntent.getActivity(
            context,
            key.hashCode(),
            openIntent(context, payload),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val notification = NotificationCompat.Builder(context, CHANNEL_MESSAGES)
            .setSmallIcon(R.drawable.ic_stat_message)
            .setContentTitle(title?.takeIf { it.isNotBlank() } ?: StrAndroid.newMessage(language))
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .setContentIntent(tap)
            .build()
        val manager = NotificationManagerCompat.from(context)
        // One posted by an earlier version, under the old tag and id.
        runCatching { manager.cancel(LEGACY_TAG, key.hashCode()) }
        manager.notify(key, SYSTEM_ID, notification)
    }

    /** The operator opened the conversation: its notification has done its job. */
    fun cancelConversation(context: Context, conversationId: String) = cancelKey(context, conversationId)

    /** The operator opened the thread with this colleague. */
    fun cancelTeamThread(context: Context, peerId: String) = cancelKey(context, teamKey(peerId))

    /** Whatever [payload]'s notification is about has been opened. */
    fun cancelFor(context: Context, payload: PushPayload) {
        keyOf(payload)?.let { key -> cancelKey(context, key) }
    }

    /** Whichever is there: the one this app drew, the one Firebase drew, or one from an earlier version. */
    private fun cancelKey(context: Context, key: String) {
        val manager = NotificationManagerCompat.from(context)
        runCatching { manager.cancel(key, SYSTEM_ID) }
        runCatching { manager.cancel(LEGACY_TAG, key.hashCode()) }
    }

    /** Sign-out: nothing one operator was told stays on screen for the next. */
    fun cancelAll(context: Context) {
        runCatching { NotificationManagerCompat.from(context).cancelAll() }
    }

    fun openIntent(context: Context, payload: PushPayload): Intent =
        Intent(context, MainActivity::class.java).apply {
            action = Intent.ACTION_VIEW
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
            payload.type?.let { putExtra(PushPayload.KEY_TYPE, it) }
            putExtra(PushPayload.KEY_WORKSPACE, payload.workspaceId)
            putExtra(PushPayload.KEY_CONVERSATION, payload.conversationId)
            payload.messageId?.let { putExtra(PushPayload.KEY_MESSAGE, it) }
            payload.peerId?.let { putExtra(PushPayload.KEY_PEER, it) }
            payload.threadId?.let { putExtra(PushPayload.KEY_THREAD, it) }
            payload.callbackId?.let { putExtra(PushPayload.KEY_CALLBACK, it) }
        }

    /** What one notification stands for: a conversation, or a colleague's thread. */
    private fun keyOf(payload: PushPayload): String? = when {
        payload.isTeamMessage -> payload.peerId?.let(::teamKey)
        payload.isEmail -> payload.threadId?.let { "email:$it" }
        payload.isCallback -> payload.callbackId?.let { "callback:$it" }
        else -> payload.conversationId
    }

    // A conversation's key is its id, as it has always been; a colleague's
    // is marked so that the two can never share a notification.
    private fun teamKey(peerId: String) = "team:$peerId"

    /**
     * The id Firebase gives every notification it draws; the tag tells them
     * apart. This app uses the same, so the two kinds are one.
     */
    private const val SYSTEM_ID = 0

    /** How notifications were keyed before 1.0.12: tag "conversation", id the key's hash. */
    private const val LEGACY_TAG = "conversation"
    private const val TEST_KEY = "push-test"
}
