package com.platform.app.feature.call

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.graphics.Bitmap
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.Person
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import androidx.core.graphics.drawable.IconCompat
import com.platform.app.MainActivity
import com.platform.app.R
import com.platform.app.core.AppBrand
import com.platform.app.core.push.CallActionReceiver
import com.platform.app.core.push.CallNotifications
import com.platform.app.core.push.CallerFace
import com.platform.app.core.push.TeamCallRing
import com.platform.app.i18n.Language
import com.platform.app.i18n.Str
import com.platform.app.i18n.StrAndroid
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import java.time.Instant

/**
 * Which kind of call an ongoing-call notification carries: what decides
 * where its End goes ([OngoingCallEnd]).
 */
enum class OngoingCallKind(val wire: String) {
    /** A colleague call (`/api/team-calls`, docs/operations/TEAM_CALLS.md). */
    TEAM("team"),

    /** A call this operator placed to a visitor from a conversation (`/api/calls`). */
    VISITOR("visitor"),

    /** A call-centre call this phone was rung for and answered (`/api/call-center`). */
    CENTER("center");

    companion object {
        fun from(wire: String?): OngoingCallKind? = entries.firstOrNull { it.wire == wire }
    }
}

/** What a call in progress shows in its notification. */
data class OngoingCall(
    /**
     * What the notification is for: the colleague call's id, or — a visitor
     * or call-centre call — the call's own key on this phone, which it has
     * before the server has made a session for it.
     */
    val callId: String,
    val peerName: String,
    val peerAvatarUrl: String?,
    /** The camera is on: the service holds it as well as the microphone. */
    val video: Boolean,
    val language: Language,
    /** When both came into the room: the notification's timer counts from it. Null until then. */
    val since: Instant? = null,
    val kind: OngoingCallKind = OngoingCallKind.TEAM,
    /** A call-centre call's workspace: its End goes through that workspace's call centre. */
    val workspaceId: String? = null,
    /** A visitor or call-centre call's session on the server, once there is one. */
    val sessionId: String? = null,
)

/**
 * Where End on an ongoing call's notification goes, so it ends the call the
 * way the red button on its screen would — and so the server is told the
 * same way when no screen is left to do it.
 */
sealed interface OngoingCallEnd {
    /** `POST /api/team-calls/:id/hangup`. */
    data class Team(val callId: String) : OngoingCallEnd

    /** `POST /api/calls/:id/hangup`. */
    data class Visitor(val callSessionId: String) : OngoingCallEnd

    /** The call centre's end, which also frees this operator's line. */
    data class Center(val workspaceId: String, val callSessionId: String) : OngoingCallEnd

    companion object {
        /**
         * The server's end for a notification's [kind] and ids, or null when
         * they do not make one — a visitor call still inviting has no session
         * yet, a call-centre call needs its workspace: nothing is sent then
         * rather than the wrong request.
         */
        fun of(kind: OngoingCallKind, callId: String, sessionId: String?, workspaceId: String?): OngoingCallEnd? =
            when (kind) {
                OngoingCallKind.TEAM -> Team(callId)
                OngoingCallKind.VISITOR -> sessionId?.let(::Visitor)
                OngoingCallKind.CENTER -> if (sessionId != null && workspaceId != null) Center(workspaceId, sessionId) else null
            }
    }
}

/**
 * Which foreground-service types a call's service takes: the microphone
 * whenever it is granted, the camera too while the camera is on and granted.
 * Android 14 refuses a type whose permission is missing outright, so a
 * refused camera leaves a voice-only service rather than none. Before
 * Android 10 a service names no type at all (0); from then on, a call
 * whose service could use nothing is not given one ([NONE]).
 */
object OngoingCallTypes {
    const val NONE = -1

