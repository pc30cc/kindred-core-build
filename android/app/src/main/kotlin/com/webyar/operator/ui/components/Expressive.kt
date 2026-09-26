package com.webyar.operator.ui.components

import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.material3.pulltorefresh.PullToRefreshState
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.interaction.InteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.progressSemantics
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.CornerSize
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawWithCache
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Matrix
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.asComposePath
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.graphics.shapes.Morph
import androidx.graphics.shapes.RoundedPolygon
import androidx.graphics.shapes.toPath
import com.webyar.operator.ui.design.ExpressiveShapes
import com.webyar.operator.ui.design.Motion
import com.webyar.operator.ui.design.PolygonShape
import com.webyar.operator.ui.design.Radius
import com.webyar.operator.ui.design.Space

/**
 * Material 3 Expressive's loading indicator: a shape that morphs through the
 * expressive set while it turns.
 *
 * For waits of a second or two — a list loading, a thread opening. Longer or
 * measurable work keeps a progress bar, and a list whose shape is known keeps
 * its skeleton rows, because rows that fill in are calmer than a shape that
 * is replaced by rows.
 *
 * Drawn rather than clipped: the path is rebuilt from the morph each frame,
 * which is one path and no layers. With animations turned off in the system
 * settings the infinite transition stands still, and what is left is a
 * single steady shape — still legible as "working".
 */
@Composable
fun LoadingIndicator(
    modifier: Modifier = Modifier,
    color: Color = MaterialTheme.colorScheme.primary,
    size: Dp = 48.dp,
    polygons: List<RoundedPolygon> = ExpressiveShapes.loadingSequence,
) {
    val morphs = remember(polygons) {
        polygons.indices.map { Morph(polygons[it], polygons[(it + 1) % polygons.size]) }
    }
    val transition = rememberInfiniteTransition(label = "loading")
    // One morph every 650ms, the Expressive indicator's own pace.
    val step by transition.animateFloat(
        initialValue = 0f,
        targetValue = morphs.size.toFloat(),
        animationSpec = infiniteRepeatable(tween(MORPH_MS * morphs.size, easing = LinearEasing)),
        label = "step",
    )
    val spin by transition.animateFloat(
        initialValue = 0f,
        targetValue = 360f,
        animationSpec = infiniteRepeatable(tween(SPIN_MS, easing = LinearEasing)),
        label = "spin",
    )

    Box(
        modifier
            .size(size)
            .progressSemantics()
            .drawWithCache {
                val androidPath = android.graphics.Path()
                val matrix = Matrix()
                onDrawBehind {
                    val index = step.toInt().coerceIn(0, morphs.lastIndex)
                    val progress = FastOutSlowInEasing.transform((step - index).coerceIn(0f, 1f))
                    morphs[index].toPath(progress, androidPath)
                    val path = androidPath.asComposePath()
                    // The shape is normalised to 0..1; the active indicator
                    // is 38 of the 48dp, centred, and turns about its centre.
                    val side = this.size.minDimension * ACTIVE_FRACTION
                    matrix.reset()
                    matrix.translate(center.x, center.y)
                    // A further half-turn per morph on top of the steady spin
                    // gives the "kick" the Expressive indicator has.
                    matrix.rotateZ(spin + (index + progress) * 50f)
                    matrix.translate(-side / 2, -side / 2)
                    matrix.scale(side, side)
                    path.transform(matrix)
                    drawPath(path, color)
                }
            },
    )
}

/** The indicator on a filled circle, for when it sits over content. */
@Composable
fun ContainedLoadingIndicator(
    modifier: Modifier = Modifier,
    containerColor: Color = MaterialTheme.colorScheme.primaryContainer,
    indicatorColor: Color = MaterialTheme.colorScheme.onPrimaryContainer,
    size: Dp = 48.dp,
) {
    Box(
        modifier.size(size).clip(CircleShape).background(containerColor),
        contentAlignment = Alignment.Center,
    ) {
        LoadingIndicator(color = indicatorColor, size = size * 0.76f)
    }
}

