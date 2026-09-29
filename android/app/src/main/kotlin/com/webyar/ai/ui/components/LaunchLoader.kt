package com.webyar.ai.ui.components

import android.provider.Settings
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.animation.core.animateFloat
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.rotate
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import kotlin.math.cos
import kotlin.math.sin

/**
 * The iOS app's `LaunchLoader`: two arcs turning against each other — an
 * outer comet of the brand's blue running into cyan, with a bright bead at
 * its head, over a barely-there track, and a fainter cyan arc inside going
 * the other way. The size of a large spinner, not of a logo.
 *
 * Its resting pose is exactly `res/drawable/launch_loader.xml`, the picture
 * the system splash and the launch window show, so the hand-over from them
 * is the loader starting to turn and nothing else. Change a size, a colour
 * or a starting angle here and change that drawable with it.
 *
 * It turns the same way in every language — it is a clock, not text — and
 * stands still, parked, for anyone who has turned animations off.
 */
@Composable
fun LaunchLoader(modifier: Modifier = Modifier, size: Dp = OUTER) {
    val context = LocalContext.current
    val still = remember(context) {
        runCatching {
            Settings.Global.getFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f
        }.getOrDefault(false)
    }
    val transition = rememberInfiniteTransition(label = "launchLoader")
    // One turn a second, clockwise, from the top.
    val outerTurn by transition.animateFloat(
        initialValue = 0f,
        targetValue = if (still) 0f else 360f,
        animationSpec = infiniteRepeatable(tween(1_000, easing = LinearEasing), RepeatMode.Restart),
        label = "outer",
    )
    // A turn and a half every 1.6 s, the other way.
    val innerTurn by transition.animateFloat(
        initialValue = 0f,
        targetValue = if (still) 0f else -540f,
        animationSpec = infiniteRepeatable(tween(1_600, easing = LinearEasing), RepeatMode.Restart),
        label = "inner",
    )
    val scale = size / OUTER
    Canvas(modifier.size(size)) {
        drawLoader(outerTurn = outerTurn, innerTurn = innerTurn, scale = scale)
    }
}

private fun DrawScope.drawLoader(outerTurn: Float, innerTurn: Float, scale: Float) {
    val outerLine = OUTER_LINE.toPx() * scale
    val innerLine = INNER_LINE.toPx() * scale
    val outerRadius = OUTER.toPx() * scale / 2
    val innerRadius = INNER.toPx() * scale / 2
    val c = center

    // Where the outer arc runs.
    drawCircle(
        color = BrandPalette.deep.copy(alpha = 0.10f),
        radius = outerRadius,
        center = c,
        style = Stroke(width = outerLine),
    )

    // The comet: parked with its tail at the top, as iOS parks it.
    rotate(degrees = START_OUTER + outerTurn, pivot = c) {
        val sweep = COMET * 360f
        drawArc(
            brush = Brush.sweepGradient(
                0f to BrandPalette.deep.copy(alpha = 0f),
                (COMET * 0.55f) to BrandPalette.deep,
                COMET to BrandPalette.cyan,
                1f to BrandPalette.cyan,
                center = c,
            ),
            startAngle = 0f,
            sweepAngle = sweep,
            useCenter = false,
            topLeft = Offset(c.x - outerRadius, c.y - outerRadius),
            size = Size(outerRadius * 2, outerRadius * 2),
            style = Stroke(width = outerLine, cap = StrokeCap.Round),
        )
        // The bead leading it, with its glow.
        val head = Math.toRadians(sweep.toDouble())
        val bead = Offset(c.x + outerRadius * cos(head).toFloat(), c.y + outerRadius * sin(head).toFloat())
        drawCircle(BrandPalette.cyan.copy(alpha = 0.28f), radius = outerLine * 1.9f, center = bead)
        drawCircle(BrandPalette.cyan, radius = outerLine * 0.95f, center = bead)
    }

    // The inner arc, the other way.
    rotate(degrees = START_INNER + innerTurn, pivot = c) {
        drawArc(
            color = BrandPalette.cyan.copy(alpha = 0.55f),
            startAngle = 0f,
            sweepAngle = INNER_ARC * 360f,
            useCenter = false,
            topLeft = Offset(c.x - innerRadius, c.y - innerRadius),
            size = Size(innerRadius * 2, innerRadius * 2),
            style = Stroke(width = innerLine, cap = StrokeCap.Round),
        )
    }
}

private val OUTER = 40.dp
private val INNER = 24.dp
private val OUTER_LINE = 2.5.dp
private val INNER_LINE = 2.dp

/** How much of the circle the comet covers, and the inner arc. */
private const val COMET = 0.32f
private const val INNER_ARC = 0.22f

/** Resting angles: the comet from the top, the inner arc from the bottom. */
private const val START_OUTER = -90f
private const val START_INNER = 90f
