package com.platform.app.core.push

import com.platform.app.core.AppBrand
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
import android.graphics.Bitmap
import android.os.Build
import android.os.Bundle
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.Person
import androidx.core.graphics.drawable.IconCompat
import androidx.core.content.ContextCompat
import com.platform.app.MainActivity
import com.platform.app.R
import com.platform.app.core.model.CallChannel
import com.platform.app.i18n.Language
import com.platform.app.i18n.Str
import com.platform.app.i18n.StrAndroid

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
        expiresAt = intent.getLongExtra(CallNotifications.EXTRA_EXPIRES, 0L).coerceAtLeast(0L),
        colleagueId = intent.getStringExtra(CallNotifications.EXTRA_COLLEAGUE)?.takeIf { PushPayload.isId(it) },
        callerAvatarUrl = TeamCallRing.avatarUrl(intent.getStringExtra(CallNotifications.EXTRA_AVATAR)),
    )
}

/**
 * A call ringing this phone — a visitor's to the call centre, or a
 * colleague's — and what it leaves behind.
 *
 * Its own channel, [AppBrand.callsChannel], apart from messages: it rings with the
 * phone's ringtone rather than the notification sound, and an operator who
 * silences one of the two has not silenced the other. The notification is
 * the platform's incoming-call one — caller, Answer, Decline — and, where the
 * system allows it, full screen over the lock screen, the way a phone call
 * rings.
 *
 * It rings until it is answered, declined, or the server says stop; and it
 * stops by itself at the ring's expiry, because a ring whose cancel never
 * arrived must not go on for ever.
 *
 * A colleague's ring differs in three things: their face rides with it (their
 * photo, or the platform's silhouette, never a letter: [CallerFace]); Decline
 * tells the server, which ends the call for the caller
 * ([CallActionReceiver]); and a ring the colleague gave up on, or nobody
 * answered, leaves a missed call that opens their thread.
 */
object CallNotifications {
    const val CHANNEL_CALLS = AppBrand.callsChannel

    /** Extras on the intents a ring hands back to the app. */
    const val ACTION_ANSWER = AppBrand.callActionPrefix + ".ANSWER"
    const val ACTION_SHOW = AppBrand.callActionPrefix + ".SHOW"
    const val ACTION_DECLINE = AppBrand.callActionPrefix + ".DECLINE"

    /** Decline on a colleague's ring: told to the server, unlike the call centre's. */
    const val ACTION_TEAM_DECLINE = AppBrand.callActionPrefix + ".TEAM_DECLINE"
    const val EXTRA_CALL = "callId"
    const val EXTRA_WORKSPACE = "workspaceId"
    const val EXTRA_CHANNEL = "channel"
    const val EXTRA_CALLER = "caller"
    const val EXTRA_EXPIRES = "expiresAt"

    /** On a colleague's ring only: who is calling, and their photo. */
    const val EXTRA_COLLEAGUE = "colleagueId"
    const val EXTRA_AVATAR = "callerAvatarUrl"

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
    fun showIncoming(context: Context, call: IncomingCall, language: Language, nowMillis: Long = System.currentTimeMillis()) {
        // The name the inbox list gives them, anonymous visitors included.
        val name = call.displayName(language)
        val video = call.channel == CallChannel.VIDEO
        val posted = postRing(
            context = context,
            tag = TAG,
            callId = call.callId,
            expiresAt = call.expiresAt,
            caller = Person.Builder().setName(name).setImportant(true).build(),
            video = video,
            text = StrAndroid.incomingCall(language, video),
            workspaceName = call.workspaceName,
            answer = activityIntent(context, call.callId, ACTION_ANSWER) { ringExtras(call.workspaceId, call.channel, name, call.expiresAt) },
            show = activityIntent(context, call.callId, ACTION_SHOW) { ringExtras(call.workspaceId, call.channel, name, call.expiresAt) },
            decline = declineIntent(context, call.callId, ACTION_DECLINE) { putExtra(EXTRA_WORKSPACE, call.workspaceId) },
            declineLabel = StrAndroid.declineCall(language),
            answerLabel = StrAndroid.answerCall(language),
            extras = Bundle().apply { putString(EXTRA_CALL, call.callId) },
            language = language,
            nowMillis = nowMillis,
        )
        if (posted) unanswered[call.callId] = name
    }

