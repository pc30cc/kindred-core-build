package com.platform.app.feature.call

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.requiredSize
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.animation.core.animateFloatAsState
import com.platform.app.core.model.VisitorProfile
import com.platform.app.i18n.Language
import com.platform.app.i18n.StrAndroid
import com.platform.app.ui.A11y
import com.platform.app.ui.components.Avatar
import com.platform.app.ui.components.BrandPalette
import com.platform.app.ui.components.Glyph
import com.platform.app.ui.components.OperatorAvatar
import com.platform.app.ui.components.percentShape
import com.platform.app.ui.components.rememberLoop
import com.platform.app.ui.design.Motion
import com.platform.app.ui.design.Size
import com.platform.app.ui.design.Space

/*
 * The visual language every call screen shares — a colleague's
 * ([TeamCallScreen]), a visitor's and a call-centre call ([CallScreen]), the
 * picture-in-picture window and the in-app bubble ([CallPip]).
 *
 * Opaque, always: a call is drawn on [CallBackdrop], a deep gradient in the
 * brand's own dark tone (each flavor's `brand_deep`, through [BrandPalette]),
 * never on a translucent surface, so nothing behind the call — the inbox, a
 * customer's chat, the lock screen's wallpaper — ever shows through it.
 */

/**
 * The call's own background: the brand's deep colour darkened nearly to
 * black at the top, black at the bottom, with a soft glow of the brand's
 * bright colour where the face is. Every colour in it is fully opaque.
 */
@Composable
internal fun CallBackdrop(modifier: Modifier = Modifier, glowAt: Float = 0.32f) {
    val deep = BrandPalette.deep.copy(alpha = 1f)
    val bright = BrandPalette.bright.copy(alpha = 1f)
    val top = remember(deep) { lerp(deep, Color.Black, 0.62f) }
    val middle = remember(deep) { lerp(deep, CALL_BACKGROUND, 0.86f) }
    Box(
        modifier
            .fillMaxSize()
            .background(CALL_BACKGROUND)
            .background(Brush.verticalGradient(listOf(top, middle, CALL_BACKDROP_BOTTOM)))
            .drawBehind {
                val center = Offset(size.width / 2f, size.height * glowAt)
                drawCircle(
                    brush = Brush.radialGradient(
                        colors = listOf(bright.copy(alpha = 0.20f), Color.Transparent),
                        center = center,
                        radius = size.minDimension * 0.75f,
                    ),
                    radius = size.minDimension * 0.75f,
                    center = center,
                )
            },
    )
}

/**
 * Over a picture that fills the screen: the top and the bottom darkened, so
 * the name, the timer and the controls stay legible on any video.
 */
@Composable
internal fun VideoScrims(modifier: Modifier = Modifier) {
    Box(
        modifier
            .fillMaxSize()
            .background(
                Brush.verticalGradient(
                    0f to Color.Black.copy(alpha = 0.55f),
                    0.22f to Color.Transparent,
                    0.62f to Color.Transparent,
                    1f to Color.Black.copy(alpha = 0.70f),
                ),
            ),
    )
}

/**
 * The size of the face on a call screen: large on a tall phone, smaller on
 * a short one (or a phone on its side) so the name and the buttons still fit.
 */
/** Below this height (a phone on its side) a call screen leaves the face out. */
internal val COMPACT_CALL_HEIGHT = 480.dp

internal fun callFaceSize(maxHeight: Dp, incoming: Boolean): Dp = when {
    maxHeight < 560.dp -> 88.dp
    maxHeight < 700.dp -> if (incoming) 120.dp else 108.dp
    else -> if (incoming) 148.dp else 128.dp
}

/**
 * The face of whoever is on the other end, with the ring around it.
 *
 * While the call rings, soft circles in the brand's bright colour grow out
 * of the photo and fade, one after another — the pulse of a phone ringing.
 * Once answered they stop, and one quiet ring stays. Reduced motion (the
 * system's "remove animations") leaves the quiet ring alone.
 */
