package com.webyar.operator.ui.components

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDirection
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import com.webyar.operator.i18n.Format
import com.webyar.operator.i18n.Language
import com.webyar.operator.ui.design.Radius
import com.webyar.operator.ui.design.Size
import com.webyar.operator.ui.design.Space
import com.webyar.operator.ui.design.WebyarTheme

/**
 * The one prominent action on a screen.
 *
 * Full width, [Size.minTouchTarget] tall, and it swaps its label for a spinner
 * while busy **without changing size** — a button that shrinks under the thumb
 * mid-tap is how a mis-tap happens.
 */
@Composable
fun PrimaryButton(
    label: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    busy: Boolean = false,
) {
    Button(
        onClick = onClick,
        enabled = enabled && !busy,
        shape = RoundedCornerShape(Radius.md),
        contentPadding = PaddingValues(horizontal = Space.lg, vertical = Space.md),
        modifier = modifier
            .fillMaxWidth()
            // heightIn, not height: at a large font scale the label needs room
            // to grow, and a fixed height is how a button clips its own text
            // on exactly the devices where that matters most.
            .heightIn(min = Size.minTouchTarget),
    ) {
        if (busy) {
            CircularProgressIndicator(
                modifier = Modifier.size(20.dp),
                color = ButtonDefaults.buttonColors().contentColor,
                strokeWidth = 2.dp,
            )
        } else {
            Text(label, style = MaterialTheme.typography.labelLarge)
        }
    }
}

/** The quieter second action, where a screen has one. */
@Composable
fun SecondaryButton(
    label: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
) {
    OutlinedButton(
        onClick = onClick,
        enabled = enabled,
        shape = RoundedCornerShape(Radius.md),
        modifier = modifier.heightIn(min = Size.minTouchTarget),
    ) {
        Text(label, style = MaterialTheme.typography.labelLarge)
    }
}

/**
 * The inbox queue filter.
 *
 * A count rides in the label when there is one, because the whole reason to
 * glance at this control is to see where the work is.
 *
 * The queues come from the plan, not from an enum's own cases — a segment that
 * leads to a permanently empty list because the plan excludes it reads as a
 * broken app, not as an upsell.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun <T> FilterPicker(
    options: List<T>,
    selected: T,
    label: (T) -> String,
    count: (T) -> Int?,
    language: Language,
    onSelect: (T) -> Unit,
    modifier: Modifier = Modifier,
) {
    SingleChoiceSegmentedButtonRow(modifier.fillMaxWidth()) {
        options.forEachIndexed { index, option ->
            val badge = count(option)
            SegmentedButton(
                selected = option == selected,
                onClick = { onSelect(option) },
                shape = SegmentedButtonDefaults.itemShape(index, options.size),
            ) {
                Text(
                    text = if (badge != null && badge > 0) {
                        "${label(option)} ${Format.number(badge, language)}"
                    } else {
                        label(option)
                    },
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
    }
}

/**
 * Shown when a list legitimately has nothing in it.
 *
 * Centred as a block, with the body centre-aligned and width-limited so it
 * never runs edge to edge — a paragraph the full width of a tablet is a wall,
 * not a sentence.
 */
@Composable
fun EmptyState(
    icon: ImageVector,
    title: String,
    body: String?,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier
            .fillMaxWidth()
            .padding(Space.xl),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(Space.md),
    ) {
        Icon(
            icon,
            contentDescription = null,
            tint = WebyarTheme.colors.labelTertiary,
            modifier = Modifier.size(40.dp),
        )
        Text(title, style = MaterialTheme.typography.titleMedium, textAlign = TextAlign.Center)
        if (body != null) {
            Text(
                body,
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                textAlign = TextAlign.Center,
                modifier = Modifier.widthIn(max = 320.dp),
            )
        }
    }
}

/** Shown when a request failed and retrying is the sensible next step. */
@Composable
fun ErrorState(
    title: String,
    body: String?,
    retryLabel: String,
    onRetry: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier
            .fillMaxWidth()
            .padding(Space.xl),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(Space.md),
    ) {
        Text(
            title,
            style = MaterialTheme.typography.titleMedium,
            color = MaterialTheme.colorScheme.error,
            textAlign = TextAlign.Center,
        )
        if (body != null) {
            Text(
                body,
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                textAlign = TextAlign.Center,
                modifier = Modifier.widthIn(max = 320.dp),
            )
        }
        SecondaryButton(retryLabel, onRetry)
    }
}

/**
 * The unread counter on an inbox row.
 *
 * Digits follow the interface language: a Persian operator reads ۱۲۸, and a
 * badge is the one place a wrong digit set is unmissable.
 */
@Composable
fun UnreadBadge(count: Int, language: Language, modifier: Modifier = Modifier) {
    if (count <= 0) return
    Surface(
        color = WebyarTheme.colors.badge,
        contentColor = WebyarTheme.colors.onBadge,
        shape = RoundedCornerShape(Radius.pill),
        modifier = modifier,
    ) {
        Text(
            text = Format.number(count, language),
            style = MaterialTheme.typography.labelSmall,
            maxLines = 1,
            modifier = Modifier.padding(horizontal = Space.sm, vertical = Space.xxs),
        )
    }
}

