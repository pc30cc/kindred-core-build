package com.platform.app.feature.call

import android.content.Context
import android.os.PowerManager
import androidx.compose.animation.AnimatedContent
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.scaleIn
import androidx.compose.animation.scaleOut
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.widthIn
import androidx.compose.material3.LocalContentColor
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.boundsInRoot
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import com.platform.app.core.model.CallChannel
import com.platform.app.i18n.Format
import com.platform.app.i18n.Language
import com.platform.app.i18n.Str
import com.platform.app.ui.A11y
import com.platform.app.ui.components.Glyph
import com.platform.app.ui.components.OperatorAvatar
import com.platform.app.ui.design.AppType
import com.platform.app.ui.design.Size
import com.platform.app.ui.design.Space
import io.livekit.android.room.track.VideoTrack
import java.time.Instant

/**
 * A colleague call, from "Calling…" (or "Incoming voice call") to "Call
 * ended".
 *
 * The visitor call's visual language ([CallScreen]): the face in the middle
 * on the call's own dark surface, the controls at the bottom where the thumb
 * is, the colleague's picture edge to edge on a video call. What differs is
 * who is on the other end — a teammate, so their face is their photo or the
 * platform's silhouette ([OperatorAvatar]), never a visitor's OS mark and
 * never a letter — and the controls a phone call has: Decline and Answer
 * while it rings here, the loudspeaker on a voice call, the camera and its
 * switch on a video one.
 */
@Composable
fun TeamCallScreen(
    phase: TeamCallPhase,
    incoming: Boolean,
    channel: CallChannel,
    peerName: String,
    peerAvatarUrl: String?,
    language: Language,
    modifier: Modifier = Modifier,
    muted: Boolean = false,
    cameraOn: Boolean = false,
    frontCamera: Boolean = true,
    speakerOn: Boolean = false,
    relayWarning: Boolean = false,
    degraded: CallDegradation? = null,
    remoteVideo: VideoTrack? = null,
    localVideo: VideoTrack? = null,
    room: LiveKitRoom? = null,
    onAnswer: () -> Unit = {},
    /** A video call ringing here, answered with the camera off. Null: no such button. */
    onAnswerVoiceOnly: (() -> Unit)? = null,
    onHangUp: () -> Unit = {},
    onToggleMute: () -> Unit = {},
    onToggleCamera: () -> Unit = {},
    onSwitchCamera: () -> Unit = {},
    onToggleSpeaker: () -> Unit = {},
    onDone: () -> Unit = {},
    /** Keeps the call going in a small window over the rest of the app. Null: not offered. */
    onMinimise: (() -> Unit)? = null,
) {
    val video = channel == CallChannel.VIDEO
    // A video call is watched, not touched: left to the screen timeout, the
    // phone locks under the picture. A voice call needs nothing of the kind
    // — at the ear the proximity sensor turns the screen off
    // ([ProximityScreenOff]), and the foreground service keeps the call when
    // it is off.
    val view = LocalView.current
    val awake = video && !phase.isOver
    DisposableEffect(view, awake) {
        if (awake) view.keepScreenOn = true
        onDispose { if (awake) view.keepScreenOn = false }
    }
    ProximityScreenOff(active = !video && !speakerOn && !phase.isOver && !(incoming && phase == TeamCallPhase.Ringing))

    Box(
        // Opaque from edge to edge, on the lock screen too: the call's own
        // backdrop under everything, never a translucent surface.
        modifier
            .fillMaxSize()
            .background(CALL_BACKGROUND)
            .testTag(A11y.CALL_SCREEN),
    ) {
        var screenTop by remember { mutableFloatStateOf(0f) }
        var headerBottom by remember { mutableFloatStateOf(0f) }
        var controlsTop by remember { mutableFloatStateOf(Float.MAX_VALUE) }
        // The member's own picture while their camera gives one. A tap on the
        // small picture swaps it with the colleague's; the swap ends with it.
        val own = localVideo?.takeIf { room != null && cameraOn }
        var swapped by rememberStageSwap(own)
        val stage = CallStage.of(
            remote = remoteVideo?.takeIf { room != null },
            // Not mirrored: a colleague's phone sends its camera's picture as
            // the camera saw it. (A visitor's browser does not, which is why
            // [CallScreen] flips theirs.)
            remoteMirror = false,
            own = own,
            // A front camera's own preview is a mirror; the back camera's is
            // what is in front of the phone, the right way round.
            ownMirror = frontCamera,
            swapped = swapped,
        )
        val ringingHere = incoming && phase == TeamCallPhase.Ringing
        CompositionLocalProvider(LocalContentColor provides Color.White) {
            BoxWithConstraints(Modifier.fillMaxSize().onGloballyPositioned { screenTop = it.boundsInRoot().top }) {
                val faceSize = callFaceSize(maxHeight, incoming = ringingHere)
                CallBackdrop()
                if (room != null) {
                    stage.big?.let {
                        VideoView(it.track, room, Modifier.fillMaxSize(), mirror = it.mirror)
                        VideoScrims()
                    }
                }

                Column(
                    Modifier
                        .fillMaxSize()
                        .statusBarsPadding()
                        .navigationBarsPadding()
                        .padding(horizontal = Space.screenInset),
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    CallTopBar(language, onMinimise = onMinimise?.takeIf { !phase.isOver && !ringingHere })
                    Column(
                        Modifier
                            .padding(top = if (stage.big == null) Space.lg else Space.sm)
                            .onGloballyPositioned { headerBottom = it.boundsInRoot().bottom },
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.spacedBy(Space.md),
                    ) {
                        // Their face is redundant once a picture fills the
                        // screen, and a circle over a video is in the way.
                        AnimatedVisibility(
                            visible = stage.big == null,
                            enter = fadeIn() + scaleIn(initialScale = 0.9f),
                            exit = fadeOut() + scaleOut(targetScale = 0.9f),
                        ) {
                            CallHalo(ringing = !phase.isOver && phase !is TeamCallPhase.Live, faceSize = faceSize) {
                                OperatorAvatar(imageUrl = peerAvatarUrl, size = faceSize)
                            }
                        }
                        Text(
                            peerName,
                            style = if (stage.big == null) AppType.headlineMediumEmphasized else MaterialTheme.typography.titleLarge,
                            textAlign = TextAlign.Center,
                            maxLines = 2,
                            overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.fillMaxWidth(),
                        )
                        TeamCallStatus(phase, incoming, channel, language)
                        if (relayWarning) Notice(Str.callRelayWarning(language))
                        degraded?.let { Notice(it.title(language)) }
                    }

                    Spacer(Modifier.weight(1f))

                    Box(Modifier.onGloballyPositioned { controlsTop = it.boundsInRoot().top }) {
                        TeamCallControls(
                            phase = phase,
                            incoming = incoming,
                            video = video,
                            language = language,
                            muted = muted,
                            cameraOn = cameraOn,
                            speakerOn = speakerOn,
                            onAnswer = onAnswer,
                            onAnswerVoiceOnly = onAnswerVoiceOnly,
                            onHangUp = onHangUp,
                            onToggleMute = onToggleMute,
                            onToggleCamera = onToggleCamera,
                            onSwitchCamera = onSwitchCamera,
                            onToggleSpeaker = onToggleSpeaker,
                            onDone = onDone,
                        )
                    }
                }

                if (room != null && stage.hasCard && controlsTop != Float.MAX_VALUE) {
                    SelfView(
                        areaTop = headerBottom - screenTop,
                        areaBottom = controlsTop - screenTop,
                        language = language,
                        swapped = stage.swapped,
                        onSwap = { swapped = !swapped },
                    ) {
                        // Swapped with their camera off: their photo or the
                        // silhouette, as above — never a letter.
                        StageCardContent(stage.small, room) { size -> OperatorAvatar(imageUrl = peerAvatarUrl, size = size) }
                    }
                }
            }
        }
    }
}