@Composable
internal fun CallHalo(ringing: Boolean, faceSize: Dp = Size.avatarLarge + 8.dp, face: @Composable () -> Unit) {
    val pulse by rememberLoop(
        label = "ring.pulse",
        from = 0f,
        to = 1f,
        spec = infiniteRepeatable(tween(PULSE_MS, easing = LinearEasing), repeatMode = RepeatMode.Restart),
        rest = -1f,
    )
    val bright = BrandPalette.bright.copy(alpha = 1f)
    val spread = faceSize * 0.42f
    Box(
        Modifier
            .size(faceSize + spread * 2)
            .drawBehind {
                val base = faceSize.toPx() / 2f
                val reach = spread.toPx()
                if (ringing && pulse >= 0f) {
                    for (i in 0 until PULSE_RINGS) {
                        val p = (pulse + i.toFloat() / PULSE_RINGS) % 1f
                        drawCircle(
                            color = bright.copy(alpha = (1f - p) * 0.28f),
                            radius = base + reach * p,
                        )
                    }
                } else {
                    drawCircle(
                        color = Color.White.copy(alpha = if (ringing) 0.16f else 0.10f),
                        radius = base + reach * 0.22f,
                    )
                }
                drawCircle(
                    color = Color.White.copy(alpha = 0.22f),
                    radius = base + 1.5.dp.toPx(),
                    style = Stroke(width = 1.5.dp.toPx()),
                )
            },
        contentAlignment = Alignment.Center,
    ) {
        face()
    }
}

private const val PULSE_MS = 2_400
private const val PULSE_RINGS = 3

/**
 * Whose face a call shows. A colleague: their photo, or the platform's
 * silhouette — never a letter (CLAUDE.md, "Avatars"). A visitor or a
 * call-centre caller keeps the inbox's own look for them ([Avatar]: their
 * photo, or their device's mark).
 */
@Composable
internal fun CallFace(
    colleague: Boolean,
    name: String,
    avatarUrl: String?,
    size: Dp,
    visitor: VisitorProfile? = null,
) {
    if (colleague) {
        OperatorAvatar(imageUrl = avatarUrl, size = size)
    } else {
        Avatar(
            name = name,
            imageUrl = avatarUrl,
            size = size,
            os = visitor?.device?.os,
            device = visitor?.device?.device,
            countryCode = visitor?.geo?.countryCode,
        )
    }
}

/**
 * The top of a call screen: the way to keep the call going in a small window
 * and use the rest of the app (the bubble, [FloatingCallBubble]). Down, as
 * a sheet goes down; not mirrored in Persian.
 */
@Composable
internal fun CallTopBar(language: Language, onMinimise: (() -> Unit)?, modifier: Modifier = Modifier) {
    Row(modifier.fillMaxWidth().padding(top = Space.sm), verticalAlignment = Alignment.CenterVertically) {
        if (onMinimise != null) {
            Surface(
                onClick = onMinimise,
                shape = CircleShape,
                color = Color.White.copy(alpha = 0.12f),
                contentColor = Color.White,
                modifier = Modifier.size(Size.minTouchTarget).testTag(A11y.CALL_MINIMISE),
            ) {
                Box(contentAlignment = Alignment.Center) {
                    Icon(
                        Icons.Filled.KeyboardArrowDown,
                        contentDescription = StrAndroid.callMinimise(language),
                        modifier = Modifier.size(28.dp),
                    )
                }
            }
        } else {
            Box(Modifier.size(Size.minTouchTarget))
        }
    }
}

/**
 * One round button under the call, with its name under it.
 *
 * [on] is the lit state and [tint] the colour it lights up in — white for a
 * toggle, red for the one that ends the call, green for the one that answers.
 * Both states of a toggle are drawn as shapes (round at rest, a rounded
 * square switched on), never one shape lit and unlit: on a dark screen with
 * nothing beside it, "highlighted" is not a thing anyone can read. A
 * disabled button keeps its shape and loses its contrast, so the row does not
 * change length at the moment a call connects.
 *
 * The visible name is for the eye; a screen reader hears the button's own
 * [label] once, as its content description.
 */
