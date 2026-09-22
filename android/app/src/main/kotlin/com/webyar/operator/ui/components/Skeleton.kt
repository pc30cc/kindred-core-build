package com.webyar.operator.ui.components

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
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.semantics.hideFromAccessibility
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.webyar.operator.ui.design.Motion
import com.webyar.operator.ui.design.Radius
import com.webyar.operator.ui.design.Size
import com.webyar.operator.ui.design.Space

/**
 * The shape of a row that has not arrived yet.
 *
 * A spinner in the middle of an empty screen says "wait"; a list of grey rows
 * says "a list is coming, this long, in this shape" — and when the answer
 * lands nothing jumps, because the rows were already the right height. That
 * matters most on the slow phones this has to run on, where the wait is a
 * second rather than a flicker.
 *
 * It pulses rather than sweeping a gradient across itself. A shimmer is one
 * more animation to get wrong at 60fps on a cheap device, and the pulse reads
 * as "working" just as well at a fraction of the cost.
 */
@Composable
private fun Shimmer(modifier: Modifier, shape: androidx.compose.ui.graphics.Shape) {
    val transition = rememberInfiniteTransition(label = "skeleton")
    val alpha by transition.animateFloat(
        initialValue = 0.45f,
        targetValue = 1f,
        animationSpec = infiniteRepeatable(
            animation = tween(Motion.skeletonPulse, easing = androidx.compose.animation.core.LinearEasing),
            repeatMode = RepeatMode.Reverse,
        ),
        label = "skeleton.alpha",
    )
    Box(
        modifier
            .alpha(alpha)
            .background(MaterialTheme.colorScheme.surfaceContainerHighest, shape)
    )
}

/** One grey bar. Width is given because a run of equal bars reads as a table. */
@Composable
fun SkeletonBar(width: Dp, height: Dp = 12.dp, modifier: Modifier = Modifier) {
    Shimmer(modifier.width(width).height(height), RoundedCornerShape(Radius.sm))
}

/**
 * A list row waiting for its contents: a circle where the avatar goes and two
 * bars where the two lines of text go.
 *
 * Hidden from the screen reader entirely. There is nothing here to announce,
 * and a reader walking ten identical "graphic" nodes is worse than silence
 * while the list loads.
 */
@Composable
fun SkeletonRow(modifier: Modifier = Modifier, lines: Int = 2) {
    Row(
        modifier
            .fillMaxWidth()
            .heightIn(min = Size.rowMinHeight)
            .padding(horizontal = Space.screenInset, vertical = Space.sm)
            .semantics { hideFromAccessibility() },
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Shimmer(Modifier.size(Size.avatarMedium), CircleShape)
        Column(
            Modifier.padding(horizontal = Space.md),
            verticalArrangement = Arrangement.spacedBy(Space.sm),
        ) {
            SkeletonBar(width = 130.dp, height = 13.dp)
            if (lines > 1) SkeletonBar(width = 180.dp, height = 11.dp)
        }
    }
}

/** Ten of them, which is about a screenful on the phones this ships to. */
@Composable
fun SkeletonList(modifier: Modifier = Modifier, rows: Int = 10, lines: Int = 2) {
    Column(modifier.fillMaxWidth()) {
        repeat(rows) {
            SkeletonRow(lines = lines)
            RowDivider()
        }
    }
}
