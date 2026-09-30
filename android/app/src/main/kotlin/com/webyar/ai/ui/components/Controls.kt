package com.webyar.ai.ui.components

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
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
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.isSpecified
import com.webyar.ai.i18n.Format
import com.webyar.ai.i18n.Language
import com.webyar.ai.i18n.Str
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.scaleIn
import androidx.compose.animation.scaleOut
import androidx.compose.foundation.background
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.stateDescription
import com.webyar.ai.ui.design.Radius
import com.webyar.ai.ui.design.Size
import com.webyar.ai.ui.design.Space
import com.webyar.ai.ui.design.WebyarTheme
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.CornerSize
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.outlined.Info
import androidx.compose.material3.FilledTonalButton
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.sp
import com.webyar.ai.ui.design.ExpressiveShapes
import com.webyar.ai.ui.design.Motion
import com.webyar.ai.ui.design.WebyarType

/**
 * The one prominent action on a screen.
 *
 * Full width, 56dp — Material 3 Expressive's medium button — and a pill
 * that squares up under the finger, the Expressive press feedback. It swaps
 * its label for the loading indicator while busy **without changing size**:
 * a button that shrinks under the thumb mid-tap is how a mis-tap happens.
 */
@Composable
fun PrimaryButton(
    label: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    busy: Boolean = false,
) {
    val interaction = remember { MutableInteractionSource() }
    Button(
        onClick = onClick,
        enabled = enabled && !busy,
        shape = rememberPressShape(interaction),
        interactionSource = interaction,
        contentPadding = PaddingValues(horizontal = Space.xl, vertical = Space.md),
        modifier = modifier
            .fillMaxWidth()
            // heightIn, not height: at a large font scale the label needs room
            // to grow, and a fixed height is how a button clips its own text
            // on exactly the devices where that matters most.
            .heightIn(min = Size.buttonHeight),
    ) {
        if (busy) {
            LoadingIndicator(
                color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f),
                size = 28.dp,
            )
        } else {
            Text(label, style = WebyarType.labelLargeEmphasized.copy(fontSize = 16.sp))
        }
    }
}

/**
 * The quieter second action, where a screen has one — tonal, so it is plainly
 * a button without competing with the primary one.
 */
@Composable
fun SecondaryButton(
    label: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
) {
    val interaction = remember { MutableInteractionSource() }
    FilledTonalButton(
        onClick = onClick,
        enabled = enabled,
        shape = rememberPressShape(interaction),
        interactionSource = interaction,
        contentPadding = PaddingValues(horizontal = Space.xl, vertical = Space.sm),
        modifier = modifier.heightIn(min = Size.minTouchTarget),
    ) {
        Text(label, style = MaterialTheme.typography.labelLarge)
    }
}

/**
 * One choice out of a few — Material 3 Expressive's connected button group.
 *
 * Each option is its own button with a small gap between them. The selected
 * one is filled and fully round, the rest are tonal with softer corners, and
 * the shape morphs as the selection moves: the change is seen, not just
 * read. A count rides in the label when there is one, because the whole
 * reason to glance at this control is to see where the work is.
 *
 * The options come from the plan, not from an enum's own cases — a choice
 * that leads to a permanently empty list because the plan excludes it reads
 * as a broken app, not as an upsell.
 */
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
    Row(
        modifier
            .fillMaxWidth()
            .horizontalScroll(rememberScrollState())
            .selectableGroup(),
        horizontalArrangement = Arrangement.spacedBy(Space.xs),
    ) {
        options.forEach { option ->
            ChoiceButton(
                label = label(option),
                count = count(option),
                selected = option == selected,
                language = language,
                onClick = { onSelect(option) },
            )
        }
    }
}

