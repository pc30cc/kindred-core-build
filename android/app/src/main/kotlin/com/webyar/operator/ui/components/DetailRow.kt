package com.webyar.operator.ui.components

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
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
) {
    Column(
        modifier
            .fillMaxWidth()
            // A minimum rather than a height, so the row still grows when the
            // font scale does.
            .heightIn(min = Size.minTouchTarget + 8.dp)
            .padding(horizontal = Space.screenInset, vertical = Space.sm),
        verticalArrangement = Arrangement.spacedBy(Space.xxs),
    ) {
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
                style = MaterialTheme.typography.bodyLarge,
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
