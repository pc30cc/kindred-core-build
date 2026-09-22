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
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Call
import androidx.compose.material.icons.filled.Check
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
import com.webyar.operator.ui.components.PrimaryButton
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
 * The one line under the name.
 *
 * A timer once connected, counting from when the two sides actually met —
 * not from when the invitation went out. An operator reading "04:12" on a
 * call that connected thirty seconds ago would rightly distrust the number.
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

    Text(
        text,
        style = MaterialTheme.typography.titleMedium,
        color = Color.White.copy(alpha = 0.75f),
        textAlign = TextAlign.Center,
        modifier = Modifier.fillMaxWidth().testTag(A11y.CALL_STATUS),
    )
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
    Column(
        Modifier.padding(bottom = Space.xl),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(Space.lg),
    ) {
        if (phase.isLive) {
            Row(horizontalArrangement = Arrangement.spacedBy(Space.lg)) {
                CallToggle(
                    icon = Glyph.Mic,
                    label = Str.mute(language),
                    tag = A11y.CALL_MUTE,
                    // The button shows the STATE, not the action: lit means
                    // the microphone is on. A muted call whose mute button
                    // looks pressed is the one thing nobody misreads.
                    on = !muted,
                    onClick = onToggleMute,
                )
                if (channel == CallChannel.VIDEO) {
                    CallToggle(
                        icon = Icons.Filled.Check,
                        label = Str.camera(language),
                        tag = A11y.CALL_CAMERA,
                        on = cameraOn,
                        onClick = onToggleCamera,
                    )
                }
                CallToggle(
                    icon = Icons.Filled.Call,
                    label = Str.speaker(language),
                    tag = A11y.CALL_SPEAKER,
                    on = speakerOn,
                    onClick = onToggleSpeaker,
                )
            }
        }

        PrimaryButton(
            label = if (phase.isLive) Str.hangUpCall(language) else Str.done(language),
            onClick = if (phase.isLive) onHangUp else onDone,
            modifier = Modifier.fillMaxWidth().testTag(A11y.CALL_HANG_UP),
        )
    }
}

@Composable
private fun CallToggle(
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    label: String,
    tag: String,
    on: Boolean,
    onClick: () -> Unit,
) {
    Surface(
        color = if (on) Color.White.copy(alpha = 0.22f) else Color.White.copy(alpha = 0.08f),
        contentColor = if (on) Color.White else Color.White.copy(alpha = 0.45f),
        shape = CircleShape,
        onClick = onClick,
        modifier = Modifier.size(Size.minTouchTarget + 8.dp).testTag(tag),
    ) {
        Box(contentAlignment = Alignment.Center) {
            Icon(icon, contentDescription = label, modifier = Modifier.size(22.dp))
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