/** One button of a [FilterPicker]. */
@Composable
fun ChoiceButton(
    label: String,
    selected: Boolean,
    language: Language,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    count: Int? = null,
    /**
     * How many things behind this button nobody has read — shown as a red
     * dot after the label (the number is TalkBack's). Zero, the ordinary
     * case, shows nothing.
     */
    unread: Int = 0,
    /**
     * Whether a selected button wears a tick before its label. Off on the
     * inbox strip, where the filled pill already says which inbox is open
     * and a tick on each would only push the labels along.
     */
    tick: Boolean = true,
    /**
     * The label's size, and the count's two points under it; unspecified is
     * the theme's. The inbox strip sets it smaller when that is what it takes
     * for every button to fit the width.
     */
    labelSize: TextUnit = TextUnit.Unspecified,
    /** The space either side of the label; the strip narrows it before it shrinks the text. */
    horizontalPadding: Dp = Space.lg,
    /**
     * Whether the label gives way to the count and the dot when the button is
     * narrower than its words. Only for a button the caller gives a bounded
     * width, as the inbox strip does: in a row that scrolls, the width is
     * unbounded and a label that gives way gets none — an empty button.
     */
    labelGivesWay: Boolean = false,
) {
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    // Selected: a full pill. Otherwise a softer rectangle, and squarer still
    // while pressed — the press "squish" the Expressive buttons have.
    val percent by animateFloatAsState(
        targetValue = when {
            pressed -> 18f
            selected -> 50f
            else -> 30f
        },
        animationSpec = Motion.fastSpatial(),
        label = "choiceShape",
    )
    val container by animateColorAsState(
        if (selected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.surfaceContainerHigh,
        Motion.effects(),
        label = "choiceContainer",
    )
    val content by animateColorAsState(
        if (selected) MaterialTheme.colorScheme.onPrimary else MaterialTheme.colorScheme.onSurfaceVariant,
        Motion.effects(),
        label = "choiceContent",
    )
    Surface(
        selected = selected,
        onClick = onClick,
        shape = percentShape(percent),
        color = container,
        contentColor = content,
        interactionSource = interaction,
        modifier = modifier
            .heightIn(min = 40.dp)
            .semantics {
                role = Role.RadioButton
                if (unread > 0) stateDescription = unreadDescription(unread, language)
            },
    ) {
        Row(
            Modifier.padding(horizontal = horizontalPadding, vertical = Space.sm),
            verticalAlignment = Alignment.CenterVertically,
            // Centred, for when the button is stretched across a row. The
            // tick brings its own gap in with it: a gap left standing beside
            // an invisible tick would push the label off-centre.
            horizontalArrangement = Arrangement.Center,
        ) {
            AnimatedVisibility(visible = tick && selected) {
                Row {
                    Icon(Icons.Filled.Check, contentDescription = null, modifier = Modifier.size(18.dp))
                    Spacer(Modifier.size(Space.sm))
                }
            }
            val labelStyle = if (selected) WebyarType.labelLargeEmphasized else MaterialTheme.typography.labelLarge
            Text(
                label,
                style = if (labelSize.isSpecified) labelStyle.copy(fontSize = labelSize) else labelStyle,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                // Measured after the count and the dot: in a button narrower
                // than its words, the label gives way and they do not.
                modifier = if (labelGivesWay) Modifier.weight(1f, fill = false) else Modifier,
            )
            if (count != null && count > 0) {
                Spacer(Modifier.size(Space.sm))
                Text(
                    Format.number(count, language),
                    style = MaterialTheme.typography.labelMedium.let {
                        if (labelSize.isSpecified) it.copy(fontSize = (labelSize.value - 2f).sp) else it
                    },
                    color = content.copy(alpha = 0.8f),
                    maxLines = 1,
                )
            }
            UnreadDot(
                visible = unread > 0,
                // Ringed in white on the selected pill: red straight on the
                // brand blue is two colours of one weight, and the dot drowns.
                ring = if (selected) MaterialTheme.colorScheme.onPrimary else Color.Transparent,
                modifier = Modifier.padding(start = Space.xs),
            )
        }
    }
}

/**
 * The red dot that marks a place holding something nobody has read: the
 * inbox strip's Open and Colleagues, a channel inbox in the menu. A dot, not
 * a number — the number is on the Inbox tab, and beside a button's own count
 * a second number reads as part of a sum.
 *
 * It grows in and shrinks away rather than blinking, so a dot that has just
 * gone is seen to go.
 */
@Composable
fun UnreadDot(visible: Boolean, modifier: Modifier = Modifier, ring: Color = Color.Transparent) {
    AnimatedVisibility(
        visible = visible,
        enter = scaleIn(initialScale = 0.3f) + fadeIn(),
        exit = scaleOut(targetScale = 0.3f) + fadeOut(),
        modifier = modifier,
    ) {
        Box(
            Modifier.size(UNREAD_DOT + UNREAD_RING * 2).background(ring, CircleShape),
            contentAlignment = Alignment.Center,
        ) {
            Box(Modifier.size(UNREAD_DOT).background(WebyarTheme.colors.badge, CircleShape))
        }
    }
}

private val UNREAD_DOT = 7.dp
private val UNREAD_RING = 1.5.dp

/** What TalkBack says of an unread badge or dot — "3 unread" — in the reader's digits. */
fun unreadDescription(count: Int, language: Language): String =
    Str.tabUnread(language).replace("{count}", Format.number(count, language))

/**
 * Shown when a list legitimately has nothing in it.
 *
 * The icon sits on one of the Expressive shapes, which is the difference
 * between "nothing here" said by a designed product and said by a blank
 * screen. Centred as a block, with the body centre-aligned and width-limited
 * so it never runs edge to edge — a paragraph the full width of a tablet is a
 * wall, not a sentence.
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
            .padding(horizontal = Space.xl, vertical = Space.xxl),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(Space.md),
    ) {
        ShapeFrame(
            polygon = ExpressiveShapes.softBurst,
            color = MaterialTheme.colorScheme.secondaryContainer,
            modifier = Modifier.size(104.dp),
        ) {
            Icon(
                icon,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.onSecondaryContainer,
                modifier = Modifier.size(36.dp),
            )
        }
        Text(
            title,
            style = WebyarType.titleLargeEmphasized,
            textAlign = TextAlign.Center,
            modifier = Modifier.padding(top = Space.sm),
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
            .padding(horizontal = Space.xl, vertical = Space.xxl),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(Space.md),
    ) {
        ShapeFrame(
            polygon = ExpressiveShapes.cookie4,
            color = MaterialTheme.colorScheme.errorContainer,
            modifier = Modifier.size(96.dp),
        ) {
            Icon(
                Icons.Outlined.Info,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.onErrorContainer,
                modifier = Modifier.size(34.dp),
            )
        }
        Text(
            title,
            style = WebyarType.titleLargeEmphasized,
            textAlign = TextAlign.Center,
            modifier = Modifier.padding(top = Space.sm),
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
        SecondaryButton(retryLabel, onRetry, Modifier.padding(top = Space.sm))
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
        color = MaterialTheme.colorScheme.primary,
        contentColor = MaterialTheme.colorScheme.onPrimary,
        shape = RoundedCornerShape(Radius.pill),
        modifier = modifier.defaultMinSize(minWidth = 22.dp, minHeight = 22.dp),
    ) {
        Box(contentAlignment = Alignment.Center) {
            Text(
                text = Format.number(count, language),
                style = WebyarType.labelLargeEmphasized.copy(fontSize = 12.sp, lineHeight = 16.sp),
                maxLines = 1,
                modifier = Modifier.padding(horizontal = 6.dp, vertical = 3.dp),
            )
        }
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
 * kontrol ediyorum.» comes out as «.Tabii, hemen kontrol ediyorum», with the
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
