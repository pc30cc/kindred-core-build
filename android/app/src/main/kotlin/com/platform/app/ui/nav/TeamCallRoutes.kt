package com.platform.app.ui.nav

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.platform.app.LocalAppGraph
import com.platform.app.MainActivity
import com.platform.app.core.model.CallChannel
import com.platform.app.core.model.TeamCall
import com.platform.app.core.net.ServerApi
import com.platform.app.core.push.CallNotifications
import com.platform.app.feature.call.LiveKitRoom
import com.platform.app.feature.call.ServiceCallForeground
import com.platform.app.feature.call.TeamCallEnd
import com.platform.app.feature.call.TeamCallPhase
import com.platform.app.feature.call.TeamCallScreen
import com.platform.app.feature.call.TeamCallSession
import com.platform.app.feature.call.ToneRingback
import com.platform.app.i18n.Language
import com.platform.app.i18n.Str
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.stateIn
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.platform.app.feature.call.ActiveCall
import com.platform.app.feature.call.ActiveCallIdentity
import com.platform.app.feature.call.ActiveCallStage
import com.platform.app.feature.call.ActiveCallState
import com.platform.app.feature.call.activeStage

/**
 * A colleague call: placed from their thread, or rung on this phone — the
 * ring's own notification tapped (or shown full screen over the lock screen),
 * or its Answer pressed, in which case it answers on arrival.
 *
 * The session is the screen's view model, so it lives as long as the call
 * screen is on the stack and survives the phone turning; the foreground
 * service it starts keeps the process — and the microphone — when the screen
 * goes off. Back minimises the call into its bubble (the red button ends
 * it); the screen leaving the stack for good ends it (the session's
 * onCleared).
 */