    fun of(sdk: Int, video: Boolean, microphoneGranted: Boolean, cameraGranted: Boolean): Int {
        if (sdk < Build.VERSION_CODES.Q) return 0
        var types = 0
        if (microphoneGranted) types = types or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
        if (video && cameraGranted) types = types or ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA
        return if (types == 0) NONE else types
    }
}

/**
 * Keeps a call alive while the screen is off — or the app behind another —
 * and says so: [show] at the start of the call, again once it is live and
 * whenever the camera turns on or off, [stop] at its end. Behind an
 * interface so the sessions that decide when are tested on a JVM.
 */
interface CallForeground {
    fun show(call: OngoingCall)
    fun stop()
}

/** No service: a session built without one (its tests). */
object NoCallForeground : CallForeground {
    override fun show(call: OngoingCall) {}
    override fun stop() {}
}

/**
 * [CallForeground] as [OngoingCallService], for one session. The service is
 * one for the whole app, so a stop names the call this session showed: a
 * session ending after another call took the service over — or one that
 * only rang and never showed anything — leaves that call its service.
 */
class ServiceCallForeground(private val context: Context) : CallForeground {
    private var shown: String? = null

    override fun show(call: OngoingCall) {
        shown = call.callId
        OngoingCallService.start(context, call)
    }

    override fun stop() {
        shown?.let { OngoingCallService.stop(context, it) }
        shown = null
    }
}

/**
 * The foreground service every call in progress runs under: a colleague
 * call, a call to a visitor and an answered call-centre call alike — one
 * ongoing-call notification, one way in and out.
 *
 * Without one, Android hands an app that is not on screen silence for a
 * microphone and no camera (Android 9 and later, and since Android 11 for
 * any app without a `microphone`/`camera` service), and stops its process
 * when it likes: the operator presses Home, or the screen turns off at the
 * ear, and the other side goes on talking to a phone that has stopped
 * sending. Typed `microphone` — and `camera` while the camera is on — which
 * is what Android 14 asks a service that uses them to say, and only with
 * the permission already granted ([OngoingCallTypes]).
 *
 * Its notification is the platform's ongoing-call one: the other side's
 * name and face (their photo, or the silhouette — never a letter:
 * [CallerFace]), the call's timer once both are in, End, and a tap that
 * returns to the call. End goes to [CallActionReceiver], which ends the
 * call the way its own red button would, by its [OngoingCallKind]. In a
 * quiet channel of its own: an ongoing call must not ring.
 *
 * Started with `startService` from the call screen, while the app is in
 * front — never `startForegroundService` from the background, which Android
 * 12 and later refuse for a service of these types, and which would crash
 * the app if the promotion then failed. Not sticky: a process that died has
 * no call to come back to, and its notification goes with it.
 */
class OngoingCallService : Service() {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

    /** The call as last shown: what a photo that lands later is drawn into. */
    private var current: OngoingCall? = null