    /**
     * A colleague's ring: their name and face, "Incoming voice call" or
     * "Incoming video call", Answer and Decline. [photo] is their picture,
     * already fetched ([CallerFace.photo]); without one the face is the
     * silhouette. What a missed call will need to open their thread rides in
     * the notification's own extras, so it survives this process.
     */
    fun showTeamIncoming(
        context: Context,
        ring: TeamCallRing,
        language: Language,
        photo: Bitmap?,
        nowMillis: Long = System.currentTimeMillis(),
    ): Boolean {
        val name = ring.displayName(language)
        val video = ring.channel == CallChannel.VIDEO
        val caller = Person.Builder()
            .setName(name)
            .setIcon(IconCompat.createWithBitmap(CallerFace.face(photo)))
            .setImportant(true)
            .build()
        val extras: Intent.() -> Unit = {
            ringExtras(ring.workspaceId, ring.channel, name, ring.expiresAt)
            putExtra(EXTRA_COLLEAGUE, ring.callerUserId)
            ring.callerAvatarUrl?.let { putExtra(EXTRA_AVATAR, it) }
        }
        val posted = postRing(
            context = context,
            tag = TEAM_TAG,
            callId = ring.callId,
            expiresAt = ring.expiresAt,
            caller = caller,
            video = video,
            text = if (video) Str.teamCallIncomingVideo(language) else Str.teamCallIncomingVoice(language),
            workspaceName = ring.workspaceName,
            answer = activityIntent(context, ring.callId, ACTION_ANSWER, extras),
            show = activityIntent(context, ring.callId, ACTION_SHOW, extras),
            decline = declineIntent(context, ring.callId, ACTION_TEAM_DECLINE) {},
            declineLabel = Str.teamCallDecline(language),
            answerLabel = Str.teamCallAnswer(language),
            extras = Bundle().apply {
                putString(EXTRA_CALL, ring.callId)
                putString(EXTRA_WORKSPACE, ring.workspaceId)
                putString(EXTRA_COLLEAGUE, ring.callerUserId)
                putString(EXTRA_CHANNEL, ring.channel.wire)
                putString(EXTRA_CALLER, name)
            },
            language = language,
            nowMillis = nowMillis,
        )
        if (posted) {
            unansweredColleagues[ring.callId] = MissedColleague(name, ring.workspaceId, ring.callerUserId, ring.channel)
        }
        return posted
    }

    /** Whether a ring was posted at all: not without permission, nor past its expiry. */
    @SuppressLint("MissingPermission") // Notifications.canPost() is the check, and it runs first.
    private fun postRing(
        context: Context,
        tag: String,
        callId: String,
        expiresAt: Long,
        caller: Person,
        video: Boolean,
        text: String,
        workspaceName: String?,
        answer: PendingIntent,
        show: PendingIntent,
        decline: PendingIntent,
        declineLabel: String,
        answerLabel: String,
        extras: Bundle?,
        language: Language,
        nowMillis: Long,
    ): Boolean {
        if (!Notifications.canPost(context)) return false
        val remaining = expiresAt * 1000 - nowMillis
        if (remaining <= 0) return false
        ensureChannel(context, language, rename = false)

        val builder = NotificationCompat.Builder(context, CHANNEL_CALLS)
            .setSmallIcon(R.drawable.ic_stat_call)
            .setColor(ContextCompat.getColor(context, R.color.brand_deep))
            .setContentTitle(caller.name)
            .setContentText(text)
            .setSubText(workspaceName)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setOngoing(true)
            .setAutoCancel(false)
            .setTimeoutAfter(remaining)
            .setContentIntent(show)
            .addPerson(caller)
        extras?.let(builder::addExtras)
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            // Android 7 has no channels, so the ringtone and the buzz that
            // the calls channel gives every later version are the notification's
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
                .addAction(0, declineLabel, decline)
                .addAction(0, answerLabel, answer)
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
        NotificationManagerCompat.from(context).notify(tag, callId.hashCode(), notification)
        return true
    }

    /**
     * Whether this call is still ringing here: its ring — the colleague's
     * when [colleague] — is on screen now, posted for this very call.
     *
     * What [MainActivity] asks before it acts on a ring's Answer or tap. That
     * activity is exported (it is the launcher), so any app on the phone can
     * hand it an intent shaped like a ring's; only one that names a call
     * ringing here right now is the ring's own, and anything else is dropped
     * rather than answered with the microphone live over the lock screen.
     */
    fun isRinging(context: Context, callId: String, colleague: Boolean = false): Boolean {
        val active = ringing(context, callId, if (colleague) TEAM_TAG else TAG) ?: return false
        // The notification's id is the call id's hash: the call id it carries
        // is what makes it this call's and not another's with the same hash.
        return active.extras?.getString(EXTRA_CALL) == callId
    }

