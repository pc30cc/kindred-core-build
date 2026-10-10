package com.webyar.ai.core.push

import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.AudioManager
import android.media.RingtoneManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.Person
import androidx.core.content.ContextCompat
import com.webyar.ai.MainActivity
import com.webyar.ai.R
import com.webyar.ai.core.model.CallChannel
import com.webyar.ai.i18n.Language
import com.webyar.ai.i18n.Str
import com.webyar.ai.i18n.StrAndroid

/** From a ring's Answer, or from the ring itself. */
fun IncomingCallLink.Companion.from(intent: Intent?): IncomingCallLink? {
    intent ?: return null
    val answer = when (intent.action) {
        CallNotifications.ACTION_ANSWER -> true
        CallNotifications.ACTION_SHOW -> false
        else -> return null
    }
    val callId = intent.getStringExtra(CallNotifications.EXTRA_CALL)?.takeIf { PushPayload.isId(it) } ?: return null
    val workspaceId = intent.getStringExtra(CallNotifications.EXTRA_WORKSPACE)?.takeIf { PushPayload.isId(it) } ?: return null
    return IncomingCallLink(
        callId = callId,
        workspaceId = workspaceId,
        channel = CallChannel.from(intent.getStringExtra(CallNotifications.EXTRA_CHANNEL)),
        caller = intent.getStringExtra(CallNotifications.EXTRA_CALLER)?.take(120).orEmpty(),
        answer = answer,
    )
}

/**
 * A call-centre call ringing this phone, and what it leaves behind.
 *
 * Its own channel, `webyar_calls`, apart from messages: it rings with the
 * phone's ringtone rather than the notification sound, and an operator who
 * silences one of the two has not silenced the other. The notification is
 * the platform's incoming-call one — caller, Answer, Decline — and, where the
 * system allows it, full screen over the lock screen, the way a phone call
 * rings.
 *
 * It rings until it is answered, declined, or the server says stop; and it
 * stops by itself at the ring's expiry, because a ring whose cancel never
 * arrived must not go on for ever.
 */
object CallNotifications {
    const val CHANNEL_CALLS = "webyar_calls"

    /** Extras on the intents a ring hands back to the app. */
    const val ACTION_ANSWER = "com.webyar.ai.call.ANSWER"
    const val ACTION_SHOW = "com.webyar.ai.call.SHOW"
    const val ACTION_DECLINE = "com.webyar.ai.call.DECLINE"
    const val EXTRA_CALL = "callId"
    const val EXTRA_WORKSPACE = "workspaceId"
    const val EXTRA_CHANNEL = "channel"
    const val EXTRA_CALLER = "caller"
    const val EXTRA_EXPIRES = "expiresAt"

