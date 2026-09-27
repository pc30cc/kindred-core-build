package com.webyar.operator.feature.call

import android.content.Context
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.VectorConverter
import androidx.compose.animation.core.spring
import androidx.compose.foundation.border
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.calculatePan
import androidx.compose.foundation.gestures.calculateZoom
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.positionChanged
import androidx.compose.ui.input.pointer.util.VelocityTracker
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import com.webyar.operator.i18n.Language
import com.webyar.operator.i18n.StrAndroid
import com.webyar.operator.ui.A11y
import io.livekit.android.room.track.VideoTrack
import kotlinx.coroutines.launch
import kotlin.math.roundToInt

/**
 * Which corner the operator's own picture sits in. Absolute — left and right
 * as the screen has them, not start and end — because it is a place on the
 * glass the operator put it, and a Persian layout must not move it across.
 */
data class SelfViewCorner(val left: Boolean, val top: Boolean) {
    /** The next corner round the screen, for the accessibility action. */
    fun next(): SelfViewCorner = when {
        top && !left -> SelfViewCorner(left = false, top = false)
        !top && !left -> SelfViewCorner(left = true, top = false)
        !top && left -> SelfViewCorner(left = true, top = true)
        else -> SelfViewCorner(left = false, top = true)
    }

    companion object {
        /** Bottom right, above the buttons: out of the name's way. */
        val DEFAULT = SelfViewCorner(left = false, top = false)

        /** The corner whose quarter of [area] the point lies in. */
        fun nearest(x: Float, y: Float, areaWidth: Float, areaTop: Float, areaBottom: Float): SelfViewCorner =
            SelfViewCorner(left = x < areaWidth / 2f, top = y < (areaTop + areaBottom) / 2f)
    }
}

/** How wide the operator's own picture is, in dp; it is always 3:4. */
object SelfViewSize {
    const val MIN = 64f
    const val DEFAULT = 108f
    const val MAX = 176f

    /** The double-tap steps: small, as it opens, large, and round again. */
    private val STEPS = listOf(76f, DEFAULT, 150f)

    fun next(width: Float): Float = STEPS.firstOrNull { it > width + 1f } ?: STEPS.first()

    fun clamp(width: Float): Float = width.coerceIn(MIN, MAX)
}

/**
 * Where the picture was left, so the next call opens it there. Kept on the
 * phone only — it is how this operator likes their screen, not an account
 * setting, and nothing in it is private.
 */
internal class SelfViewPlacement(context: Context) {
    private val prefs = context.applicationContext.getSharedPreferences("call_self_view", Context.MODE_PRIVATE)

    var corner: SelfViewCorner
        get() = SelfViewCorner(prefs.getBoolean(KEY_LEFT, false), prefs.getBoolean(KEY_TOP, false))
        set(value) {
            prefs.edit().putBoolean(KEY_LEFT, value.left).putBoolean(KEY_TOP, value.top).apply()
        }

    var width: Float
        get() = SelfViewSize.clamp(prefs.getFloat(KEY_WIDTH, SelfViewSize.DEFAULT))
        set(value) {
            prefs.edit().putFloat(KEY_WIDTH, value).apply()
        }

    private companion object {
        const val KEY_LEFT = "left"
        const val KEY_TOP = "top"
        const val KEY_WIDTH = "width"
    }
}

/**
 * The operator's own camera, floating over the call — the picture-in-picture
 * every video call app has.
 *
 * - **Drag** it anywhere; let go and it settles into the nearest corner (a
 *   flick carries it towards the corner it was thrown at).
 * - **Pinch** to make it smaller or larger, down to a thumbnail.
 * - **Double-tap** steps it small → normal → large.
 *
 * It keeps between [areaTop] and [areaBottom] (pixels from the top of the
 * call screen): below the name and the timer, above the buttons, so it never
 * sits on either. Mirrored, because a front camera that is not reads as
 * somebody else's face doing the wrong thing.
 */