private const val MORPH_MS = 650
private const val SPIN_MS = 4666
private const val ACTIVE_FRACTION = 38f / 48f

/**
 * A shape that squares up under the finger — Expressive's press feedback.
 *
 * At rest a fully rounded pill; pressed, a rounded rectangle; back to a pill
 * on release with a small overshoot. The corner is a percentage, so the same
 * morph works on a 40dp chip and a 56dp button.
 */
@Composable
fun rememberPressShape(
    interactionSource: InteractionSource,
    restPercent: Float = 50f,
    pressedPercent: Float = 22f,
): Shape {
    val pressed by interactionSource.collectIsPressedAsState()
    val percent by animateFloatAsState(
        targetValue = if (pressed) pressedPercent else restPercent,
        animationSpec = Motion.fastSpatial(),
        label = "pressShape",
    )
    return RoundedCornerShape(CornerSize(percent.coerceIn(0f, 50f)))
}

/**
 * The shape of one item in a group of rows — Android 16's settings lists.
 *
 * A group reads as one rounded card, but each row is its own surface with a
 * hairline gap between them: the ends of the group are fully rounded and the
 * joins between rows only slightly, so the group holds together and each
 * row still presses on its own.
 */
fun segmentedShape(index: Int, count: Int): Shape {
    val outer = Radius.xl - 8.dp
    val inner = Radius.xs
    val first = index == 0
    val last = index == count - 1
    return RoundedCornerShape(
        topStart = if (first) outer else inner,
        topEnd = if (first) outer else inner,
        bottomStart = if (last) outer else inner,
        bottomEnd = if (last) outer else inner,
    )
}

/** The gap between the rows of a segmented group. */
val SegmentGap = 2.dp

/** A heading over a group of rows. */
@Composable
fun GroupHeader(text: String, modifier: Modifier = Modifier) {
    Text(
        text,
        style = MaterialTheme.typography.labelLarge,
        color = MaterialTheme.colorScheme.primary,
        modifier = modifier.padding(start = Space.xl, end = Space.xl, top = Space.xl, bottom = Space.sm),
    )
}

/**
 * A column laid out as a segmented group, with the gap between rows. The rows
 * themselves take [segmentedShape] for their index.
 */
@Composable
fun SegmentedColumn(
    modifier: Modifier = Modifier,
    content: @Composable ColumnScope.() -> Unit,
) {
    Column(
        modifier.fillMaxWidth().padding(horizontal = Space.lg),
        verticalArrangement = Arrangement.spacedBy(SegmentGap),
        content = content,
    )
}

/**
 * Content framed in one of the expressive shapes — a profile picture inside
 * a scalloped "cookie", say.
 */
@Composable
fun ShapeFrame(
    polygon: RoundedPolygon,
    modifier: Modifier = Modifier,
    color: Color = MaterialTheme.colorScheme.primaryContainer,
    content: @Composable () -> Unit = {},
) {
    val shape = remember(polygon) { PolygonShape(polygon) }
    Box(modifier.clip(shape).background(color), contentAlignment = Alignment.Center) {
        content()
    }
}

/**
 * Pull-to-refresh with the Expressive indicator: the contained loading shape
 * follows the finger down, grows as the pull nears the threshold, and keeps
 * morphing while the refresh runs.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun BoxScope.PullIndicator(state: PullToRefreshState, refreshing: Boolean) {
    val visible = refreshing || state.distanceFraction > 0f
    if (!visible) return
    Box(
        Modifier
            .align(Alignment.TopCenter)
            .graphicsLayer {
                val pulled = if (refreshing) 1f else state.distanceFraction.coerceAtMost(1.2f)
                translationY = pulled * 72.dp.toPx() - size.height
                val scale = if (refreshing) 1f else state.distanceFraction.coerceIn(0f, 1f)
                scaleX = scale
                scaleY = scale
                alpha = if (refreshing) 1f else state.distanceFraction.coerceIn(0f, 1f)
            },
    ) {
        ContainedLoadingIndicator()
    }
}