@Composable
fun TeamCallRoute(
    key: TeamCallKey,
    api: ServerApi,
    language: Language,
    /**
     * Answer was pressed on the ring's notification while this screen was
     * already open for the call (AppShell): this screen answers it, once,
     * and says so with [onAnswerTaken].
     */
    answerRequested: Boolean,
    onAnswerTaken: () -> Unit,
    /** Whether the screen now in front is a call ringing, or answered, on this phone. */
    ringInFront: () -> Boolean,
    onDone: () -> Unit,
    /**
     * Takes this screen off the display with the call still on: the rest of
     * the app comes back, the call in a small bubble over it
     * ([com.platform.app.feature.call.FloatingCallBubble]).
     */
    onMinimise: () -> Unit = {},
) {
    val context = LocalContext.current
    val graph = LocalAppGraph.current
    val channel = remember(key.channel) { CallChannel.from(key.channel) }
    val session: TeamCallSession = viewModel(
        // The room, the tone and the service are made INSIDE the factory,
        // once with the session: see CallRoute.
        factory = viewModelFactory {
            val app = context.applicationContext
            TeamCallSession(
                api = api,
                room = LiveKitRoom(app),
                deviceId = { graph?.push?.deviceId() },
                nudges = graph?.teamCallNudges ?: emptyFlow(),
                ringback = ToneRingback(app),
                foreground = ServiceCallForeground(app),
                rang = { id -> graph?.teamCallRang?.report(id) },
            )
        },
    )
    val room = session.room as LiveKitRoom

    val phase by session.phase.collectAsStateWithLifecycle()
    val peer by session.peer.collectAsStateWithLifecycle()
    val muted by session.muted.collectAsStateWithLifecycle()
    val cameraOn by session.cameraOn.collectAsStateWithLifecycle()
    val frontCamera by session.frontCamera.collectAsStateWithLifecycle()
    val speakerOn by session.speakerOn.collectAsStateWithLifecycle()
    val relayWarning by session.relayWarning.collectAsStateWithLifecycle()
    val degraded by session.degraded.collectAsStateWithLifecycle()
    val remoteVideo by room.remoteVideo.collectAsStateWithLifecycle()
    val localVideo by room.localVideo.collectAsStateWithLifecycle()

    val known = remember(key) { TeamCall.Peer(userId = key.peerId, name = key.peerName, avatarUrl = key.peerAvatarUrl) }
    val wanted = remember(channel) {
        if (channel == CallChannel.VIDEO) {
            arrayOf(Manifest.permission.RECORD_AUDIO, Manifest.permission.CAMERA)
        } else {
            arrayOf(Manifest.permission.RECORD_AUDIO)
        }
    }
    fun granted(permission: String) =
        ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED

    val ringId = key.callId
    // This phone's ring, dealt with here: whatever happens to the call next,
    // nobody missed it on this phone.
    val silence = {
        if (ringId != null) {
            CallNotifications.stopTeam(context, ringId, missed = false, language = language)
            CallNotifications.forget(ringId)
        }
    }

    // Asked for at the moment the call starts, not at launch. Placing a call
    // without the microphone would ring the colleague into silence, so a
    // refusal places nothing; answering one goes ahead without it, and the
    // session says which half of the call is missing — the colleague is
    // already waiting.
    var outgoingAsked by remember { mutableStateOf(false) }
    // Answer, or "Audio only" on a video call: the camera is asked for only
    // when it will be used.
    var answerWithVideo by remember { mutableStateOf(true) }
    val permissions = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
        if (ringId != null) session.answer(withVideo = answerWithVideo) else outgoingAsked = true
    }
    // Only a ring is answered: the key's own Answer, run again as the screen
    // comes back from under another, asks for nothing twice.
    val answerAs = { withVideo: Boolean ->
        if (session.phase.value == TeamCallPhase.Ringing) {
            silence()
            answerWithVideo = withVideo
            val needed = if (withVideo) wanted else arrayOf(Manifest.permission.RECORD_AUDIO)
            if (needed.all(::granted)) session.answer(withVideo = withVideo) else permissions.launch(needed)
        }
    }
    val answer = { answerAs(true) }
    // Declined here: the ring stops, the server is told, and the screen goes
    // — there is nothing on it to read.
    val decline = {
        silence()
        session.hangUp()
        onDone()
    }

    if (ringId != null) {
        // First of this screen's effects, and it does not suspend, so an
        // Answer that came with the key (the effects below) finds it ringing.
        LaunchedEffect(ringId) { session.ring(ringId, known, channel, language) }
        LaunchedEffect(ringId, key.answer) { if (key.answer) answer() }
        LaunchedEffect(ringId, answerRequested) {
            if (!answerRequested) return@LaunchedEffect
            onAnswerTaken()
            answer()
        }
        // A ring that ended under this screen — answered on another phone,
        // the colleague gave up — stops here too, in case its cancel never
        // came. Missed when it was: the server's missed call for the same
        // call takes the same place in the tray. A ring that was never
        // answered here and ended cancelled or missed then leaves only that
        // notification: its screen closes at once (below), so the member
        // sees one end, not two.
        LaunchedEffect(phase) {
            val end = (phase as? TeamCallPhase.Ended)?.end ?: return@LaunchedEffect
            CallNotifications.stopTeam(
                context,
                ringId,
                missed = end == TeamCallEnd.MISSED || end == TeamCallEnd.CANCELLED,
                language = language,
            )
        }
    } else {
        LaunchedEffect(Unit) {
            // Asked once, before the call: a screen brought back from its
            // bubble composes this again, and must not ask over a live call.
            if (session.started || wanted.all(::granted)) outgoingAsked = true else permissions.launch(wanted)
        }
        // Asks the session to call; `place` is idempotent, so a
        // recomposition never rings twice. See CallRoute.
        LaunchedEffect(key.workspaceId, outgoingAsked) {
            if (!outgoingAsked) return@LaunchedEffect
            if (granted(Manifest.permission.RECORD_AUDIO)) {
                session.place(key.workspaceId, known, channel, language)
            } else {
                session.refuseWithoutMicrophone(known, channel, language)
            }
        }
    }

    // Back on the ring is Decline, as the red button is: the ring stops here
    // at once, not when the server's word that it was declined comes back —
    // or, with no network, never, and then as a missed call.
    BackHandler(enabled = ringId != null && phase == TeamCallPhase.Ringing, onBack = decline)
    // Back on a call placed or answered keeps it going, small, over the rest
    // of the app (the red button is how it ends) — and, being a plain Back
    // handler, it shows no preview of the screen underneath: nothing behind
    // the call shows through it, even for the length of a gesture.
    val ringingHere = ringId != null && phase == TeamCallPhase.Ringing
    BackHandler(enabled = !ringingHere && !phase.isOver, onBack = onMinimise)
    BackHandler(enabled = phase.isOver, onBack = onDone)

    // A call that is over closes its screen on its own: at once when there
    // is nothing for it to say (a ring here cancelled, missed or declined —
    // the notification's Decline included), else a moment after it says how
    // the call ended. After the ring's own effect above, which posts the
    // missed call first. Not while minimised or in its bubble, where this
    // screen is not composed: AppShell drops that call as it ends.
    LaunchedEffect(phase) {
        val after = phase.closesAfterMs ?: return@LaunchedEffect
        if (after > 0) delay(after)
        onDone()
    }

    // The small views of this call — the picture-in-picture window, the
    // bubble — read it from here, for as long as the session lives.
    val active = rememberActiveCall(session) {
        ActiveCall(
            owner = session,
            screen = key,
            colleague = true,
            state = combine(session.phase, session.muted, session.cameraOn) { p, m, _ ->
                ActiveCallState(
                    stage = p.activeStage(incoming = ringId != null),
                    since = (p as? TeamCallPhase.Live)?.since,
                    muted = m,
                    video = channel == CallChannel.VIDEO,
                )
            }.stateIn(session.viewModelScope, SharingStarted.Eagerly, ActiveCallState(ActiveCallStage.OUTGOING)),
            room = room,
            toggleMute = session::toggleMute,
            hangUp = session::hangUp,
        )
    }

    // Over the lock screen for the call, and only for the call — unless the
    // screen that took its place is a ring of its own, which the tap that
    // opened it has just put there.
    val inFront by rememberUpdatedState(ringInFront)
    DisposableEffect(Unit) {
        onDispose { if (!inFront()) (context as? MainActivity)?.showOverLockScreen(false) }
    }

    // Their profile name — never an e-mail, which the call's notification
    // would show on the lock screen — else "Colleague".
    val peerName = peer.name?.takeIf { it.isNotBlank() } ?: Str.teamCallColleague(language)
    LaunchedEffect(active, peerName, peer.avatarUrl) {
        active?.identity?.value = ActiveCallIdentity(name = peerName, avatarUrl = peer.avatarUrl)
    }

    TeamCallScreen(
        phase = phase,
        incoming = ringId != null,
        channel = channel,
        peerName = peerName,
        peerAvatarUrl = peer.avatarUrl,
        language = language,
        muted = muted,
        cameraOn = cameraOn,
        frontCamera = frontCamera,
        speakerOn = speakerOn,
        relayWarning = relayWarning,
        degraded = degraded,
        remoteVideo = remoteVideo,
        localVideo = localVideo,
        room = room,
        onAnswer = answer,
        onAnswerVoiceOnly = if (channel == CallChannel.VIDEO) ({ answerAs(false) }) else null,
        onHangUp = { if (ringId != null && phase == TeamCallPhase.Ringing) decline() else session.hangUp() },
        onToggleMute = rememberMicToggle({ session.muted.value }, session::toggleMute),
        onToggleCamera = rememberCameraToggle({ session.cameraOn.value }, session::toggleCamera),
        onSwitchCamera = session::switchCamera,
        onToggleSpeaker = session::toggleSpeaker,
        onAtEar = session::setAtEar,
        onDone = onDone,
        onMinimise = onMinimise,
    )
}

