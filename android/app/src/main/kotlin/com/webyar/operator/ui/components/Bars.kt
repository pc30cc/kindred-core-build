package com.webyar.operator.ui.components

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledTonalIconButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.webyar.operator.ui.design.Size
import com.webyar.operator.ui.design.Space
import com.webyar.operator.ui.design.WebyarTheme
import com.webyar.operator.ui.design.WebyarType

/**
 * The head of a tab's first screen: the tab's name, large, and its actions
 * as tonal buttons at the end — Android 16's own apps, and the inbox.
 *
 * Not a TopAppBar: a root screen has no way back and the title is the page's
 * heading rather than a bar's label, so it is set big and left to scroll
 * away with the rest of the page where the page wants that.
 */
@Composable
fun LargeTitleHeader(
    title: String,
    modifier: Modifier = Modifier,
    actions: @Composable RowScope.() -> Unit = {},
) {
    Row(
        modifier
            .fillMaxWidth()
            .heightIn(min = 72.dp)
            .padding(start = Space.lg, end = Space.lg, top = Space.sm),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            title,
            style = WebyarType.headlineMediumEmphasized,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )
        actions()
    }
}

/** An action in a [LargeTitleHeader]: an icon on a tonal circle. */
@Composable
fun HeaderIconButton(
    icon: ImageVector,
    contentDescription: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    FilledTonalIconButton(onClick = onClick, modifier = modifier.size(Size.minTouchTarget)) {
        Icon(icon, contentDescription = contentDescription)
    }
}

/**
 * The bar every pushed screen wears: a way back, the screen's title, and
 * whatever the screen needs at the end.
 *
 * The title is the emphasized weight — the Expressive type scale's
 * "this is where you are" — and takes its reading order from its own text,
 * because on a contact it is whatever the contact typed.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DetailTopBar(
    title: String,
    backLabel: String,
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
    subtitle: String? = null,
    containerColor: Color = MaterialTheme.colorScheme.surface,
    leading: (@Composable () -> Unit)? = null,
    actions: @Composable RowScope.() -> Unit = {},
) {
    TopAppBar(
        title = {
            Row(verticalAlignment = Alignment.CenterVertically) {
                if (leading != null) {
                    leading()
                    androidx.compose.foundation.layout.Spacer(Modifier.size(Space.md))
                }
                Column {
                    Text(
                        title,
                        style = WebyarType.titleLargeEmphasized.bidiContent(),
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                    if (!subtitle.isNullOrEmpty()) {
                        // Whose mailbox, or which address: Latin in every
                        // language, so it is laid out as such.
                        LatinText(
                            subtitle,
                            style = MaterialTheme.typography.labelMedium,
                            color = WebyarTheme.colors.labelTertiary,
                            maxLines = 1,
                            align = rowTextAlign(),
                        )
                    }
                }
            }
        },
        navigationIcon = {
            IconButton(onClick = onBack) {
                // AutoMirrored: a back arrow points the way you came, and in
                // Persian that is the other way.
                Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = backLabel)
            }
        },
        actions = actions,
        colors = TopAppBarDefaults.topAppBarColors(
            containerColor = containerColor,
            scrolledContainerColor = MaterialTheme.colorScheme.surfaceContainer,
        ),
        modifier = modifier,
    )
}
