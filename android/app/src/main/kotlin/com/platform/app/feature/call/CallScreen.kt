package com.platform.app.feature.call

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.scaleIn
import androidx.compose.animation.scaleOut
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.widthIn
import androidx.compose.material.icons.filled.Check
import androidx.compose.material3.LocalContentColor
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.boundsInRoot
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.platform.app.core.model.CallChannel
import com.platform.app.core.model.VisitorProfile
import com.platform.app.i18n.Format
import com.platform.app.i18n.Language
import com.platform.app.i18n.Str
import com.platform.app.i18n.StrAndroid
import com.platform.app.ui.A11y
import com.platform.app.ui.components.Avatar
import com.platform.app.ui.components.Glyph
import com.platform.app.ui.design.Motion
import com.platform.app.ui.design.Radius
import com.platform.app.ui.design.Size
import com.platform.app.ui.design.Space
import com.platform.app.ui.design.AppTheme
import io.livekit.android.room.track.VideoTrack
import java.time.Instant
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.ui.graphics.graphicsLayer
import com.platform.app.ui.components.percentShape
import com.platform.app.ui.design.ExpressiveShapes
import com.platform.app.ui.design.PolygonShape
import com.platform.app.ui.design.AppType
import com.platform.app.ui.components.rememberLoop

/**
 * The call, from "ringing their browser" to "over".
 *
 * One screen for all four phases rather than four screens, because they are
 * one event: the identity block stays where it is and the things around it
 * change. An operator watching a call connect should not watch the person's
 * name jump across the screen as it does.
 */