/** The line under the name, and — for a call that failed — the server's own words under it. */
@Composable
private fun TeamCallStatus(phase: TeamCallPhase, incoming: Boolean, channel: CallChannel, language: Language) {
    val text = when (phase) {
        TeamCallPhase.Calling -> Str.teamCallCalling(language)
        TeamCallPhase.Ringing -> when {
            !incoming -> Str.teamCallRinging(language)
            channel == CallChannel.VIDEO -> Str.teamCallIncomingVideo(language)
            else -> Str.teamCallIncomingVoice(language)
        }
        TeamCallPhase.Connecting -> Str.teamCallConnecting(language)
        // Counted from when the two actually met, not from the ring.
        is TeamCallPhase.Live -> {
            var now by remember { mutableStateOf(Instant.now()) }
            LaunchedEffect(phase.since) {
                while (true) {
                    now = Instant.now()
                    kotlinx.coroutines.delay(1_000)
                }
            }
            Format.callDuration(phase.since, now, language)
        }
        is TeamCallPhase.Ended -> phase.end.title(language, channel)
    }
    val detail = (phase as? TeamCallPhase.Ended)?.detail?.takeIf { it.isNotBlank() }
    Column(
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(Space.xs),
        modifier = Modifier.fillMaxWidth(),
    ) {
        // "Calling…" fades into "Ringing…", then into the timer; the timer's
        // own seconds change in place, in digits of one width.
        val key = if (phase is TeamCallPhase.Live) "live" else text
        AnimatedContent(
            targetState = key,
            transitionSpec = { fadeIn() togetherWith fadeOut() },
            label = "teamCallStatus",
        ) { shown ->
            Text(
                if (shown == "live") text else shown,
                style = MaterialTheme.typography.titleMedium.copy(fontFeatureSettings = "tnum"),
                color = Color.White.copy(alpha = 0.80f),
                textAlign = TextAlign.Center,
                modifier = Modifier.fillMaxWidth().testTag(A11y.CALL_STATUS),
            )
        }
        if (detail != null) {
            Text(
                detail,
                style = MaterialTheme.typography.bodySmall,
                color = Color.White.copy(alpha = 0.55f),
                textAlign = TextAlign.Center,
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = Space.lg)
                    .testTag(A11y.CALL_FAILURE_REASON),
            )
        }
    }
}