/**
 * The camera button: turning the camera on asks for it first when it was
 * never granted (a video call answered "Audio only", or a refusal at the
 * start), and turns it on only once allowed. Turning it off asks nothing.
 */
@Composable
internal fun rememberCameraToggle(cameraOn: () -> Boolean, toggle: () -> Unit): () -> Unit =
    rememberPermissionToggle(Manifest.permission.CAMERA, asksWhen = { !cameraOn() }, toggle)

/**
 * The mute button: unmuting a call whose microphone was never granted asks
 * for it first, and unmutes only once allowed. Muting asks nothing.
 */
@Composable
internal fun rememberMicToggle(muted: () -> Boolean, toggle: () -> Unit): () -> Unit =
    rememberPermissionToggle(Manifest.permission.RECORD_AUDIO, asksWhen = muted, toggle)

/**
 * A call control that needs [permission] in one direction ([asksWhen]): asked
 * for first when missing. The call is not sent into its picture-in-picture
 * window by the dialog (which Android 8 to 11 count as leaving the app).
 */
@Composable
private fun rememberPermissionToggle(permission: String, asksWhen: () -> Boolean, toggle: () -> Unit): () -> Unit {
    val context = LocalContext.current
    val currentToggle by rememberUpdatedState(toggle)
    val ask = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) currentToggle()
    }
    return {
        val granted = ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED
        if (asksWhen() && !granted) {
            (context as? MainActivity)?.pictureInPicture?.holdForPermission()
            ask.launch(permission)
        } else {
            toggle()
        }
    }
}

/**
 * The call [owner] publishes for the views of it that are not its screen
 * ([ActiveCalls]): made once per session, whatever the screen does — it
 * leaves the display when minimised and comes back — and withdrawn when the
 * session is cleared. Null without the app's graph (a preview, a test).
 */
@Composable
internal fun rememberActiveCall(owner: ViewModel, build: () -> ActiveCall): ActiveCall? {
    val graph = LocalAppGraph.current ?: return null
    return remember(owner) { graph.activeCalls.of(owner) ?: graph.activeCalls.publish(build()) }
}