@Composable
fun SelfView(
    track: VideoTrack,
    room: LiveKitRoom,
    areaTop: Float,
    areaBottom: Float,
    language: Language,
    modifier: Modifier = Modifier,
) {
    val context = LocalContext.current
    val placement = remember(context) { SelfViewPlacement(context) }
    var corner by remember { mutableStateOf(placement.corner) }
    var widthDp by remember { mutableFloatStateOf(placement.width) }
    val scope = rememberCoroutineScope()

    BoxWithConstraints(modifier.fillMaxSize()) {
        val density = LocalDensity.current
        val margin = with(density) { 12.dp.toPx() }
        val areaWidth = constraints.maxWidth.toFloat()
        val w = with(density) { widthDp.dp.toPx() }
        val h = w * 4f / 3f
        val top = areaTop + margin
        // Room for the picture even when the buttons leave little: it may
        // then overlap the name rather than vanish.
        val bottom = maxOf(areaBottom - margin, top + h)

        fun target(c: SelfViewCorner): Offset = Offset(
            x = if (c.left) margin else areaWidth - w - margin,
            y = if (c.top) top else bottom - h,
        )

        val position = remember { Animatable(target(corner), Offset.VectorConverter) }
        var dragging by remember { mutableStateOf(false) }
        // Settles into the corner whenever it changes, or the room it has does
        // (the name's line wraps, the call connects and the face goes).
        LaunchedEffect(corner, w, top, bottom, areaWidth, dragging) {
            if (!dragging) position.animateTo(target(corner), spring(dampingRatio = 0.8f, stiffness = Spring.StiffnessMediumLow))
        }
        // Read by the gesture, which outlives any one size of the card.
        val geometry by rememberUpdatedState(SelfViewGeometry(areaWidth, constraints.maxHeight.toFloat(), top, bottom, w, h))

        val shape = RoundedCornerShape(16.dp)
        val label = StrAndroid.callSelfView(language)
        val smaller = StrAndroid.callSelfViewSmaller(language)
        val larger = StrAndroid.callSelfViewLarger(language)
        val move = StrAndroid.callSelfViewMove(language)

        Box(
            Modifier
                .offset { IntOffset(position.value.x.roundToInt(), position.value.y.roundToInt()) }
                .size(widthDp.dp, (widthDp * 4f / 3f).dp)
                .shadow(10.dp, shape)
                .clip(shape)
                .border(1.5.dp, Color.White.copy(alpha = 0.35f), shape)
                .testTag(A11y.CALL_SELF_VIEW)
                .semantics {
                    contentDescription = label
                    customActions = listOf(
                        CustomAccessibilityAction(move) {
                            corner = corner.next().also { placement.corner = it }
                            true
                        },
                        CustomAccessibilityAction(smaller) {
                            widthDp = SelfViewSize.clamp(widthDp - 28f).also { placement.width = it }
                            true
                        },
                        CustomAccessibilityAction(larger) {
                            widthDp = SelfViewSize.clamp(widthDp + 28f).also { placement.width = it }
                            true
                        },
                    )
                },
        ) {
            VideoView(track, room, Modifier.fillMaxSize(), mirror = true)
            // Over the video rather than on it: the renderer is an Android
            // view, and the touches are the card's, not the picture's.
            Box(
                Modifier
                    .matchParentSize()
                    .pointerInput(Unit) {
                        detectTapGestures(
                            onDoubleTap = {
                                widthDp = SelfViewSize.next(widthDp).also { placement.width = it }
                            },
                        )
                    }
                    .pointerInput(Unit) {
                        awaitEachGesture {
                            val down = awaitFirstDown(requireUnconsumed = false)
                            // In the call screen's own coordinates: the card
                            // moves under the finger, so its local ones stand still.
                            var at = position.value
                            var travelled = Offset.Zero
                            val velocity = VelocityTracker()
                            velocity.addPosition(down.uptimeMillis, travelled)
                            var moved = false
                            // A tap that wobbles is still a tap: nothing moves
                            // until the finger has gone past the touch slop, or
                            // a second finger has come down to pinch.
                            var pending = Offset.Zero
                            do {
                                val event = awaitPointerEvent()
                                val zoom = event.calculateZoom()
                                var pan = event.calculatePan()
                                if (!moved) {
                                    pending += pan
                                    val pinching = event.changes.count { it.pressed } > 1
                                    if (!pinching && pending.getDistance() < viewConfiguration.touchSlop) continue
                                    moved = true
                                    dragging = true
                                    pan = pending
                                }
                                if (zoom != 1f || pan != Offset.Zero) {
                                    if (zoom != 1f) {
                                        val before = widthDp
                                        widthDp = SelfViewSize.clamp(widthDp * zoom)
                                        // Grows and shrinks about its middle, not its corner.
                                        val grown = (widthDp - before) * density.density
                                        at -= Offset(grown / 2f, grown * 2f / 3f)
                                    }
                                    travelled += pan
                                    at = geometry.clamp(at + pan)
                                    val next = at
                                    scope.launch { position.snapTo(next) }
                                    event.changes.forEach { if (it.positionChanged()) it.consume() }
                                }
                                event.changes.firstOrNull()?.let { velocity.addPosition(it.uptimeMillis, travelled) }
                            } while (event.changes.any { it.pressed })

                            if (moved) {
                                // A flick counts: where it was heading, a fifth of a second on.
                                val v = velocity.calculateVelocity()
                                val g = geometry
                                val aimed = at + Offset(g.w / 2f, g.h / 2f) + Offset(v.x, v.y) * 0.2f
                                val next = SelfViewCorner.nearest(aimed.x, aimed.y, g.areaWidth, g.top, g.bottom)
                                placement.corner = next
                                placement.width = widthDp
                                corner = next
                                dragging = false
                            }
                        }
                    },
            )
        }
    }
}

/** The call screen's measures, as the gesture reads them mid-drag. */
private data class SelfViewGeometry(
    val areaWidth: Float,
    val areaHeight: Float,
    val top: Float,
    val bottom: Float,
    val w: Float,
    val h: Float,
) {
    /** Kept on the screen while it is dragged; the corners are for letting go. */
    fun clamp(p: Offset): Offset = Offset(
        x = p.x.coerceIn(0f, maxOf(0f, areaWidth - w)),
        y = p.y.coerceIn(0f, maxOf(0f, areaHeight - h)),
    )
}
