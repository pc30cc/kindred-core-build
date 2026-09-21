package com.webyar.operator.ui.components

import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Matrix
import androidx.compose.ui.graphics.Outline
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import com.webyar.operator.ui.design.Radius

/**
 * A message bubble, with a beak at the foot of the last one in a run.
 *
 * The beak ties a bubble to the face beside it. Only the last bubble of a run
 * gets one — the same bubble that gets the avatar — because a tail on every
 * bubble turns a quiet column of messages into a sawtooth.
 *
 * **Which side it points to is a physical question, not a reading-order one.**
 * The operator sits on the right of the transcript in every language, so the
 * caller passes [pointsRight] directly and this shape ignores the
 * `layoutDirection` it is handed. That parameter is the right answer for an
 * arrow or a chevron and the wrong one here: mirroring a decision that was
 * already made physically just undoes it. On iOS the same fix is spelled
 * `layoutDirectionBehavior = .fixed`; in Compose it is simply not reading the
 * argument, which is easy to "tidy up" later — hence this paragraph.
 */
data class ChatBubbleShape(
    val radius: Dp = Radius.xl,
    val hasBeak: Boolean = false,
    val pointsRight: Boolean = true,
) : Shape {

    override fun createOutline(
        size: Size,
        layoutDirection: LayoutDirection,
        density: Density,
    ): Outline {
        val r = with(density) { radius.toPx() }
        if (!hasBeak) {
            val capped = minOf(r, minOf(size.width, size.height) / 2f)
            return Outline.Rounded(
                androidx.compose.ui.geometry.RoundRect(
                    left = 0f, top = 0f, right = size.width, bottom = size.height,
                    radiusX = capped, radiusY = capped,
                )
            )
        }
        return Outline.Generic(beakedPath(size, r, with(density) { BEAK.toPx() }))
    }

    /** Built with the beak on the right, then mirrored in place when it is not. */
    private fun beakedPath(size: Size, radius: Float, beak: Float): Path {
        val body = size.width - beak
        val r = maxOf(0f, minOf(radius, minOf(body, size.height) / 2f))
        val right = body

        val path = Path().apply {
            moveTo(0f, r)
            // Top-left corner, across the top, top-right corner.
            quadraticTo(0f, 0f, r, 0f)
            lineTo(right - r, 0f)
            quadraticTo(right, 0f, right, r)
            // Down the right edge, out into the beak, back along the foot.
            lineTo(right, size.height - r)
            quadraticTo(right, size.height - r * 0.15f, size.width, size.height)
            quadraticTo(right - r * 0.3f, size.height, right - r, size.height)
            // Bottom-left corner, and the left edge closes it.
            lineTo(r, size.height)
            quadraticTo(0f, size.height, 0f, size.height - r)
            close()
        }

        if (pointsRight) return path
        // x ↦ width − x: the same curve, hinged on the bubble's centre line.
        return Path().apply {
            addPath(path)
            transform(Matrix().apply {
                translate(x = size.width)
                scale(x = -1f)
            })
        }
    }

    companion object {
        /**
         * How far the beak reaches past the body of the bubble.
         *
         * The caller pads its content by this much on the beak's side, so the
         * last word never sits underneath it.
         */
        val BEAK: Dp = 6.dp
    }
}