@Composable
private fun TeamCallControls(
    phase: TeamCallPhase,
    incoming: Boolean,
    video: Boolean,
    language: Language,
    muted: Boolean,
    cameraOn: Boolean,
    speakerOn: Boolean,
    onAnswer: () -> Unit,
    onAnswerVoiceOnly: (() -> Unit)?,
    onHangUp: () -> Unit,
    onToggleMute: () -> Unit,
    onToggleCamera: () -> Unit,
    onSwitchCamera: () -> Unit,
    onToggleSpeaker: () -> Unit,
    onDone: () -> Unit,
) {
    if (incoming && phase == TeamCallPhase.Ringing) {
        IncomingCallActions(
            language = language,
            video = video,
            declineLabel = Str.teamCallDecline(language),
            answerLabel = Str.teamCallAnswer(language),
            onDecline = onHangUp,
            onAnswer = onAnswer,
            onAnswerVoiceOnly = onAnswerVoiceOnly,
        )
        return
    }
    val live = phase is TeamCallPhase.Live
    Column(
        Modifier.fillMaxWidth().padding(bottom = Space.xl),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(Space.xl),
    ) {
        if (!phase.isOver) {
            Row(
                Modifier.fillMaxWidth().widthIn(max = 420.dp),
                horizontalArrangement = Arrangement.SpaceEvenly,
                verticalAlignment = Alignment.Top,
            ) {
                CallToggle(
                    icon = if (muted) Glyph.MicOff else Glyph.Mic,
                    label = if (muted) Str.teamCallUnmute(language) else Str.teamCallMute(language),
                    tag = A11y.CALL_MUTE,
                    on = muted,
                    enabled = live,
                    onClick = onToggleMute,
                )
                if (video) {
                    CallToggle(
                        icon = if (cameraOn) Glyph.Videocam else Glyph.VideocamOff,
                        label = Str.teamCallCamera(language),
                        tag = A11y.CALL_CAMERA,
                        on = !cameraOn,
                        enabled = live,
                        onClick = onToggleCamera,
                    )
                    CallToggle(
                        icon = Glyph.CameraSwitch,
                        label = Str.teamCallSwitchCamera(language),
                        tag = A11y.CALL_SWITCH_CAMERA,
                        on = false,
                        enabled = live && cameraOn,
                        onClick = onSwitchCamera,
                    )
                } else {
                    // Not waiting for the answer: where the sound goes can be
                    // chosen while it rings, and the call starts there.
                    CallToggle(
                        icon = if (speakerOn) Glyph.Speaker else Glyph.SpeakerOff,
                        label = Str.teamCallSpeaker(language),
                        tag = A11y.CALL_SPEAKER,
                        on = speakerOn,
                        onClick = onToggleSpeaker,
                    )
                }
            }
        }
        // Red and round, ending the call; a quiet "Done" closing a finished
        // one: the only way off this screen either way.
        CallToggle(
            icon = if (phase.isOver) Icons.Filled.Check else Glyph.CallEnd,
            label = if (phase.isOver) Str.done(language) else Str.teamCallHangUp(language),
            tag = A11y.CALL_HANG_UP,
            on = true,
            tint = if (phase.isOver) CALL_DONE_GREY else CALL_END_RED,
            onClick = if (phase.isOver) onDone else onHangUp,
            diameter = PRIMARY_SIZE,
        )
    }
}

/**
 * The screen off while the phone is at the ear, on a voice call on the
 * earpiece: a cheek on the glass must not mute the call or hang it up. The
 * platform's own proximity lock, held only while [active].
 */
@Composable
private fun ProximityScreenOff(active: Boolean) {
    val context = LocalContext.current
    DisposableEffect(context, active) {
        val lock = if (active) proximityLock(context)?.also { runCatching { it.acquire(PROXIMITY_MAX_MS) } } else null
        onDispose {
            lock?.let { held ->
                runCatching { if (held.isHeld) held.release(PowerManager.RELEASE_FLAG_WAIT_FOR_NO_PROXIMITY) }
            }
        }
    }
}

private fun proximityLock(context: Context): PowerManager.WakeLock? {
    val power = ContextCompat.getSystemService(context, PowerManager::class.java) ?: return null
    if (!power.isWakeLockLevelSupported(PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK)) return null
    return runCatching {
        power.newWakeLock(PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK, PROXIMITY_TAG)
            .apply { setReferenceCounted(false) }
    }.getOrNull()
}

/** For the system's own diagnostics: what holds the lock, never who is on the call. */
private const val PROXIMITY_TAG = "platform:team-call-proximity"

/** Longer than any call; released at its end. A bound so a lock is never held for ever. */
private const val PROXIMITY_MAX_MS = 4 * 60 * 60 * 1000L