@Composable
fun CallScreen(
    phase: CallPhase,
    channel: CallChannel,
    contactName: String,
    language: Language,
    modifier: Modifier = Modifier,
    contactAvatarUrl: String? = null,
    visitor: VisitorProfile? = null,
    connectedAt: Instant? = null,
    muted: Boolean = false,
    cameraOn: Boolean = false,
    speakerOn: Boolean = true,
    relayWarning: Boolean = false,
    degraded: CallDegradation? = null,
    remoteVideo: VideoTrack? = null,
    localVideo: VideoTrack? = null,
    room: LiveKitRoom? = null,
    onToggleMute: () -> Unit = {},
    onToggleCamera: () -> Unit = {},
    onToggleSpeaker: () -> Unit = {},
    onHangUp: () -> Unit = {},
    onDone: () -> Unit = {},
    onAnswer: () -> Unit = {},
    onDecline: () -> Unit = {},
    /** Keeps the call going in a small window over the rest of the app. Null: not offered. */
    onMinimise: (() -> Unit)? = null,
) {
    // Awake for as long as the call is on, and not a moment longer.
    //
    // The call is a desk call on the loudspeaker, so nobody touches the glass
    // while it runs — and when the screen times out, the app goes to the
    // background and Android (9 and later) hands it silence for a
    // microphone and no camera: the visitor goes on talking to a phone that
    // has quietly stopped sending. The screen staying lit is what keeps the
    // app in front for the length of the call. From the moment there is a
    // call to connect: a ring that nobody has answered holds no microphone,
    // and one whose cancel never arrived must not keep a locked phone lit.
    val view = LocalView.current
    val awake = phase.isLive && phase != CallPhase.Ringing
    DisposableEffect(view, awake) {
        if (awake) view.keepScreenOn = true
        onDispose { if (awake) view.keepScreenOn = false }
    }

    Box(
        // Its own dark backdrop whatever the theme is doing, opaque edge to
        // edge — on the lock screen too. A call is a full-screen moment, and
        // nothing behind it (the inbox, a chat) may show through.
        modifier
            .fillMaxSize()
            .background(CALL_BACKGROUND)
            .testTag(A11y.CALL_SCREEN),
    ) {
        // Where the name and the timer end and the buttons begin, from the top
        // of the screen: the operator's own picture floats between the two.
        var screenTop by remember { mutableFloatStateOf(0f) }
        var headerBottom by remember { mutableFloatStateOf(0f) }
        var controlsTop by remember { mutableFloatStateOf(Float.MAX_VALUE) }
        // The operator's own picture while their camera gives one. A tap on
        // the small picture swaps it with the visitor's; the swap ends with it.
        val own = localVideo?.takeIf { room != null && cameraOn }
        var swapped by rememberStageSwap(own)
        val stage = CallStage.of(
            remote = remoteVideo?.takeIf { room != null },
            // Flipped once, as the console (src/index.css, "Call video
            // orientation") and the Mac app flip every call video: the
            // visitor's camera arrives mirrored, and unflipped they are shown
            // to the operator the wrong way round. In the card too.
            remoteMirror = true,
            own = own,
            // The front camera, the only one this call uses: its own preview
            // is a mirror, full screen or small.
            ownMirror = true,
            swapped = swapped,
        )
        CompositionLocalProvider(LocalContentColor provides Color.White) {
            BoxWithConstraints(Modifier.fillMaxSize().onGloballyPositioned { screenTop = it.boundsInRoot().top }) {
                val faceSize = callFaceSize(maxHeight, incoming = phase == CallPhase.Ringing)
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
                    CallTopBar(language, onMinimise = onMinimise?.takeIf { phase.isLive && phase != CallPhase.Ringing })
                    Column(
                        Modifier.onGloballyPositioned { headerBottom = it.boundsInRoot().bottom },
                        horizontalAlignment = Alignment.CenterHorizontally,
                    ) {
                        Identity(
                            phase = phase,
                            contactName = contactName,
                            contactAvatarUrl = contactAvatarUrl,
                            visitor = visitor,
                            connectedAt = connectedAt,
                            language = language,
                            // The face is redundant once a picture fills the screen,
                            // and a circle over a video window is just something in
                            // the way.
                            compact = stage.big != null,
                            video = channel == CallChannel.VIDEO,
                            faceSize = faceSize,
                        )

                        if (relayWarning) Notice(Str.callRelayWarning(language))
                        degraded?.let { Notice(it.title(language)) }
                    }

                    Spacer(Modifier.weight(1f))

                    Box(Modifier.onGloballyPositioned { controlsTop = it.boundsInRoot().top }) {
                        Controls(
                            phase = phase,
                            channel = channel,
                            language = language,
                            muted = muted,
                            cameraOn = cameraOn,
                            speakerOn = speakerOn,
                            onToggleMute = onToggleMute,
                            onToggleCamera = onToggleCamera,
                            onToggleSpeaker = onToggleSpeaker,
                            onHangUp = onHangUp,
                            onDone = onDone,
                            onAnswer = onAnswer,
                            onDecline = onDecline,
                        )
                    }
                }

                // Only once the name and the buttons have been measured, so it
                // appears in its corner rather than sliding there from the top.
                if (room != null && stage.hasCard && controlsTop != Float.MAX_VALUE) {
                    // Over everything but where the buttons are: tap it to swap
                    // the pictures, drag it to any corner, pinch or double-tap to
                    // size it.
                    SelfView(
                        areaTop = headerBottom - screenTop,
                        areaBottom = controlsTop - screenTop,
                        language = language,
                        swapped = stage.swapped,
                        onSwap = { swapped = !swapped },
                    ) {
                        // Swapped with their camera off: the visitor's face as the
                        // header draws it — their photo or their device's mark.
                        StageCardContent(stage.small, room) { size ->
                            CallFace(colleague = false, name = contactName, avatarUrl = contactAvatarUrl, size = size, visitor = visitor)
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun Identity(
    phase: CallPhase,
    contactName: String,
    contactAvatarUrl: String?,
    visitor: VisitorProfile?,
    connectedAt: Instant?,
    language: Language,
    compact: Boolean,
    video: Boolean,
    faceSize: androidx.compose.ui.unit.Dp,
) {
    Column(
        Modifier.padding(top = if (compact) Space.sm else Space.lg),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(Space.md),
    ) {
        AnimatedVisibility(
            visible = !compact,
            enter = fadeIn() + scaleIn(initialScale = 0.9f),
            exit = fadeOut() + scaleOut(targetScale = 0.9f),
        ) {
            CallHalo(
                ringing = phase == CallPhase.Ringing || phase == CallPhase.Waiting || phase == CallPhase.Connecting,
                faceSize = faceSize,
            ) {
                CallFace(colleague = false, name = contactName, avatarUrl = contactAvatarUrl, size = faceSize, visitor = visitor)
            }
        }

        Text(
            contactName,
            style = if (compact) MaterialTheme.typography.titleLarge else AppType.headlineMediumEmphasized,
            textAlign = TextAlign.Center,
            maxLines = 2,
            overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis,
            modifier = Modifier.fillMaxWidth(),
        )

        Status(phase, connectedAt, language, video)
    }
}

/**
 * The line (or two) under the name.
 *
 * A timer once connected, counting from when the two sides actually met —
 * not from when the invitation went out. An operator reading "04:12" on a
 * call that connected thirty seconds ago would rightly distrust the number.
 *
 * A failure gets a second line saying what the server actually said, from the
 * reason the session carries. Without it a 403 and an unreachable network
 * both read "the call could not connect" — one sentence that sends an
 * operator to check their signal while the server is telling them something
 * precise. It is the only surface a failed call has: unlike the console there
 * is no alert behind it to say more.
 */
@Composable
private fun Status(phase: CallPhase, connectedAt: Instant?, language: Language, video: Boolean) {
    val text = when (phase) {
        CallPhase.Ringing -> StrAndroid.incomingCall(language, video)
        CallPhase.Waiting -> Str.inviteSent(language)
        CallPhase.Connecting -> Str.connectingCall(language)
        CallPhase.Connected -> {
            var now by remember { mutableStateOf(Instant.now()) }
            LaunchedEffect(connectedAt) {
                while (true) {
                    now = Instant.now()
                    kotlinx.coroutines.delay(1_000)
                }
            }
            connectedAt?.let { Format.callDuration(it, now, language) }
                ?: Format.callDuration(now, now, language)
        }
        is CallPhase.Ended -> phase.outcome.title(language)
    }

    val reason = ((phase as? CallPhase.Ended)?.outcome as? CallOutcome.Failed)
        ?.reason
        ?.takeIf { it.isNotBlank() }

    Column(
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(Space.xs),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Text(
            text,
            style = MaterialTheme.typography.titleMedium.copy(fontFeatureSettings = "tnum"),
            color = Color.White.copy(alpha = 0.80f),
            textAlign = TextAlign.Center,
            modifier = Modifier.fillMaxWidth().testTag(A11y.CALL_STATUS),
        )
        if (reason != null) {
            Text(
                reason,
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

/** Something the operator should know but does not have to act on. */
@Composable
internal fun Notice(text: String) {
    Surface(
        color = Color.White.copy(alpha = 0.12f),
        contentColor = Color.White,
        shape = RoundedCornerShape(Radius.md),
        modifier = Modifier.padding(top = Space.md),
    ) {
        Text(
            text,
            style = MaterialTheme.typography.labelMedium,
            textAlign = TextAlign.Center,
            modifier = Modifier.padding(horizontal = Space.md, vertical = Space.sm),
        )
    }
}

@Composable
private fun Controls(
    phase: CallPhase,
    channel: CallChannel,
    language: Language,
    muted: Boolean,
    cameraOn: Boolean,
    speakerOn: Boolean,
    onToggleMute: () -> Unit,
    onToggleCamera: () -> Unit,
    onToggleSpeaker: () -> Unit,
    onHangUp: () -> Unit,
    onDone: () -> Unit,
    onAnswer: () -> Unit,
    onDecline: () -> Unit,
) {
    if (phase == CallPhase.Ringing) {
        IncomingCallActions(
            language = language,
            video = channel == CallChannel.VIDEO,
            declineLabel = StrAndroid.declineCall(language),
            answerLabel = StrAndroid.answerCall(language),
            onDecline = onDecline,
            onAnswer = onAnswer,
        )
        return
    }
    Column(
        Modifier.fillMaxWidth().padding(bottom = Space.xl),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(Space.xl),
    ) {
        if (phase.isLive) {
            Row(
                Modifier.fillMaxWidth().widthIn(max = 420.dp),
                horizontalArrangement = Arrangement.SpaceEvenly,
                verticalAlignment = Alignment.Top,
            ) {
                // Both states are drawn, never one shape lit and unlit. On a black
                // screen with nothing beside it to compare against, "highlighted"
                // is not a thing anyone can read, and reading the mute button
                // wrong means talking to nobody.
                CallToggle(
                    icon = if (muted) Glyph.MicOff else Glyph.Mic,
                    label = Str.mute(language),
                    tag = A11y.CALL_MUTE,
                    on = muted,
                    // Nothing to mute until there is somebody on the line. The
                    // controls are drawn while the invitation rings so the screen
                    // does not rearrange itself the instant it is answered.
                    enabled = phase == CallPhase.Connected,
                    onClick = onToggleMute,
                )

                // One or the other, never both — the console and the iOS screen
                // agree on this. A video call is on the loudspeaker by its nature
                // and spends its second button on the camera instead.
                if (channel == CallChannel.VIDEO) {
                    CallToggle(
                        icon = if (cameraOn) Glyph.Videocam else Glyph.VideocamOff,
                        label = Str.camera(language),
                        tag = A11y.CALL_CAMERA,
                        on = !cameraOn,
                        enabled = phase == CallPhase.Connected,
                        onClick = onToggleCamera,
                    )
                } else {
                    CallToggle(
                        icon = if (speakerOn) Glyph.Speaker else Glyph.SpeakerOff,
                        label = Str.speaker(language),
                        tag = A11y.CALL_SPEAKER,
                        on = speakerOn,
                        enabled = phase == CallPhase.Connected,
                        onClick = onToggleSpeaker,
                    )
                }
            }
        }

        // Red, round, and larger than the toggles when it ends a call; a quiet
        // "Done" closing a finished one — it is the only way off this screen
        // either way. Never a full-width blue bar, which is what a phone uses
        // to ANSWER.
        CallToggle(
            icon = if (phase.isLive) Glyph.CallEnd else androidx.compose.material.icons.Icons.Filled.Check,
            label = if (phase.isLive) Str.hangUpCall(language) else Str.done(language),
            tag = A11y.CALL_HANG_UP,
            on = true,
            tint = if (phase.isLive) CALL_END_RED else CALL_DONE_GREY,
            onClick = if (phase.isLive) onHangUp else onDone,
            diameter = PRIMARY_SIZE,
        )
    }
}

/**
 * Near-black, and fixed.
 *
 * Not from the theme: a call is the one screen that looks the same in light
 * mode and dark, the way every phone's own dialler does.
 */
internal val CALL_BACKGROUND = Color(0xFF111418)

/**
 * The red under "end call", fixed for the same reason as the background.
 *
 * iOS uses `systemRed` here; this is its dark-mode value, which is the one
 * that belongs on a near-black screen.
 */
internal val CALL_END_RED = Color(0xFFFF453A)

/** The green under "answer": iOS's `systemGreen`, dark-mode value, for the same reason. */
internal val CALL_ANSWER_GREEN = Color(0xFF30D158)