    /** Answered or declined on this phone: whatever happens to the call next, nobody missed it here. */
    fun forget(callId: String) {
        unanswered.remove(callId)
        unansweredColleagues.remove(callId)
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

    /**
     * Stops a colleague's ring. When they were [missed] — they gave up, or
     * the ring ran out, and this phone neither answered nor declined — a
     * missed call takes its place, "Missed voice call" or "Missed video
     * call" with their name, and opens their thread. It is posted under the
     * very key the server's own missed-call notification for the same call
     * has (`team_call:<id>`, [Notifications.showMessage]), so the two are
     * one notification whichever arrives last.
     */
    fun stopTeam(context: Context, callId: String, missed: Boolean, language: Language) {
        val active = ringing(context, callId, TEAM_TAG)
        val remembered = unansweredColleagues.remove(callId)
        runCatching { NotificationManagerCompat.from(context).cancel(TEAM_TAG, callId.hashCode()) }
        if (!missed) return
        val extras = active?.extras
        val workspaceId = extras?.getString(EXTRA_WORKSPACE) ?: remembered?.workspaceId ?: return
        val peerId = extras?.getString(EXTRA_COLLEAGUE) ?: remembered?.peerId ?: return
        val channel = extras?.getString(EXTRA_CHANNEL)?.let(CallChannel::from) ?: remembered?.channel ?: CallChannel.AUDIO
        val name = extras?.getString(EXTRA_CALLER) ?: remembered?.name ?: Str.teamCallColleague(language)
        Notifications.showMessage(
            context,
            PushPayload(
                type = PushPayload.TYPE_TEAM_CALL_MISSED,
                workspaceId = workspaceId,
                conversationId = null,
                messageId = null,
                peerId = peerId,
                callId = callId,
            ),
            title = if (channel == CallChannel.VIDEO) Str.teamCallMissedVideo(language) else Str.teamCallMissedVoice(language),
            body = name,
            language = language,
        )
    }

    private fun ringing(context: Context, callId: String, tag: String = TAG): Notification? {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return null
        val manager = ContextCompat.getSystemService(context, NotificationManager::class.java) ?: return null
        return runCatching {
            manager.activeNotifications.firstOrNull { it.tag == tag && it.id == callId.hashCode() }?.notification
        }.getOrNull()
    }

    private fun canUseFullScreen(context: Context): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.UPSIDE_DOWN_CAKE) return true
        val manager = ContextCompat.getSystemService(context, NotificationManager::class.java) ?: return false
        return runCatching { manager.canUseFullScreenIntent() }.getOrDefault(false)
    }

    private fun Intent.ringExtras(workspaceId: String, channel: CallChannel, caller: String, expiresAt: Long) {
        putExtra(EXTRA_WORKSPACE, workspaceId)
        putExtra(EXTRA_CHANNEL, channel.wire)
        putExtra(EXTRA_CALLER, caller)
        putExtra(EXTRA_EXPIRES, expiresAt)
    }

    private fun activityIntent(context: Context, callId: String, action: String, extras: Intent.() -> Unit): PendingIntent =
        PendingIntent.getActivity(
            context,
            requestCode(callId, action),
            Intent(context, MainActivity::class.java).apply {
                this.action = action
                flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
                putExtra(EXTRA_CALL, callId)
                extras()
            },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

    /** A broadcast to [CallActionReceiver], so declining does not open the app. */
    private fun declineIntent(context: Context, callId: String, action: String, extras: Intent.() -> Unit): PendingIntent =
        PendingIntent.getBroadcast(
            context,
            requestCode(callId, action),
            Intent(context, CallActionReceiver::class.java).apply {
                this.action = action
                putExtra(EXTRA_CALL, callId)
                extras()
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

    /** The same for colleagues' rings, with what their missed call opens. */
    private val unansweredColleagues = java.util.concurrent.ConcurrentHashMap<String, MissedColleague>()

    private data class MissedColleague(
        val name: String,
        val workspaceId: String,
        val peerId: String,
        val channel: CallChannel,
    )

    private const val TAG = "call"

    /** A colleague's ring: its own tag, so a call-centre call and a colleague's never stop each other. */
    private const val TEAM_TAG = "team-call"
    private const val MISSED_TAG = "missed-call"

    /** A phone's ring: the channel's from Android 8, the notification's own before. */
    private val RING_VIBRATION = longArrayOf(0, 800, 600, 800, 600)
}
