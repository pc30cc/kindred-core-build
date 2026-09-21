package com.webyar.operator.ui.components

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.foundation.Canvas
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.scale
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.draw.clip
import androidx.compose.foundation.background
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import com.webyar.operator.ui.A11y
import com.webyar.operator.ui.design.Motion

/**
 * The one send button in the app.
 *
 * There were four on iOS, and no two alike: 34pt with a 17pt bold arrow in
 * the chat composer, 38pt with 16pt semibold in the voice bar, 34/16 in the
 * note sheet, 34/15 in the mail composer. Three of them showed nothing while
 * a send was in flight. An operator moving between an email and a chat saw
 * the same control change size and weight under their thumb. One size, one
 * weight, one disabled treatment, one busy treatment.
 *
 * The three states are distinguishable without colour, deliberately: enabled
 * and disabled differ only in opacity, so the glyph swaps to a spinner while
 * sending and the button refuses taps in both of the other two. Nothing here
 * asks anyone to tell two blues apart.
 */
@Composable
fun SendButton(
    enabled: Boolean,
    /** What this sends, spoken. The glyph is an arrow everywhere, so this is
     *  the only thing that says what it does. */
    label: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    sending: Boolean = false,
) {
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    // Press feedback, and nothing else. A send button that is completely inert
    // under the thumb reads as a tap that did not land — which is why people
    // tap twice and send twice.
    val scale by animateFloatAsState(
        targetValue = if (pressed) 0.88f else 1f,
        animationSpec = Motion.standard(),
        label = "send-press",
    )
    val live = enabled && !sending

    IconButton(
        onClick = onClick,
        enabled = live,
        interactionSource = interaction,
        // IconButton is already 48dp, which is Android's minimum touch target.
        // The circle inside it is 34dp, so the glyph lines up with the other
        // controls in a composer pill while the tap area stays full size —
        // the thing iOS has to do by hand with a pair of opposite paddings.
        modifier = modifier
            .testTag(A11y.COMPOSER_SEND)
            .semantics { contentDescription = label },
    ) {
        Box(
            Modifier
                .scale(scale)
                .size(34.dp)
                .clip(CircleShape)
                .background(
                    MaterialTheme.colorScheme.primary.copy(alpha = if (live) 1f else 0.35f)
                ),
            contentAlignment = Alignment.Center,
        ) {
            if (sending) {
                CircularProgressIndicator(
                    modifier = Modifier.size(16.dp),
                    color = MaterialTheme.colorScheme.onPrimary,
                    strokeWidth = 2.dp,
                )
            } else {
                UpArrow()
            }
        }
    }
}

/**
 * The arrow, drawn rather than fetched.
 *
 * Up, not "send": it points out of the composer, and it does so in Persian
 * too — a paper-plane glyph is directional and would need mirroring, while an
 * arrow pointing up is the same arrow in every script.
 *
 * Drawn because `material-icons-core` is a curated subset and it is not worth
 * finding out at runtime whether a given name made the cut; the alternative,
 * `material-icons-extended`, is a very large artifact to pull in for one
 * glyph.
 */
@Composable
private fun UpArrow(modifier: Modifier = Modifier) {
    Canvas(modifier.size(18.dp)) {
        val w = size.width
        val h = size.height
        val stroke = w * 0.145f
        val head = w * 0.30f
        val topY = h * 0.19f
        val midX = w / 2f

        drawLine(
            color = Color.White,
            start = Offset(midX, h * 0.82f),
            end = Offset(midX, topY),
            strokeWidth = stroke,
            cap = StrokeCap.Round,
        )
        drawLine(
            color = Color.White,
            start = Offset(midX - head, topY + head),
            end = Offset(midX, topY),
            strokeWidth = stroke,
            cap = StrokeCap.Round,
        )
        drawLine(
            color = Color.White,
            start = Offset(midX + head, topY + head),
            end = Offset(midX, topY),
            strokeWidth = stroke,
            cap = StrokeCap.Round,
        )
    }
}
