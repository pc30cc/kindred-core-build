package com.platform.app.feature.call

import android.os.Handler
import android.os.Looper
import android.util.Rational
import androidx.compose.foundation.border
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.absoluteOffset
import androidx.compose.ui.AbsoluteAlignment
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import com.platform.app.i18n.Format
import com.platform.app.i18n.Language
import com.platform.app.i18n.Str
import com.platform.app.i18n.StrAndroid
import com.platform.app.ui.A11y
import com.platform.app.ui.components.Glyph
import com.platform.app.ui.design.Space
import io.livekit.android.room.track.VideoTrack
import kotlinx.coroutines.delay
import java.time.Instant
import kotlin.math.roundToInt
import androidx.compose.runtime.setValue
import androidx.compose.runtime.getValue

/**
 * The call in the system's picture-in-picture window, while the member uses
 * another app: the other side's picture edge to edge on a video call; on a
 * voice call (or with their camera off) their face, their name and the
 * timer. Nothing else — the window is small, and its own controls (mute,
 * hang up: [com.platform.app.MainActivity]'s `RemoteAction`s) are the
 * system's. Tapping the window brings the whole call back.
 */
@Composable
fun PipCallView(call: ActiveCall, language: Language, modifier: Modifier = Modifier) {
    val state by call.state.collectAsState()
    val identity by call.identity.collectAsState()
    val remote by rememberRemoteVideo(call).collectAsState()
    val room = call.room
    val picture = remote?.takeIf { state.video }
    if (picture != null && room != null) {
        Box(modifier.fillMaxSize().testTag(A11y.CALL_PIP)) {
            CallBackdrop()
            // A visitor's browser sends its camera mirrored; a colleague's
            // phone does not (see the two call screens).
            VideoView(picture, room, Modifier.fillMaxSize(), mirror = !call.colleague)
            if (state.muted) MutedBadge(Modifier.align(Alignment.BottomStart).padding(Space.sm))
        }
    } else {
        PipVoiceContent(call.colleague, identity, state, language, modifier)
    }
}

/** The window of a voice call, or of a video call with no picture: the face, the name, the timer. */
@Composable
internal fun PipVoiceContent(
    colleague: Boolean,
    identity: ActiveCallIdentity,
    state: ActiveCallState,
    language: Language,
    modifier: Modifier = Modifier,
) {
    Box(modifier.fillMaxSize().testTag(A11y.CALL_PIP), contentAlignment = Alignment.Center) {
        CallBackdrop(glowAt = 0.38f)
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(Space.xs),
            modifier = Modifier.padding(Space.sm),
        ) {
            CallFace(colleague, identity.name, identity.avatarUrl, size = 52.dp, visitor = identity.visitor)
            Text(
                identity.name,
                style = MaterialTheme.typography.labelLarge,
                color = Color.White,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                textAlign = TextAlign.Center,
            )
            CallClock(state, language, color = Color.White.copy(alpha = 0.75f))
        }
        if (state.muted) MutedBadge(Modifier.align(Alignment.BottomStart).padding(Space.sm))
    }
}

/**
 * The call, small, over the rest of the app while its screen is minimised:
 * a card in a corner, the other side's picture or their face with the
 * timer, which the member drags anywhere and taps to open the call again.
 */
@Composable
fun FloatingCallBubble(call: ActiveCall, language: Language, onOpen: () -> Unit, modifier: Modifier = Modifier) {
    val state by call.state.collectAsState()
    val identity by call.identity.collectAsState()
    val remote by rememberRemoteVideo(call).collectAsState()
    val room = call.room
    val picture = remote?.takeIf { state.video && state.stage == ActiveCallStage.LIVE && room != null }
    val width = if (picture != null) 112.dp else 96.dp
    val height = if (picture != null) 152.dp else 120.dp
    val rtl = LocalLayoutDirection.current == LayoutDirection.Rtl
    // Screen coordinates, left to right, whatever the layout direction: a
    // drag's x is the finger's, so the offset must be too (a Persian layout
    // would otherwise move the bubble against the finger).
    BoxWithConstraints(
        modifier.fillMaxSize().statusBarsPadding().navigationBarsPadding().padding(Space.md),
        contentAlignment = AbsoluteAlignment.TopLeft,
    ) {
        val density = LocalDensity.current
        val maxX = with(density) { (maxWidth - width).toPx().coerceAtLeast(0f) }
        val maxY = with(density) { (maxHeight - height).toPx().coerceAtLeast(0f) }
        // Starts at the top on the end side (the right in English, the left
        // in Persian), out of the way of a list's first rows and the back
        // arrow; stays where it is dropped.
        var x by remember { mutableFloatStateOf(Float.NaN) }
        var y by remember { mutableFloatStateOf(with(density) { 56.dp.toPx() }) }
        if (x.isNaN()) x = if (rtl) 0f else maxX
        val label = StrAndroid.callReturn(language)
        Surface(
            shape = RoundedCornerShape(20.dp),
            color = CALL_BACKGROUND,
            contentColor = Color.White,
            modifier = Modifier
                .absoluteOffset { IntOffset(x.coerceIn(0f, maxX).roundToInt(), y.coerceIn(0f, maxY).roundToInt()) }
                .size(width, height)
                .shadow(12.dp, RoundedCornerShape(20.dp))
                .pointerInput(maxX, maxY) {
                    detectDragGestures { change, drag ->
                        change.consume()
                        x = (x + drag.x).coerceIn(0f, maxX)
                        y = (y + drag.y).coerceIn(0f, maxY)
                    }
                }
                .border(1.dp, Color.White.copy(alpha = 0.18f), RoundedCornerShape(20.dp))
                .semantics { contentDescription = label + ", " + identity.name }
                .testTag(A11y.CALL_BUBBLE),
            onClick = onOpen,
        ) {
            Box(contentAlignment = Alignment.Center) {
                CallBackdrop(glowAt = 0.4f)
                if (picture != null && room != null) {
                    VideoView(picture, room, Modifier.fillMaxSize().clip(RoundedCornerShape(20.dp)), mirror = !call.colleague)
                    Box(Modifier.fillMaxSize().padding(bottom = Space.xs), contentAlignment = Alignment.BottomCenter) {
                        CallClock(state, language, color = Color.White)
                    }
                } else {
                    Column(
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.spacedBy(Space.sm),
                    ) {
                        CallHalo(ringing = state.stage != ActiveCallStage.LIVE, faceSize = 44.dp) {
                            CallFace(call.colleague, identity.name, identity.avatarUrl, size = 44.dp, visitor = identity.visitor)
                        }
                        CallClock(state, language, color = Color.White.copy(alpha = 0.85f))
                    }
                }
                if (state.muted) MutedBadge(Modifier.align(Alignment.TopStart).padding(Space.xs))
            }
        }
    }
}

