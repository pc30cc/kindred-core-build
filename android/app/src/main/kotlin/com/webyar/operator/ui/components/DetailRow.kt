package com.webyar.operator.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Icon
import androidx.compose.ui.Alignment
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.LineBreak
import androidx.compose.ui.unit.dp
import com.webyar.operator.ui.design.Size
import com.webyar.operator.ui.design.Space
import com.webyar.operator.ui.design.WebyarTheme

/**
 * One fact: what it is, then what it says.
 *
 * Stacked rather than side by side, which is where this started and where iOS
 * still is. A label beside its value splits a phone's width in two, and the
 * values on this screen are the ones least able to give any of it up: the test
 * fixture's address is 54 characters, and laid out beside «ایمیل» it wrapped
 * mid-token and then ellipsised what was left, so the one piece of information
 * the row existed to carry was the piece you could not read.
 *
 * Stacking gives the value the whole width, which is enough for any address
 * this app will meet, and costs a line of height on the short ones — a trade
 * worth making on a screen that is five rows long.
 *
 * [latin] says the value is the same string in every language — an address, a
 * number, a code, a browser name. Those are laid out left to right whatever
 * the interface is doing, because read the other way an address puts its
 * domain first, and still sit on the row's own edge.
 */
@Composable
fun DetailRow(
    label: String,
    value: String,
    modifier: Modifier = Modifier,
    latin: Boolean = false,
    icon: ImageVector? = null,
) {
    Row(
        modifier
            .fillMaxWidth()
            // A minimum rather than a height, so the row still grows when the
            // font scale does.
            .heightIn(min = Size.minTouchTarget + 8.dp)
            .padding(horizontal = Space.lg, vertical = Space.sm),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (icon != null) {
            // What kind of fact, at a glance: the tonal circle Android 16's
            // settings rows wear, so a column of facts scans by its icons.
            Box(
                Modifier
                    .size(40.dp)
                    .background(MaterialTheme.colorScheme.secondaryContainer, CircleShape),
                contentAlignment = Alignment.Center,
            ) {
                Icon(
                    icon,
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.onSecondaryContainer,
                    modifier = Modifier.size(20.dp),
                )
            }
            Spacer(Modifier.size(Space.lg))
        }
        DetailText(label, value, latin, Modifier.weight(1f))
    }
}

@Composable
private fun DetailText(label: String, value: String, latin: Boolean, modifier: Modifier) {
    Column(modifier, verticalArrangement = Arrangement.spacedBy(Space.xxs)) {
        Text(
            label,
            style = MaterialTheme.typography.labelMedium,
            color = WebyarTheme.colors.labelTertiary,
            maxLines = 1,
            modifier = Modifier.fillMaxWidth(),
        )
        if (latin) {
            LatinText(
                value,
                // A greedy break rather than the balanced one. An address is
                // one unbreakable token as far as the line breaker is
                // concerned, so it falls back to breaking mid-token either
                // way — and the balanced strategy spends that budget leaving
                // «alexander» alone on a line with half of it empty.
                style = MaterialTheme.typography.bodyLarge.copy(
                    lineBreak = LineBreak.Simple,
                ),
                color = MaterialTheme.colorScheme.onSurface,
                // Three lines is every address anyone has; past that the
                // string is not one a person is going to read off a screen.
                maxLines = 3,
                align = rowTextAlign(),
                modifier = Modifier.fillMaxWidth(),
            )
        } else {
            Text(
                value,
                style = MaterialTheme.typography.bodyLarge.bidiContent(),
                color = MaterialTheme.colorScheme.onSurface,
                maxLines = 3,
                modifier = Modifier.fillMaxWidth(),
            )
        }
    }
}