/** A small status pill — "resolved", "AI", and similar. */
@Composable
fun StatusPill(
    label: String,
    modifier: Modifier = Modifier,
    tone: PillTone = PillTone.NEUTRAL,
) {
    val container = when (tone) {
        PillTone.NEUTRAL -> MaterialTheme.colorScheme.surfaceContainerHighest
        PillTone.SUCCESS -> WebyarTheme.colors.success.copy(alpha = 0.16f)
        PillTone.WARNING -> WebyarTheme.colors.warning.copy(alpha = 0.16f)
        PillTone.BRAND -> MaterialTheme.colorScheme.primaryContainer
    }
    val content = when (tone) {
        PillTone.NEUTRAL -> MaterialTheme.colorScheme.onSurfaceVariant
        PillTone.SUCCESS -> WebyarTheme.colors.success
        PillTone.WARNING -> WebyarTheme.colors.warning
        PillTone.BRAND -> MaterialTheme.colorScheme.onPrimaryContainer
    }
    Surface(
        color = container,
        contentColor = content,
        shape = RoundedCornerShape(Radius.pill),
        modifier = modifier,
    ) {
        Text(
            label,
            style = MaterialTheme.typography.labelSmall,
            maxLines = 1,
            modifier = Modifier.padding(horizontal = Space.sm, vertical = Space.xxs),
        )
    }
}

enum class PillTone { NEUTRAL, SUCCESS, WARNING, BRAND }

/**
 * A run of text that is Latin whatever the interface language is — an address,
 * a phone number, a version string.
 *
 * Reading `operator@webyar.app` right-to-left puts the domain first, which is
 * wrong in Persian and Turkish just as it would be in English. This sets the
 * text's own direction rather than the layout's, so the string reads correctly
 * while still sitting on the right edge of a Persian row where it belongs.
 */
@Composable
fun LatinText(
    text: String,
    modifier: Modifier = Modifier,
    style: TextStyle = MaterialTheme.typography.bodyMedium,
    color: androidx.compose.ui.graphics.Color = androidx.compose.ui.graphics.Color.Unspecified,
    maxLines: Int = Int.MAX_VALUE,
    /**
     * Where the run sits in the space it is given.
     *
     * Separate from the direction, and absolute: `End` inside a forced-LTR
     * style would resolve to the right even in Persian, which is the wrong
     * edge for a value column in an RTL screen.
     */
    align: TextAlign? = null,
) {
    Text(
        text = text,
        modifier = modifier,
        style = style.copy(textDirection = TextDirection.Ltr),
        color = color,
        maxLines = maxLines,
        textAlign = align ?: TextAlign.Unspecified,
        overflow = TextOverflow.Ellipsis,
    )
}

/**
 * Reading order from the TEXT, alignment from the LAYOUT.
 *
 * [LatinText] forces one direction, which is right for an address or a version
 * string and wrong for anything that could arrive in any language — a message
 * preview, a contact's name, a subject line.
 *
 * Compose resolves an unspecified `textDirection` from the layout, so a
 * Turkish sentence inside a Persian list is laid out right-to-left and the
 * bidi algorithm moves its trailing punctuation to the far end: «Tabii, hemen
 * kontrol ediyorum.» came out as «.Tabii, hemen kontrol ediyorum», with the
 * full stop leading. `Content` resolves from the first strong character
 * instead, which is what every other platform does by default.
 *
 * The alignment has to be pinned separately, and absolutely. `TextAlign.Start`
 * resolves against the text's OWN direction once that is content-derived, so a
 * Latin row would jump to the left edge of a Persian list while its Persian
 * neighbours stayed right. Left/Right do not resolve, so the column stays
 * straight whatever language lands in it.
 */
@Composable
fun TextStyle.bidiContent(): TextStyle = copy(
    textDirection = TextDirection.Content,
    textAlign = rowTextAlign(),
)

/**
 * The row's own leading edge, stated absolutely.
 *
 * `TextAlign.Start` is not the same thing: it resolves against the text's
 * direction, so the moment a run is forced or derived to LTR inside a Persian
 * screen it jumps to the left while its neighbours stay right. Left and Right
 * do not resolve, so a column of mixed-language values stays a column.
 */
@Composable
fun rowTextAlign(): TextAlign = when (LocalLayoutDirection.current) {
    LayoutDirection.Rtl -> TextAlign.Right
    LayoutDirection.Ltr -> TextAlign.Left
}

/**
 * A centred, quiet line inside a list — "nothing here yet", said without
 * making a scene of it.
 *
 * Not an [EmptyState]: that one owns a whole screen with an icon and a title.
 * This is one row saying one section is empty while the list carries on around
 * it.
 */
@Composable
fun QuietRow(text: String, modifier: Modifier = Modifier) {
    Box(
        modifier
            .fillMaxWidth()
            .padding(horizontal = Space.screenInset, vertical = Space.lg),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text,
            style = MaterialTheme.typography.bodyMedium,
            color = WebyarTheme.colors.labelTertiary,
            textAlign = TextAlign.Center,
        )
    }
}

/** A hairline, at the inset the rows use rather than edge to edge. */
@Composable
fun RowDivider(modifier: Modifier = Modifier, inset: Boolean = true) {
    androidx.compose.material3.HorizontalDivider(
        modifier = modifier.padding(start = if (inset) Space.screenInset else 0.dp),
        thickness = Size.hairline,
        color = MaterialTheme.colorScheme.outlineVariant,
    )
}
