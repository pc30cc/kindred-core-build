package com.webyar.operator.core.push

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
import com.webyar.operator.MainActivity
import com.webyar.operator.R
import com.webyar.operator.i18n.Language
import com.webyar.operator.i18n.StrAndroid

/** From a notification tap: ours, or one FCM drew in the background. */
fun PushPayload.Companion.from(intent: Intent?): PushPayload? {
    val extras = intent?.extras ?: return null
    val payload = PushPayload(
        type = extras.getString(KEY_TYPE),
        workspaceId = extras.getString(KEY_WORKSPACE)?.takeIf { isId(it) },
        conversationId = extras.getString(KEY_CONVERSATION)?.takeIf { isId(it) },
        messageId = extras.getString(KEY_MESSAGE)?.takeIf { isId(it) },
    )
    return payload.takeIf { it.opensConversation }
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
     * conversation: a second message replaces the first, as the server's
     * `collapse_key` does for the ones it has not delivered yet.
     */
    @SuppressLint("MissingPermission") // canPost() is the check, and it runs first.
    fun showMessage(context: Context, payload: PushPayload, title: String?, body: String?, language: Language) {
        if (!canPost(context)) return
        val conversationId = payload.conversationId ?: return
        val tap = PendingIntent.getActivity(
            context,
            conversationId.hashCode(),
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
        NotificationManagerCompat.from(context).notify(TAG, conversationId.hashCode(), notification)
    }

    /** The operator opened the conversation: its notification has done its job. */
    fun cancelConversation(context: Context, conversationId: String) {
        runCatching { NotificationManagerCompat.from(context).cancel(TAG, conversationId.hashCode()) }
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
        }

    private const val TAG = "conversation"
}
