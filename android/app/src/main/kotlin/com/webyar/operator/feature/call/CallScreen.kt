package com.webyar.operator.feature.call

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
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.webyar.operator.core.model.CallChannel
import com.webyar.operator.core.model.VisitorProfile
import com.webyar.operator.i18n.Format
import com.webyar.operator.i18n.Language
import com.webyar.operator.i18n.Str
import com.webyar.operator.ui.A11y
import com.webyar.operator.ui.components.Avatar
import com.webyar.operator.ui.components.Glyph
import com.webyar.operator.ui.design.Motion
import com.webyar.operator.ui.design.Radius
import com.webyar.operator.ui.design.Size
import com.webyar.operator.ui.design.Space
import com.webyar.operator.ui.design.WebyarTheme
import io.livekit.android.room.track.VideoTrack
import java.time.Instant

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
) {
    Surface(
        // Its own dark surface whatever the theme is doing. A call is a
        // full-screen moment and a white one behind a video window reads as a
        // bug on every phone.
        color = CALL_BACKGROUND,
        contentColor = Color.White,
        modifier = modifier.fillMaxSize().testTag(A11y.CALL_SCREEN),
    ) {
        Box(Modifier.fillMaxSize()) {
            if (remoteVideo != null && room != null) {
                VideoView(remoteVideo, room, Modifier.fillMaxSize())
            }

            Column(
                Modifier
                    .fillMaxSize()
                    .statusBarsPadding()
                    .navigationBarsPadding()
                    .padding(horizontal = Space.screenInset),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Identity(
                    phase = phase,
                    contactName = contactName,
                    contactAvatarUrl = contactAvatarUrl,
                    visitor = visitor,
                    connectedAt = connectedAt,
                    language = language,
                    // The face is redundant once their picture is on screen,
                    // and a circle over a video window is just something in
                    // the way.
                    compact = remoteVideo != null,
                )

                if (relayWarning) Notice(Str.callRelayWarning(language))
                degraded?.let { Notice(it.title(language)) }

                Box(Modifier.weight(1f), contentAlignment = Alignment.BottomEnd) {
                    if (localVideo != null && room != null && cameraOn) {
                        // Our own picture, in a card over theirs. Mirrored,
                        // because a front camera that is not reads as somebody
                        // else's face doing the wrong thing.
                        Surface(
                            shape = RoundedCornerShape(Radius.lg),
                            color = Color.Black,
                            modifier = Modifier
                                .padding(bottom = Space.lg)
                                .width(110.dp)
                                .aspectRatio(3f / 4f)
                                .clip(RoundedCornerShape(Radius.lg)),
                        ) {
                            VideoView(localVideo, room, Modifier.fillMaxSize(), mirror = true)
                        }
                    }
                }

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
                )
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
) {
    Column(
        Modifier.padding(top = Space.xl),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(Space.md),
    ) {
        if (!compact) {
            // The ring pulses while it rings, so the wait does not look like
            // a frozen screen.
            val pulsing = phase == CallPhase.Waiting
            val transition = rememberInfiniteTransition(label = "ring")
            val alpha by transition.animateFloat(
                initialValue = if (pulsing) 0.35f else 1f,
                targetValue = 1f,
                animationSpec = infiniteRepeatable(
                    animation = tween(Motion.skeletonPulse),
                    repeatMode = RepeatMode.Reverse,
                ),
                label = "ring.alpha",
            )
            Box(
                Modifier
                    .size(Size.avatarLarge + 16.dp)
                    .alpha(if (pulsing) alpha else 1f)
                    .background(Color.White.copy(alpha = 0.12f), CircleShape),
                contentAlignment = Alignment.Center,
            ) {
                Avatar(
                    name = contactName,
                    imageUrl = contactAvatarUrl,
                    size = Size.avatarLarge,
                    os = visitor?.device?.os,
                    device = visitor?.device?.device,
                    countryCode = visitor?.geo?.countryCode,
                )
            }
        }

        Text(
            contactName,
            style = MaterialTheme.typography.headlineSmall,
            fontWeight = FontWeight.SemiBold,
            textAlign = TextAlign.Center,
            modifier = Modifier.fillMaxWidth(),
        )

        Status(phase, connectedAt, language)
    }
}

/**
 * The line (or two) under the name.
 *
 * A timer once connected, counting from when the two sides actually met —
 * not from when the invitation went out. An operator reading "04:12" on a
 * call that connected thirty seconds ago would rightly distrust the number.
 *
 * A failure gets a second line saying what the server actually said. The
 * session has always carried that reason and the screen used to drop it, so
 * a 403 and an unreachable network both read "the call could not connect" —
 * one sentence that sends an operator to check their signal while the server
 * is telling them something precise. It is the only surface a failed call
 * has: unlike the console there is no alert behind it to say more.
 */
@Composable
private fun Status(phase: CallPhase, connectedAt: Instant?, language: Language) {
    val text = when (phase) {
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
            style = MaterialTheme.typography.titleMedium,
            color = Color.White.copy(alpha = 0.75f),
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
private fun Notice(text: String) {
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
) {
    Row(
        Modifier.padding(bottom = Space.xl),
        horizontalArrangement = Arrangement.spacedBy(Space.xl),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (phase.isLive) {
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

        // Red, round, and the same button whether it ends a call or closes a
        // finished one — it is the only way off this screen either way. It
        // used to be a full-width blue bar, which is what a phone uses to
        // ANSWER.
        CallToggle(
            icon = Glyph.CallEnd,
            label = if (phase.isLive) Str.hangUpCall(language) else Str.done(language),
            tag = A11y.CALL_HANG_UP,
            on = true,
            tint = CALL_END_RED,
            onClick = if (phase.isLive) onHangUp else onDone,
        )
    }
}

/**
 * One round button in the row under the call.
 *
 * [on] is the lit state and [tint] the colour it lights up in — white for a
 * toggle, red for the one that ends the call. A disabled button keeps its
 * shape and loses its contrast, so the row does not change length at the
 * moment a call connects.
 */
@Composable
private fun CallToggle(
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    label: String,
    tag: String,
    on: Boolean,
    onClick: () -> Unit,
    enabled: Boolean = true,
    tint: Color? = null,
) {
    val lit = tint ?: Color.White
    Surface(
        color = when {
            !enabled -> Color.White.copy(alpha = 0.06f)
            on -> lit.copy(alpha = if (tint == null) 0.22f else 1f)
            else -> Color.White.copy(alpha = 0.10f)
        },
        contentColor = when {
            !enabled -> Color.White.copy(alpha = 0.25f)
            tint != null -> Color.White
            on -> Color.White
            else -> Color.White.copy(alpha = 0.75f)
        },
        shape = CircleShape,
        enabled = enabled,
        onClick = onClick,
        modifier = Modifier
            .size(Size.minTouchTarget + 8.dp)
            .semantics { if (on) selected = true }
            .testTag(tag),
    ) {
        Box(contentAlignment = Alignment.Center) {
            Icon(icon, contentDescription = label, modifier = Modifier.size(24.dp))
        }
    }
}

/**
 * Near-black, and fixed.
 *
 * Not from the theme: a call is the one screen that looks the same in light
 * mode and dark, the way every phone's own dialler does.
 */
private val CALL_BACKGROUND = Color(0xFF111418)

/**
 * The red under "end call", fixed for the same reason as the background.
 *
 * iOS uses `systemRed` here; this is its dark-mode value, which is the one
 * that belongs on a near-black screen.
 */
private val CALL_END_RED = Color(0xFFFF453A)