/** The other side's picture, as a flow whether or not the call has a room. */
@Composable
internal fun rememberRemoteVideo(call: ActiveCall?): kotlinx.coroutines.flow.StateFlow<VideoTrack?> =
    remember(call) { call?.room?.remoteVideo ?: kotlinx.coroutines.flow.MutableStateFlow(null) }

/** The timer once both are on the line; "Calling…" or "Connecting…" before. */
@Composable
internal fun CallClock(state: ActiveCallState, language: Language, color: Color) {
    val text = when (state.stage) {
        ActiveCallStage.LIVE -> {
            val since = state.since
            var now by remember { mutableStateOf(Instant.now()) }
            LaunchedEffect(since) {
                while (true) {
                    now = Instant.now()
                    delay(1_000)
                }
            }
            Format.callDuration(since ?: now, now, language)
        }
        ActiveCallStage.CONNECTING -> Str.teamCallConnecting(language)
        ActiveCallStage.OVER -> Str.teamCallEnded(language)
        ActiveCallStage.RINGING_OUT -> Str.teamCallRinging(language)
        ActiveCallStage.OUTGOING, ActiveCallStage.RINGING_HERE -> Str.teamCallCalling(language)
    }
    Text(
        text,
        style = MaterialTheme.typography.labelMedium.copy(fontFeatureSettings = "tnum"),
        color = color,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
        textAlign = TextAlign.Center,
    )
}

@Composable
private fun MutedBadge(modifier: Modifier = Modifier) {
    Box(
        modifier
            .size(22.dp)
            .clip(CircleShape)
            .border(1.dp, Color.White.copy(alpha = 0.3f), CircleShape),
        contentAlignment = Alignment.Center,
    ) {
        Surface(color = CALL_END_RED, shape = CircleShape, modifier = Modifier.fillMaxSize()) {
            Box(contentAlignment = Alignment.Center) {
                Icon(Glyph.MicOff, contentDescription = null, tint = Color.White, modifier = Modifier.size(14.dp))
            }
        }
    }
}

/**
 * The shape of the picture [track] carries, for the picture-in-picture
 * window to take it: null until a frame arrives, or for no track. Read from
 * the frames themselves by a sink that keeps nothing of them.
 */
@Composable
fun rememberVideoAspect(track: VideoTrack?): Rational? {
    var aspect by remember(track) { mutableStateOf<Rational?>(null) }
    DisposableEffect(track) {
        if (track == null) return@DisposableEffect onDispose { }
        val main = Handler(Looper.getMainLooper())
        var lastWidth = 0
        var lastHeight = 0
        val sink = livekit.org.webrtc.VideoSink { frame ->
            val w = frame.rotatedWidth
            val h = frame.rotatedHeight
            if (w > 0 && h > 0 && (w != lastWidth || h != lastHeight)) {
                lastWidth = w
                lastHeight = h
                main.post { aspect = pipAspect(w, h) }
            }
        }
        track.addRenderer(sink)
        onDispose {
            track.removeRenderer(sink)
            main.removeCallbacksAndMessages(null)
        }
    }
    return aspect
}

/**
 * [width] by [height] as the system's picture-in-picture accepts it: between
 * 1 : 2.39 and 2.39 : 1 — a shape outside that is refused with an exception.
 */
fun pipAspect(width: Int, height: Int): Rational {
    if (width <= 0 || height <= 0) return VOICE_PIP_ASPECT
    val ratio = (width.toDouble() / height).coerceIn(PIP_MIN_RATIO, PIP_MAX_RATIO)
    return Rational((ratio * 1000).roundToInt(), 1000)
}

/** A voice call's window: a little taller than wide, for a face, a name and a timer. */
val VOICE_PIP_ASPECT = Rational(3, 4)

private const val PIP_MIN_RATIO = 1 / 2.38
private const val PIP_MAX_RATIO = 2.38