    /** The other side's photo, fetched once per call. */
    private var photo: Bitmap? = null
    private var photoFor: String? = null
    private var photoJob: Job? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            // Only the call it is for. Stopped by this start's own id, so a
            // start for another call that came in behind it still runs.
            val callId = intent.getStringExtra(CallNotifications.EXTRA_CALL)
            if (current == null || current?.callId == callId) stopSelf(startId)
            return START_NOT_STICKY
        }
        val call = intent?.let(::callOf)
        if (call == null || !promote(call)) {
            // An update Android would not take — the camera turned on with
            // the app behind, say — leaves the same call as it was shown,
            // still holding the microphone. Anything else has no service.
            if (call == null || current?.callId != call.callId) stopSelf()
            return START_NOT_STICKY
        }
        if (current?.callId != call.callId) {
            photo = null
            photoFor = null
            photoJob?.cancel()
        }
        current = call
        val url = call.peerAvatarUrl
        if (url != null && url != photoFor) {
            photoFor = url
            photoJob?.cancel()
            photoJob = scope.launch {
                photo = CallerFace.photo(applicationContext, url)
                if (photo != null) current?.let(::promote)
            }
        }
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        scope.cancel()
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        super.onDestroy()
    }

    /** In the foreground with [call]'s notification, or false when Android will not have it. */
    private fun promote(call: OngoingCall): Boolean {
        val types = OngoingCallTypes.of(
            sdk = Build.VERSION.SDK_INT,
            video = call.video,
            microphoneGranted = granted(Manifest.permission.RECORD_AUDIO),
            cameraGranted = granted(Manifest.permission.CAMERA),
        )
        if (types == OngoingCallTypes.NONE) return false
        ensureChannel(this, call.language)
        return runCatching {
            ServiceCompat.startForeground(this, NOTIFICATION_ID, notification(call), types)
        }.isSuccess
    }

    private fun granted(permission: String): Boolean =
        ContextCompat.checkSelfPermission(this, permission) == PackageManager.PERMISSION_GRANTED

    private fun notification(call: OngoingCall): android.app.Notification {
        val person = Person.Builder()
            .setName(call.peerName)
            .setIcon(IconCompat.createWithBitmap(CallerFace.face(photo)))
            .setImportant(true)
            .build()
        val back = PendingIntent.getActivity(
            this,
            call.callId.hashCode(),
            Intent(this, MainActivity::class.java).apply {
                action = Intent.ACTION_MAIN
                addCategory(Intent.CATEGORY_LAUNCHER)
                flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
            },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val hangUp = PendingIntent.getBroadcast(
            this,
            (call.callId + ACTION_HANG_UP).hashCode(),
            Intent(this, CallActionReceiver::class.java).apply {
                action = ACTION_HANG_UP
                putExtra(CallNotifications.EXTRA_CALL, call.callId)
                putExtra(EXTRA_KIND, call.kind.wire)
                call.workspaceId?.let { putExtra(EXTRA_WORKSPACE, it) }
                call.sessionId?.let { putExtra(EXTRA_SESSION, it) }
            },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val what = when (call.kind) {
            OngoingCallKind.TEAM ->
                if (call.video) Str.teamCallVideoAction(call.language) else Str.teamCallVoiceAction(call.language)
            OngoingCallKind.VISITOR, OngoingCallKind.CENTER ->
                if (call.video) Str.videoCall(call.language) else Str.voiceCall(call.language)
        }
        return NotificationCompat.Builder(this, CHANNEL_ONGOING)
            .setSmallIcon(R.drawable.ic_stat_call)
            .setColor(ContextCompat.getColor(this, R.color.brand_deep))
            .setContentTitle(call.peerName)
            .setContentText(what)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setContentIntent(back)
            .setStyle(NotificationCompat.CallStyle.forOngoingCall(person, hangUp).setIsVideo(call.video))
            .addPerson(person)
            .apply {
                call.since?.let { since ->
                    setWhen(since.toEpochMilli())
                    setShowWhen(true)
                    setUsesChronometer(true)
                }
            }
            .build()
    }

    companion object {
        /** End, on the ongoing call's notification ([CallActionReceiver]). */
        const val ACTION_HANG_UP = AppBrand.callActionPrefix + ".CALL_HANG_UP"

        /** On [ACTION_HANG_UP]: the call's [OngoingCallKind.wire]. */
        const val EXTRA_KIND = "callKind"

        /** On [ACTION_HANG_UP]: a call-centre call's workspace. */
        const val EXTRA_WORKSPACE = "workspaceId"

        /** On [ACTION_HANG_UP]: a visitor or call-centre call's session, once it has one. */
        const val EXTRA_SESSION = "callSessionId"

        /** [stop]: the call named is over. Not exported, like the service. */
        private const val ACTION_STOP = AppBrand.callActionPrefix + ".CALL_STOP"

        private const val CHANNEL_ONGOING = AppBrand.callsChannel + ".ongoing"
        private const val NOTIFICATION_ID = 0x7ea3

        private const val EXTRA_PEER = "peerName"
        private const val EXTRA_VIDEO = "video"
        private const val EXTRA_LANGUAGE = "language"
        private const val EXTRA_SINCE = "since"

        /**
         * Starts the service for [call], or brings its notification up to
         * date. Swallowed when Android refuses it — an app it counts as in
         * the background — because the call goes on regardless; only its
         * hold on the microphone with the screen off is lost.
         */
        fun start(context: Context, call: OngoingCall) {
            val intent = Intent(context, OngoingCallService::class.java).apply {
                putExtra(CallNotifications.EXTRA_CALL, call.callId)
                putExtra(EXTRA_PEER, call.peerName)
                call.peerAvatarUrl?.let { putExtra(CallNotifications.EXTRA_AVATAR, it) }
                putExtra(EXTRA_VIDEO, call.video)
                putExtra(EXTRA_LANGUAGE, call.language.code)
                call.since?.let { putExtra(EXTRA_SINCE, it.toEpochMilli()) }
                putExtra(EXTRA_KIND, call.kind.wire)
                call.workspaceId?.let { putExtra(EXTRA_WORKSPACE, it) }
                call.sessionId?.let { putExtra(EXTRA_SESSION, it) }
            }
            runCatching { context.startService(intent) }
        }

        /**
         * [callId] is over: the service stops if that is the call it is
         * showing, and carries on for any other. Through the service's own
         * queue, behind every start sent before it, so it is judged against
         * the call as last shown. A service in the foreground lets the app
         * send it from the background too; with no service running there is
         * nothing to stop, and a refusal is swallowed.
         */
        fun stop(context: Context, callId: String) {
            val intent = Intent(context, OngoingCallService::class.java).apply {
                action = ACTION_STOP
                putExtra(CallNotifications.EXTRA_CALL, callId)
            }
            runCatching { context.startService(intent) }
        }

        private fun callOf(intent: Intent): OngoingCall? {
            val callId = intent.getStringExtra(CallNotifications.EXTRA_CALL) ?: return null
            val language = Language.from(intent.getStringExtra(EXTRA_LANGUAGE)) ?: Language.DEFAULT
            val kind = OngoingCallKind.from(intent.getStringExtra(EXTRA_KIND)) ?: OngoingCallKind.TEAM
            val fallbackName = when (kind) {
                OngoingCallKind.TEAM -> Str.teamCallColleague(language)
                OngoingCallKind.VISITOR, OngoingCallKind.CENTER -> Str.unknownVisitor(language)
            }
            return OngoingCall(
                callId = callId,
                peerName = intent.getStringExtra(EXTRA_PEER)?.takeIf { it.isNotBlank() } ?: fallbackName,
                peerAvatarUrl = TeamCallRing.avatarUrl(intent.getStringExtra(CallNotifications.EXTRA_AVATAR)),
                video = intent.getBooleanExtra(EXTRA_VIDEO, false),
                language = language,
                since = intent.getLongExtra(EXTRA_SINCE, 0L).takeIf { it > 0 }?.let(Instant::ofEpochMilli),
                kind = kind,
                workspaceId = intent.getStringExtra(EXTRA_WORKSPACE),
                sessionId = intent.getStringExtra(EXTRA_SESSION),
            )
        }

        /** Quiet, and its own: silencing it must not silence the next ring. */
        private fun ensureChannel(context: Context, language: Language) {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
            val manager = ContextCompat.getSystemService(context, NotificationManager::class.java) ?: return
            val channel = NotificationChannel(
                CHANNEL_ONGOING,
                StrAndroid.channelOngoingCalls(language),
                NotificationManager.IMPORTANCE_LOW,
            ).apply {
                description = StrAndroid.channelOngoingCallsDescription(language)
                setSound(null, null)
                enableVibration(false)
            }
            runCatching { manager.createNotificationChannel(channel) }
        }
    }
}