@Composable
internal fun CallToggle(
    icon: ImageVector,
    label: String,
    tag: String,
    on: Boolean,
    onClick: () -> Unit,
    enabled: Boolean = true,
    tint: Color? = null,
    caption: String = label,
    diameter: Dp = TOGGLE_SIZE,
) {
    val lit = tint ?: Color.White
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    val percent by animateFloatAsState(
        targetValue = when {
            pressed -> 30f
            on && tint == null -> 32f
            else -> 50f
        },
        animationSpec = Motion.fastSpatial(),
        label = "callToggleShape",
    )
    val scale by animateFloatAsState(if (pressed) 0.92f else 1f, Motion.fastSpatial(), label = "callToggleScale")
    Column(
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(Space.sm),
        modifier = Modifier.widthIn(min = diameter, max = diameter + 28.dp),
    ) {
        Surface(
            color = when {
                !enabled -> Color.White.copy(alpha = 0.06f)
                on -> if (tint == null) Color.White else lit
                else -> Color.White.copy(alpha = 0.14f)
            },
            contentColor = when {
                !enabled -> Color.White.copy(alpha = 0.28f)
                tint != null -> Color.White
                on -> CALL_BACKGROUND
                else -> Color.White
            },
            shape = percentShape(percent),
            enabled = enabled,
            onClick = onClick,
            interactionSource = interaction,
            modifier = Modifier
                // Never squeezed: the screen's header gives way first.
                .requiredSize(diameter)
                .graphicsLayer {
                    scaleX = scale
                    scaleY = scale
                }
                .semantics { if (on) selected = true }
                .testTag(tag),
        ) {
            Box(contentAlignment = Alignment.Center) {
                Icon(icon, contentDescription = label, modifier = Modifier.size(diameter * 0.42f))
            }
        }
        Text(
            caption,
            style = MaterialTheme.typography.labelMedium,
            color = Color.White.copy(alpha = if (enabled) 0.85f else 0.35f),
            textAlign = TextAlign.Center,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.fillMaxWidth().clearAndSetSemantics {},
        )
    }
}

/** The round controls of a call in progress. */
internal val TOGGLE_SIZE = 64.dp

/** The red end button, and the two of a ringing call: larger, the ones that matter most. */
internal val PRIMARY_SIZE = 76.dp

/**
 * The buttons of a call ringing this phone: Decline on the start side,
 * Answer on the end, far enough apart that one is never pressed for the
 * other, each named under it. A video call can also be answered with the
 * camera off ([onAnswerVoiceOnly]), between the two. Answer breathes gently,
 * the way a ringing phone's does.
 */
@Composable
internal fun IncomingCallActions(
    language: Language,
    video: Boolean,
    declineLabel: String,
    answerLabel: String,
    onDecline: () -> Unit,
    onAnswer: () -> Unit,
    onAnswerVoiceOnly: (() -> Unit)? = null,
) {
    val breath by rememberLoop(
        label = "ring.answer",
        from = 1f,
        to = 1.08f,
        spec = infiniteRepeatable(tween(900), repeatMode = RepeatMode.Reverse),
        rest = 1f,
    )
    BoxWithConstraints(Modifier.fillMaxWidth().padding(bottom = Space.xl)) {
        val diameter = if (maxWidth < 340.dp) 68.dp else PRIMARY_SIZE
        Row(
            Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceEvenly,
            verticalAlignment = Alignment.Top,
        ) {
            CallToggle(
                icon = Glyph.CallEnd,
                label = declineLabel,
                tag = A11y.CALL_DECLINE,
                on = true,
                tint = CALL_END_RED,
                onClick = onDecline,
                diameter = diameter,
            )
            if (video && onAnswerVoiceOnly != null) {
                CallToggle(
                    icon = Glyph.Call,
                    label = StrAndroid.answerWithVoiceOnly(language),
                    caption = StrAndroid.answerVoiceShort(language),
                    tag = A11y.CALL_ANSWER_VOICE,
                    on = false,
                    onClick = onAnswerVoiceOnly,
                    diameter = diameter,
                )
            }
            Box(Modifier.graphicsLayer {
                scaleX = breath
                scaleY = breath
            }) {
                CallToggle(
                    icon = if (video) Glyph.Videocam else Glyph.Call,
                    label = if (video && onAnswerVoiceOnly != null) StrAndroid.answerWithVideo(language) else answerLabel,
                    caption = if (video && onAnswerVoiceOnly != null) StrAndroid.answerVideoShort(language) else answerLabel,
                    tag = A11y.CALL_ANSWER,
                    on = true,
                    tint = CALL_ANSWER_GREEN,
                    onClick = onAnswer,
                    diameter = diameter,
                )
            }
        }
    }
}

/** The bottom of [CallBackdrop]: black with a breath of blue in it. Opaque. */
private val CALL_BACKDROP_BOTTOM = Color(0xFF05070A)

/** The "Done" that closes a finished call: neutral, not the red of ending one. Opaque. */
internal val CALL_DONE_GREY = Color(0xFF3A3F47)
