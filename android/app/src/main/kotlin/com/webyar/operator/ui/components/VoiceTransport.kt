package com.webyar.operator.ui.components

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.drag
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material3.Icon
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.ripple
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size as GeometrySize
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.webyar.operator.ui.design.Motion
import kotlin.random.Random

/**
 * A voice note's controls: a play button and a waveform to scrub.
 *
 * Material 3 Expressive's audio message, the way Google Messages draws one —
 * a filled button in the brand colour that squares up while it plays (and
 * under the thumb), and a row of rounded bars that fill with the brand
 * colour as the note goes. The same transport serves a note in the thread
 * and a recording being reviewed before it is sent, so the two look like the
 * same thing, because they are.
 *
 * The bars are not the recording's real loudness — the server keeps no
 * envelope and decoding a whole file to draw its outline is a lot of work
 * for a thumbnail. They are a fixed pattern seeded from the note's id, so a
 * note keeps its shape every time it is drawn, and two notes side by side do
 * not look like copies.
 *
 * Laid out left to right in every language, like every timeline: play on the
 * left, progress filling rightwards. The caller pins the direction.
 */
@Composable
fun VoiceTransport(
    seed: String,
    playing: Boolean,
    playable: Boolean,
    progress: Float,
    caption: String,
    playLabel: String,
    pauseLabel: String,
    onToggle: () -> Unit,
    onSeek: (Float) -> Unit,
    modifier: Modifier = Modifier,
    playTag: String? = null,
    /** Puts the caption under the far end of the bars — for a right-to-left language. */
    captionAtEnd: Boolean = false,
    buttonSize: Dp = 44.dp,
) {
    val tint = LocalContentColor.current
    val accent = MaterialTheme.colorScheme.primary
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    val corner by animateFloatAsState(
        targetValue = when {
            pressed -> 22f
            playing -> 30f
            else -> 50f
        },
        animationSpec = Motion.fastSpatial(),
        label = "voicePlayShape",
    )

    Row(
        modifier,
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Box(
            Modifier
                .size(buttonSize)
                .clip(percentShape(corner))
                .background(if (playable) accent else tint.copy(alpha = 0.12f))
                .clickable(
                    enabled = playable,
                    interactionSource = interaction,
                    indication = ripple(color = MaterialTheme.colorScheme.onPrimary),
                    role = Role.Button,
                    onClick = onToggle,
                )
                .semantics { contentDescription = if (playing) pauseLabel else playLabel }
                .then(if (playTag != null) Modifier.testTag(playTag) else Modifier),
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                if (playing) Glyph.Pause else Icons.Filled.PlayArrow,
                contentDescription = null,
                tint = if (playable) MaterialTheme.colorScheme.onPrimary else tint.copy(alpha = 0.5f),
                modifier = Modifier.size(buttonSize * 0.5f),
            )
        }

        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Waveform(
                seed = seed,
                progress = progress,
                played = accent,
                unplayed = tint.copy(alpha = 0.32f),
                onSeek = onSeek,
                modifier = Modifier.fillMaxWidth().height(30.dp),
            )
            Text(
                caption,
                style = MaterialTheme.typography.labelSmall,
                color = tint.copy(alpha = 0.72f),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                textAlign = if (captionAtEnd) TextAlign.End else TextAlign.Start,
                modifier = Modifier.fillMaxWidth(),
            )
        }
    }
}

/** Rounded bars, filled up to [progress]; a press jumps and a drag follows. */
@Composable
private fun Waveform(
    seed: String,
    progress: Float,
    played: Color,
    unplayed: Color,
    onSeek: (Float) -> Unit,
    modifier: Modifier = Modifier,
) {
    val levels = remember(seed) { waveformLevels(seed) }
    Canvas(
        modifier.pointerInput(Unit) {
            awaitEachGesture {
                val down = awaitFirstDown(requireUnconsumed = false)
                if (size.width > 0) onSeek(down.position.x / size.width)
                drag(down.id) { change ->
                    if (size.width > 0) onSeek(change.position.x / size.width)
                    change.consume()
                }
            }
        },
    ) {
        val count = levels.size
        val step = size.width / count
        val barWidth = step * 0.56f
        val filled = progress.coerceIn(0f, 1f) * count
        levels.forEachIndexed { index, level ->
            val height = size.height * level
            drawRoundRect(
                color = if (index < filled) played else unplayed,
                topLeft = Offset(index * step + (step - barWidth) / 2, (size.height - height) / 2),
                size = GeometrySize(barWidth, height),
                cornerRadius = CornerRadius(barWidth / 2, barWidth / 2),
            )
        }
    }
}

/**
 * Bar heights between a quarter and all of the height, from the id: the
 * same note always has the same outline. Smoothed with its neighbours, so
 * it rises and falls the way speech does rather than flickering bar to bar.
 */
internal fun waveformLevels(seed: String, count: Int = WAVEFORM_BARS): List<Float> {
    val random = Random(djb2(seed).toInt())
    val raw = List(count) { random.nextFloat() }
    return List(count) { i ->
        val left = raw.getOrElse(i - 1) { raw[i] }
        val right = raw.getOrElse(i + 1) { raw[i] }
        val smooth = (left + raw[i] * 2 + right) / 4f
        0.25f + 0.75f * smooth
    }
}

private const val WAVEFORM_BARS = 32
