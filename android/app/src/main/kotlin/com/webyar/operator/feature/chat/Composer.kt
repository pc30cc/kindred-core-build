package com.webyar.operator.feature.chat

import androidx.compose.foundation.background
import com.webyar.operator.i18n.Format
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.animation.core.tween
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.RepeatMode
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Face
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.unit.dp
import com.webyar.operator.core.model.SayNowVoice
import com.webyar.operator.i18n.Language
import com.webyar.operator.i18n.Str
import com.webyar.operator.ui.A11y
import com.webyar.operator.ui.components.Glyph
import com.webyar.operator.ui.components.SendButton
import com.webyar.operator.ui.design.Radius
import com.webyar.operator.ui.design.Space
import com.webyar.operator.ui.design.WebyarTheme

/**
 * The one place a message is written.
 *
 * **One field, and no bar above it.** Two earlier designs come back here if
 * nobody remembers why: the first stacked the console's guidance box over the
 * reply box, which is two places to type on one phone screen; the second kept
 * one field and put a row of mode chips above it, which pushed the field down
 * and made the operator choose a mode before every sentence. On an AI-answered
 * thread the composer means exactly one thing, and an operator who wants the
 * other takes the thread over from the header menu.
 *
 * Which controls appear is [ComposerCapabilities]' decision, and it says no
 * while the AI owns the thread — see its note.
 */
@Composable
fun Composer(
    language: Language,
    draft: String,
    onDraftChange: (String) -> Unit,
    capabilities: ComposerCapabilities,
    sending: Boolean,
    onSend: () -> Unit,
    onAttachPhoto: () -> Unit,
    onAttachFile: () -> Unit,
    onOpenShortcuts: () -> Unit,
    onStartRecording: () -> Unit,
    modifier: Modifier = Modifier,
    /** Non-null on a thread the AI answers: whose voice it will write in. */
    sayNowVoice: SayNowVoice? = null,
    onSayNowVoiceChange: (SayNowVoice) -> Unit = {},
    /** Whether the plan offers saved replies here. */
    canUseShortcuts: Boolean = false,
    /** Non-null while a voice note is being recorded: how long, in seconds. */
    recordingSeconds: Int? = null,
    onDiscardRecording: () -> Unit = {},
    onFinishRecording: () -> Unit = {},
) {
    val isSayNow = sayNowVoice != null
    val canSend = draft.isNotBlank() && !sending

    Surface(
        color = MaterialTheme.colorScheme.surfaceContainer,
        modifier = modifier.fillMaxWidth(),
    ) {
        if (recordingSeconds != null) {
            RecordingBar(language, recordingSeconds, onDiscardRecording, onFinishRecording)
            return@Surface
        }

        Row(
            Modifier.padding(horizontal = Space.sm, vertical = Space.sm),
            verticalAlignment = Alignment.Bottom,
        ) {
            if (capabilities.canAttach) {
                AttachButton(language, onAttachPhoto, onAttachFile)
            }
            if (canUseShortcuts && !isSayNow) {
                ComposerGlyph(
                    icon = Icons.Filled.Face,
                    label = Str.shortcuts(language),
                    tag = A11y.COMPOSER_SHORTCUTS,
                    onClick = onOpenShortcuts,
                )
            }

            // The pill. Everything that belongs to the text sits inside it,
            // which is what keeps the row's height set by the pill rather than
            // by whichever control happens to be tallest today.
            Surface(
                color = MaterialTheme.colorScheme.surfaceContainerLowest,
                shape = RoundedCornerShape(Radius.xl),
                modifier = Modifier.weight(1f).padding(horizontal = Space.xs),
            ) {
                Row(
                    Modifier.padding(horizontal = Space.md, vertical = Space.sm),
                    verticalAlignment = Alignment.Bottom,
                ) {
                    Box(Modifier.weight(1f).padding(vertical = Space.xs)) {
                        BasicTextField(
                            value = draft,
                            onValueChange = onDraftChange,
                            textStyle = MaterialTheme.typography.bodyLarge.copy(
                                color = MaterialTheme.colorScheme.onSurface
                            ),
                            cursorBrush = SolidColor(MaterialTheme.colorScheme.primary),
                            keyboardOptions = KeyboardOptions(
                                capitalization = KeyboardCapitalization.Sentences,
                                // Newline, not Send: a reply is often two
                                // sentences and an operator who lost the first
                                // one to a stray Return does not try again.
                                imeAction = ImeAction.Default,
                            ),
                            // Grows to six lines and then scrolls. A composer
                            // that grows without limit eats the transcript it
                            // is a reply to.
                            maxLines = 6,
                            modifier = Modifier
                                .fillMaxWidth()
                                .testTag(A11y.COMPOSER_FIELD),
                        )
                        if (draft.isEmpty()) {
                            Text(
                                // The placeholder is the whole explanation of
                                // what this field is for right now — which is
                                // why the AI thread's asks a question rather
                                // than saying "Message".
                                text = if (isSayNow) {
                                    Str.sayNowPlaceholder(language)
                                } else {
                                    Str.messagePlaceholder(language)
                                },
                                style = MaterialTheme.typography.bodyLarge,
                                color = WebyarTheme.colors.labelTertiary,
                            )
                        }
                    }

                    if (sayNowVoice != null) {
                        VoicePicker(language, sayNowVoice, onSayNowVoiceChange)
                    }
                }
            }

            if (draft.isBlank() && capabilities.canRecordVoice && !sending) {
                // The microphone takes the send button's place rather than
                // sitting beside it: with nothing written there is nothing to
                // send, and two controls in one slot is one control.
                ComposerGlyph(
                    icon = Glyph.Mic,
                    label = Str.voiceNote(language),
                    tag = "composer.record",
                    onClick = onStartRecording,
                )
            } else {
                SendButton(
                    enabled = canSend,
                    sending = sending,
                    label = if (isSayNow) Str.sayNowAction(language) else Str.send(language),
                    onClick = onSend,
                )
            }
        }
    }
}

