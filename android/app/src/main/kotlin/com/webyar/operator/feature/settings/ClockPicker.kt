package com.webyar.operator.feature.settings

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TimePicker
import androidx.compose.material3.rememberTimePickerState
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import com.webyar.operator.i18n.Language
import com.webyar.operator.i18n.Str
import com.webyar.operator.ui.A11y
import com.webyar.operator.ui.design.Space

/**
 * Picks a wall-clock time, and hands it back as the `HH:mm` the server stores.
 *
 * Material's own picker rather than two text fields: typing a time is the
 * slowest way to choose one, and a field that must be `HH:mm` is a field
 * people get wrong. The dial also reads correctly at a large font scale,
 * which a pair of two-character fields does not.
 *
 * Forced to 24-hour, matching what the server stores and what the console
 * shows. A setting that displays 10:00 PM and saves 22:00 is one bug report
 * away from somebody believing the app lost their change.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ClockPicker(
    language: Language,
    /** `HH:mm`. Anything else starts the dial at midnight. */
    value: String,
    onDismiss: () -> Unit,
    onPick: (String) -> Unit,
) {
    val parts = value.split(':')
    val state = rememberTimePickerState(
        initialHour = parts.getOrNull(0)?.toIntOrNull()?.coerceIn(0, 23) ?: 0,
        initialMinute = parts.getOrNull(1)?.toIntOrNull()?.coerceIn(0, 59) ?: 0,
        is24Hour = true,
    )

    AlertDialog(
        onDismissRequest = onDismiss,
        confirmButton = {
            TextButton(
                onClick = { onPick(format(state.hour, state.minute)) },
                modifier = Modifier.testTag(A11y.CLOCK_PICKER_CONFIRM),
            ) { Text(Str.save(language)) }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text(Str.cancel(language)) }
        },
        text = {
            Box(
                Modifier.fillMaxWidth().padding(top = Space.md),
                contentAlignment = Alignment.Center,
            ) {
                TimePicker(state = state, modifier = Modifier.testTag(A11y.CLOCK_PICKER))
            }
        },
    )
}

/**
 * `HH:mm`, always two digits, always Latin.
 *
 * This is a wire value, not a label: the server's regex is
 * `^([01]\d|2[0-3]):[0-5]\d$` and Persian digits do not match it. What the
 * operator reads is [com.webyar.operator.i18n.Format.clockLabel]'s business.
 */
private fun format(hour: Int, minute: Int): String =
    "%02d:%02d".format(java.util.Locale.ROOT, hour, minute)
