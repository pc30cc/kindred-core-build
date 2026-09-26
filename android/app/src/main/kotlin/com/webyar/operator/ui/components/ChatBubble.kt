package com.webyar.operator.ui.components

import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.unit.dp
import com.webyar.operator.ui.design.Radius

/**
 * A message bubble's shape — Material 3 Expressive's grouped bubbles.
 *
 * Every corner is large except on the sender's side, where they tighten:
 * the foot of every bubble, and the top of every bubble but the first of a
 * run. A run from one sender reads as one block with a spine down its outer
 * edge, and the small foot points at whoever wrote it — the job the beak
 * used to do, without a tail on every bubble turning the column into a
 * sawtooth.
 *
 * Start and end, not left and right: [MessageBubble] lays its row out left
 * to right in every language (the operator on the right, the visitor on the
 * left), and [RoundedCornerShape] resolves start/end against that same
 * direction — so the tight corners are on the side the bubble sits on.
 */
fun bubbleShape(outgoing: Boolean, startsRun: Boolean): Shape {
    val big = BubbleCorner
    val small = BubbleJoin
    val top = if (startsRun) big else small
    return if (outgoing) {
        RoundedCornerShape(topStart = big, topEnd = top, bottomEnd = small, bottomStart = big)
    } else {
        RoundedCornerShape(topStart = top, topEnd = big, bottomEnd = big, bottomStart = small)
    }
}

private val BubbleCorner = Radius.lgIncreased
private val BubbleJoin = 6.dp