/**
 * The paperclip, which opens a choice rather than a picker.
 *
 * A photograph and a document come from two different system pickers on
 * Android, and guessing which one the operator meant is how you end up in the
 * documents UI looking for a photo.
 */
@Composable
private fun AttachButton(
    language: Language,
    onPhoto: () -> Unit,
    onFile: () -> Unit,
) {
    var open by remember { mutableStateOf(false) }
    Box {
        ComposerGlyph(
            icon = Glyph.Paperclip,
            label = Str.attachFile(language),
            tag = A11y.COMPOSER_ATTACH,
            onClick = { open = true },
        )
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            DropdownMenuItem(
                text = { Text(Str.sendPhoto(language)) },
                onClick = { open = false; onPhoto() },
            )
            DropdownMenuItem(
                text = { Text(Str.sendDocument(language)) },
                onClick = { open = false; onFile() },
            )
        }
    }
}

/**
 * The voice picker, inside the field.
 *
 * Inside deliberately: the console has guidance, scopes and an "answer now"
 * nudge here, and those are desktop controls — they need a second text area
 * and three pickers beside it. On a phone the only choice left that matters is
 * whose voice the visitor hears, and it belongs on the field's own row rather
 * than in a bar that pushes the field down.
 */
@Composable
private fun VoicePicker(
    language: Language,
    voice: SayNowVoice,
    onChange: (SayNowVoice) -> Unit,
) {
    var open by remember { mutableStateOf(false) }
    val label = { v: SayNowVoice ->
        when (v) {
            SayNowVoice.SPECIALIST -> Str.sayNowVoiceSpecialist(language)
            SayNowVoice.ASSISTANT -> Str.sayNowVoiceAssistant(language)
        }
    }
    Box {
        IconButton(
            onClick = { open = true },
            modifier = Modifier
                .size(32.dp)
                .testTag(A11y.SAY_NOW_VOICE)
                .semantics {
                    contentDescription = Str.sayNowAction(language)
                    // The VALUE is what a screen reader needs here: the glyph
                    // is the same either way and only the state differs.
                    stateDescription = label(voice)
                },
        ) {
            Icon(
                Icons.Filled.Face,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.primary,
                modifier = Modifier.size(20.dp),
            )
        }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            SayNowVoice.entries.forEach { option ->
                DropdownMenuItem(
                    text = { Text(label(option)) },
                    onClick = { open = false; onChange(option) },
                )
            }
        }
    }
}

/** One glyph in the composer row, at a full touch target. */
@Composable
internal fun ComposerGlyph(
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    label: String,
    tag: String,
    onClick: () -> Unit,
    enabled: Boolean = true,
) {
    IconButton(onClick = onClick, enabled = enabled, modifier = Modifier.testTag(tag)) {
        Icon(
            icon,
            contentDescription = label,
            tint = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.size(22.dp),
        )
    }
}

/**
 * What the composer becomes while a voice note is recording.
 *
 * It replaces the whole row, the way every messenger does: there is nothing
 * else to do until the note is sent or thrown away, and a field you cannot
 * type into is worse than no field.
 *
 * The one thing it keeps is the ROW'S HEIGHT. An earlier iOS version dropped
 * the pill and laid out a bare row at a different height with a bigger button
 * in it, so the composer changed shape under the thumb that had just tapped
 * the microphone.
 */
@Composable
private fun RecordingBar(
    language: Language,
    seconds: Int,
    onDiscard: () -> Unit,
    onFinish: () -> Unit,
) {
    val pulse = rememberInfiniteTransition(label = "recording")
    val dot by pulse.animateFloat(
        initialValue = 1f,
        targetValue = 0.3f,
        animationSpec = infiniteRepeatable(tween(700), RepeatMode.Reverse),
        label = "recording-dot",
    )

    Row(
        Modifier.padding(horizontal = Space.sm, vertical = Space.sm),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        IconButton(onClick = onDiscard) {
            Icon(
                Icons.Filled.Close,
                contentDescription = Str.discard(language),
                tint = MaterialTheme.colorScheme.error,
            )
        }

        Row(
            Modifier.weight(1f).padding(horizontal = Space.sm),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(
                Modifier
                    .size(8.dp)
                    .graphicsLayer { alpha = dot }
                    .background(MaterialTheme.colorScheme.error, CircleShape)
            )
            Text(
                // The reader's own digits: a phone set to Persian counts a
                // recording in ۰:۰۷, like every other number in the app.
                Format.voiceTime(seconds.toDouble(), language),
                style = MaterialTheme.typography.titleMedium,
                modifier = Modifier.padding(horizontal = Space.sm),
            )
            Text(
                Str.recording(language),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }

        SendButton(
            enabled = true,
            label = Str.send(language),
            onClick = onFinish,
        )
    }
}
