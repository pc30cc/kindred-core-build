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
import kotlinx.coroutines.flow.emptyFlow

/**
 * A colleague call: placed from their thread, or rung on this phone — the
 * ring's own notification tapped (or shown full screen over the lock screen),
 * or its Answer pressed, in which case it answers on arrival.
 *
 * The session is the screen's view model, so it lives as long as the call
 * screen is on the stack and survives the phone turning; the foreground
 * service it starts keeps the process — and the microphone — when the screen
 * goes off. Back, like the red button, ends the call.
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
                ringback = ToneRingback(video = channel == CallChannel.VIDEO),
                foreground = ServiceCallForeground(app),
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
    val permissions = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
        if (ringId != null) session.answer() else outgoingAsked = true
    }
    // Only a ring is answered: the key's own Answer, run again as the screen
    // comes back from under another, asks for nothing twice.
    val answer = {
        if (session.phase.value == TeamCallPhase.Ringing) {
            silence()
            if (wanted.all(::granted)) session.answer() else permissions.launch(wanted)
        }
    }
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
        // call takes the same place in the tray.
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
            if (wanted.all(::granted)) outgoingAsked = true else permissions.launch(wanted)
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
    // or, with no network, never, and then as a missed call. Back on anything
    // else leaves the screen, which ends the call (the session's onCleared).
    BackHandler(enabled = ringId != null && phase == TeamCallPhase.Ringing, onBack = decline)

    // Over the lock screen for the call, and only for the call — unless the
    // screen that took its place is a ring of its own, which the tap that
    // opened it has just put there.
    val inFront by rememberUpdatedState(ringInFront)
    DisposableEffect(Unit) {
        onDispose { if (!inFront()) (context as? MainActivity)?.showOverLockScreen(false) }
    }

    TeamCallScreen(
        phase = phase,
        incoming = ringId != null,
        channel = channel,
        // Their profile name — never an e-mail, which the call's
        // notification would show on the lock screen — else "Colleague".
        peerName = peer.name?.takeIf { it.isNotBlank() } ?: Str.teamCallColleague(language),
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
        onHangUp = { if (ringId != null && phase == TeamCallPhase.Ringing) decline() else session.hangUp() },
        onToggleMute = session::toggleMute,
        onToggleCamera = session::toggleCamera,
        onSwitchCamera = session::switchCamera,
        onToggleSpeaker = session::toggleSpeaker,
        onDone = onDone,
    )
}
