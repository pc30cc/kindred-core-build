package com.webyar.operator.ui.components

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.webyar.operator.ui.design.Size
import com.webyar.operator.ui.design.Space

/**
 * A label on the leading edge and its value on the trailing edge.
 *
 * The label keeps the primary colour and the value takes the secondary one,
 * which is the way round every Settings row on the device reads. Inverting it
 * makes the label look disabled.
 *
 * The label is never what truncates: it has the whole of its intrinsic width
 * and the value gives way, because a row reading «تلف… | +98 912 345 6789»
 * has lost the only word that said what the number was.
 *
 * [latin] forces the value's own direction for the things that are the same
 * string in every language — an address, a phone number, a visitor code.
 * Mirroring those puts the domain first or the country code last.
 */
@Composable
fun DetailRow(
    label: String,
    value: String,
    modifier: Modifier = Modifier,
    latin: Boolean = false,
) {
    Row(
        modifier
            .fillMaxWidth()
            // Not the full 48: this is a row you read, not one you tap, and
            // a minimum rather than a height so it still grows with the font
            // scale.
            .heightIn(min = Size.minTouchTarget - 10.dp)
            .padding(horizontal = Space.screenInset, vertical = Space.sm),
        horizontalArrangement = Arrangement.spacedBy(Space.lg),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            label,
            style = MaterialTheme.typography.bodyLarge,
            color = MaterialTheme.colorScheme.onSurface,
            maxLines = 1,
        )
        if (latin) {
            LatinText(
                value,
                modifier = Modifier.weight(1f),
                style = MaterialTheme.typography.bodyLarge,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 2,
                align = TextAlign.End,
            )
        } else {
            Text(
                value,
                style = MaterialTheme.typography.bodyLarge,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                textAlign = TextAlign.End,
                maxLines = 2,
                modifier = Modifier.weight(1f),
            )
        }
    }
}