    fun ensureChannel(context: Context, language: Language, rename: Boolean = true) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = ContextCompat.getSystemService(context, NotificationManager::class.java) ?: return
        if (!rename && manager.getNotificationChannel(CHANNEL_CALLS) != null) return
        val channel = NotificationChannel(
            CHANNEL_CALLS,
            StrAndroid.channelCalls(language),
            NotificationManager.IMPORTANCE_HIGH,
        ).apply {
            description = StrAndroid.channelCallsDescription(language)
            setSound(
                RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE),
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                    .build(),
            )
            enableVibration(true)
            vibrationPattern = RING_VIBRATION
            lockscreenVisibility = Notification.VISIBILITY_PUBLIC
        }
        runCatching { manager.createNotificationChannel(channel) }
    }

    /** Rings: the caller, Answer and Decline, full screen where allowed. */
    @SuppressLint("MissingPermission") // Notifications.canPost() is the check, and it runs first.
    fun showIncoming(context: Context, call: IncomingCall, language: Language, nowMillis: Long = System.currentTimeMillis()) {
        if (!Notifications.canPost(context)) return
        val remaining = call.expiresAt * 1000 - nowMillis
        if (remaining <= 0) return
        ensureChannel(context, language, rename = false)

        // The name the inbox list gives them, anonymous visitors included.
        val name = call.displayName(language)
        val caller = Person.Builder().setName(name).setImportant(true).build()
        val video = call.channel == CallChannel.VIDEO
        val answer = activityIntent(context, call, ACTION_ANSWER, name)
        val show = activityIntent(context, call, ACTION_SHOW, name)
        val decline = PendingIntent.getBroadcast(
            context,
            requestCode(call.callId, ACTION_DECLINE),
            Intent(context, CallActionReceiver::class.java).apply {
                action = ACTION_DECLINE
                putExtra(EXTRA_CALL, call.callId)
                putExtra(EXTRA_WORKSPACE, call.workspaceId)
            },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        val builder = NotificationCompat.Builder(context, CHANNEL_CALLS)
            .setSmallIcon(R.drawable.ic_stat_call)
            .setColor(ContextCompat.getColor(context, R.color.brand_deep))
            .setContentTitle(name)
            .setContentText(StrAndroid.incomingCall(language, video))
            .setSubText(call.workspaceName)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setOngoing(true)
            .setAutoCancel(false)
            .setTimeoutAfter(remaining)
            .setContentIntent(show)
            .addPerson(caller)
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            // Android 7 has no channels, so the ringtone and the buzz that
            // `webyar_calls` gives every later version are the notification's
            // own to ask for. Without them a call rings in silence on exactly
            // the older phones this app is built to keep serving (minSdk 24).
            // Once, not insistently: see the flags below.
            builder
                .setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE), AudioManager.STREAM_RING)
                .setVibrate(RING_VIBRATION)
        }
        if (canUseFullScreen(context)) {
            builder
                .setFullScreenIntent(show, true)
                .setStyle(NotificationCompat.CallStyle.forIncomingCall(caller, decline, answer).setIsVideo(video))
        } else {
            // A call style needs a full-screen intent or a foreground service;
            // without either, the same two buttons as plain actions.
            builder
                .addAction(0, StrAndroid.declineCall(language), decline)
                .addAction(0, StrAndroid.answerCall(language), answer)
        }
        val notification = builder.build().apply {
            // Rings until something stops it, like a phone call; the expiry
            // above is what stops it if nothing else does. Not on Android 7,
            // which has no such expiry (`setTimeoutAfter` is Android 8): a
            // ring whose cancel never arrived would ring there for ever, so
            // it rings once.
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                flags = flags or Notification.FLAG_INSISTENT
            }
        }
        NotificationManagerCompat.from(context).notify(TAG, call.callId.hashCode(), notification)
        unanswered[call.callId] = name
    }

    /** Whether this call is still ringing here. */
    fun isRinging(context: Context, callId: String): Boolean = ringing(context, callId) != null

    /** Answered or declined on this phone: whatever happens to the call next, nobody missed it here. */
    fun forget(callId: String) {
        unanswered.remove(callId)
    }

    /**
     * Stops the ring. When the caller was [missed], a missed-call notification
     * takes its place — only for a call that rang here and was neither
     * answered nor declined here: one this phone dealt with was not missed.
     * That includes a ring that already ran out by itself, whose caller may
     * have gone on waiting in the queue long after the phone fell silent.
     */
    @SuppressLint("MissingPermission")
    fun stop(context: Context, callId: String, missed: Boolean, language: Language) {
        val active = ringing(context, callId)
        val remembered = unanswered.remove(callId)
        runCatching { NotificationManagerCompat.from(context).cancel(TAG, callId.hashCode()) }
        if (!missed || (active == null && remembered == null) || !Notifications.canPost(context)) return
        val name = active?.extras?.getCharSequence(Notification.EXTRA_TITLE)?.toString()
            ?: remembered
            ?: Str.unknownVisitor(language)
        val open = PendingIntent.getActivity(
            context,
            requestCode(callId, MISSED_TAG),
            Intent(context, MainActivity::class.java).apply {
                action = Intent.ACTION_MAIN
                addCategory(Intent.CATEGORY_LAUNCHER)
                flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
            },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val notification = NotificationCompat.Builder(context, Notifications.CHANNEL_MESSAGES)
            .setSmallIcon(R.drawable.ic_stat_call)
            .setColor(ContextCompat.getColor(context, R.color.brand_deep))
            .setContentTitle(StrAndroid.missedCall(language))
            .setContentText(name)
            .setCategory(NotificationCompat.CATEGORY_MISSED_CALL)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .setContentIntent(open)
            .build()
        NotificationManagerCompat.from(context).notify(MISSED_TAG, callId.hashCode(), notification)
    }

    private fun ringing(context: Context, callId: String): Notification? {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return null
        val manager = ContextCompat.getSystemService(context, NotificationManager::class.java) ?: return null
        return runCatching {
            manager.activeNotifications.firstOrNull { it.tag == TAG && it.id == callId.hashCode() }?.notification
        }.getOrNull()
    }

    private fun canUseFullScreen(context: Context): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.UPSIDE_DOWN_CAKE) return true
        val manager = ContextCompat.getSystemService(context, NotificationManager::class.java) ?: return false
        return runCatching { manager.canUseFullScreenIntent() }.getOrDefault(false)
    }

    private fun activityIntent(context: Context, call: IncomingCall, action: String, caller: String): PendingIntent =
        PendingIntent.getActivity(
            context,
            requestCode(call.callId, action),
            Intent(context, MainActivity::class.java).apply {
                this.action = action
                flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
                putExtra(EXTRA_CALL, call.callId)
                putExtra(EXTRA_WORKSPACE, call.workspaceId)
                putExtra(EXTRA_CHANNEL, call.channel.wire)
                putExtra(EXTRA_CALLER, caller)
                putExtra(EXTRA_EXPIRES, call.expiresAt)
            },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

    // One request code per (call, action): PendingIntents that differ only
    // in extras are the same PendingIntent, and Answer would open Decline's.
    private fun requestCode(callId: String, action: String) = (callId + action).hashCode()

    /**
     * Calls that rang here and were not dealt with here, and who was calling.
     * In memory only: a caller's name is not written to disk for this, and a
     * process that died in between leaves a missed call named by the
     * notification still on screen, or not named at all.
     */
    private val unanswered = java.util.concurrent.ConcurrentHashMap<String, String>()

    private const val TAG = "call"
    private const val MISSED_TAG = "missed-call"

    /** A phone's ring: the channel's from Android 8, the notification's own before. */
    private val RING_VIBRATION = longArrayOf(0, 800, 600, 800, 600)
}
