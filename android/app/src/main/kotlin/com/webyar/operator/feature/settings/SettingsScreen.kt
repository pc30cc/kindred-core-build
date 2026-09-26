package com.webyar.operator.feature.settings

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.automirrored.outlined.ExitToApp
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.Lock
import androidx.compose.material.icons.outlined.Notifications
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.webyar.operator.StorageUsage
import com.webyar.operator.core.model.Workspace
import com.webyar.operator.core.storage.Appearance
import com.webyar.operator.i18n.Format
import com.webyar.operator.i18n.Language
import com.webyar.operator.i18n.Str
import com.webyar.operator.i18n.StrAndroid
import com.webyar.operator.ui.A11y
import com.webyar.operator.ui.components.Avatar
import com.webyar.operator.ui.components.ChoiceButton
import com.webyar.operator.ui.components.LatinText
import com.webyar.operator.ui.components.SegmentGap
import com.webyar.operator.ui.components.ShapeFrame
import com.webyar.operator.ui.components.segmentedShape
import com.webyar.operator.ui.design.ExpressiveShapes
import com.webyar.operator.ui.design.Radius
import com.webyar.operator.ui.design.Size
import com.webyar.operator.ui.design.Space
import com.webyar.operator.ui.design.WebyarTheme
import com.webyar.operator.ui.design.WebyarType
import com.webyar.operator.ui.components.OperatorAvatar

/**
 * Everything the operator can change about their own account.
 *
 * Laid out the way Android 16's own settings are: a large title, then each
 * section as a group of rounded rows on a tonal page — fully round at the
 * ends of the group, only softly where two rows meet — so the page reads as
 * a handful of cards rather than one long ruled list. The account is a card
 * of its own at the top, the operator's picture framed in one of the
 * Expressive shapes.
 *
 * A list rather than a form: nothing here is saved together, so there is no
 * submit button and no draft state to lose. Each row commits on the spot,
 * which is also why the availability switches show the server's answer rather
 * than the thumb's — see [SettingsViewModel].
 */
@Composable
fun SettingsScreen(
    language: Language,
    appearance: Appearance,
    account: AccountHeader,
    workspaces: List<Workspace>,
    selectedWorkspace: Workspace?,
    planName: String?,
    availability: AvailabilityState,
    availabilitySaveFailed: Boolean,
    appVersion: String,
    onOpenProfile: () -> Unit,
    onOpenSecurity: () -> Unit,
    onOpenNotifications: () -> Unit,
    onSelectWorkspace: (Workspace) -> Unit,
    onSelectLanguage: (Language) -> Unit,
    onSelectAppearance: (Appearance) -> Unit,
    onSetForceOffline: (Boolean) -> Unit,
    onSetAvailableWhenUsingApp: (Boolean) -> Unit,
    onSetScheduleEnabled: (Boolean) -> Unit,
    onSignOut: () -> Unit,
    modifier: Modifier = Modifier,
    contentPadding: PaddingValues = PaddingValues(),
    /** What this phone holds, by kind; null while it is being measured. */
    storage: StorageUsage? = null,
    /** Clear Cache. Null leaves the Storage section out (previews, tests). */
    onClearCache: (() -> Unit)? = null,
    /**
     * Wallpaper colours (Material You). Null where the platform has none —
     * before Android 12 — which leaves the switch out.
     */
    dynamicColor: Boolean? = null,
    onSetDynamicColor: (Boolean) -> Unit = {},
    /** Super Admin can take the Notifications row out of the app. */
    showNotifications: Boolean = true,
    /** …and the Security row. With both gone, so is their section. */
    showSecurity: Boolean = true,
) {
    var confirmingSignOut by remember { mutableStateOf(false) }
    var confirmingClear by remember { mutableStateOf(false) }
    val page = settingsPageColor()
    val top = WindowInsets.statusBars.asPaddingValues().calculateTopPadding()

    LazyColumn(
        modifier.fillMaxSize().background(page),
        contentPadding = PaddingValues(
            top = top,
            bottom = Space.xxl + contentPadding.calculateBottomPadding(),
        ),
    ) {
        item {
            Text(
                Str.tabSettings(language),
                style = WebyarType.headlineLargeEmphasized,
                modifier = Modifier.padding(horizontal = Space.xl, vertical = Space.lg),
            )
        }

        item { AccountCard(account, onOpenProfile) }

        if (workspaces.isNotEmpty()) {
            item { SectionHeader(Str.workspace(language)) }
            item {
                Group {
                    val count = workspaces.size + if (planName != null) 1 else 0
                    workspaces.forEachIndexed { index, workspace ->
                        val isCurrent = workspace.id == selectedWorkspace?.id
                        GroupRow(
                            index = index,
                            count = count,
                            onClick = { onSelectWorkspace(workspace) },
                            selected = isCurrent,
                            modifier = Modifier.testTag(A11y.workspaceRow(workspace.id)),
                        ) {
                            // A logo, not a Picker. Settings used to put these
                            // behind one tap and show names only, and an
                            // operator with a second workspace could miss it
                            // entirely — a name on its own is not how anyone
                            // recognises their own company.
                            Avatar(name = workspace.name, imageUrl = workspace.logoUrl, size = 40.dp)
                            Text(
                                workspace.name,
                                style = MaterialTheme.typography.bodyLarge,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                                modifier = Modifier.weight(1f).padding(horizontal = Space.lg),
                            )
                            if (isCurrent) Tick()
                        }
                    }
                    if (planName != null) {
                        InfoRow(workspaces.size, count, Str.plan(language), planName)
                    }
                }
            }
        }

        item { SectionHeader(Str.language(language)) }
        item {
            // Three buttons side by side, the way Appearance is: one choice
            // out of three is a segmented control, not a list to scroll.
            Group {
                Surface(
                    color = groupColor(),
                    shape = segmentedShape(0, 1),
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Row(
                        Modifier
                            .selectableGroup()
                            .padding(horizontal = Space.md, vertical = Space.md),
                        horizontalArrangement = Arrangement.spacedBy(Space.xs),
                    ) {
                        Language.entries.forEach { option ->
                            // Each language names itself, which is the only
                            // form a picker should use: somebody looking for
                            // Türkçe is not looking for "Turkish".
                            ChoiceButton(
                                label = option.endonym,
                                selected = option == language,
                                language = language,
                                onClick = { onSelectLanguage(option) },
                                modifier = Modifier.weight(1f),
                            )
                        }
                    }
                }
            }
        }

        item { SectionHeader(Str.appearance(language)) }
        item {
            Group {
                val count = if (dynamicColor != null) 2 else 1
                Surface(
                    color = groupColor(),
                    shape = segmentedShape(0, count),
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Row(
                        Modifier
                            .selectableGroup()
                            .padding(horizontal = Space.md, vertical = Space.md),
                        horizontalArrangement = Arrangement.spacedBy(Space.xs),
                    ) {
                        Appearance.entries.forEach { option ->
                            ChoiceButton(
                                label = when (option) {
                                    Appearance.SYSTEM -> Str.appearanceSystem(language)
                                    Appearance.LIGHT -> Str.appearanceLight(language)
                                    Appearance.DARK -> Str.appearanceDark(language)
                                },
                                selected = option == appearance,
                                language = language,
                                onClick = { onSelectAppearance(option) },
                                modifier = Modifier.weight(1f),
                            )
                        }
                    }
                }
                if (dynamicColor != null) {
                    SwitchRow(
                        index = 1,
                        count = count,
                        title = StrAndroid.wallpaperColors(language),
                        hint = StrAndroid.wallpaperColorsBody(language),
                        checked = dynamicColor,
                        onChange = onSetDynamicColor,
                    )
                }
            }
        }

        item { SectionHeader(Str.availability(language)) }
        item {
            AvailabilitySection(
                language = language,
                state = availability,
                saveFailed = availabilitySaveFailed,
                onSetForceOffline = onSetForceOffline,
                onSetAvailableWhenUsingApp = onSetAvailableWhenUsingApp,
                onSetScheduleEnabled = onSetScheduleEnabled,
            )
        }

        if (showNotifications || showSecurity) {
            // Named for what is left in it when Super Admin has taken one out.
            item { SectionHeader(if (showNotifications) Str.notifications(language) else Str.security(language)) }
            item {
                Group {
                    val count = listOf(showNotifications, showSecurity).count { it }
                    if (showNotifications) {
                        NavRow(
                            index = 0,
                            count = count,
                            icon = Icons.Outlined.Notifications,
                            title = Str.notifications(language),
                            onClick = onOpenNotifications,
                            modifier = Modifier.testTag(A11y.SETTINGS_NOTIFICATIONS),
                        )
                    }
                    if (showSecurity) {
                        NavRow(
                            index = count - 1,
                            count = count,
                            icon = Icons.Outlined.Lock,
                            title = Str.security(language),
                            onClick = onOpenSecurity,
                            modifier = Modifier.testTag(A11y.SETTINGS_SECURITY),
                        )
                    }
                }
            }
        }

        if (onClearCache != null) {
            item { SectionHeader(StrAndroid.storage(language)) }
            item {
                fun size(bytes: Long?) = bytes?.let { Format.fileSize(it, language) } ?: StrAndroid.storageCalculating(language)
                Group(Modifier.testTag(A11y.SETTINGS_STORAGE)) {
                    InfoRow(0, 5, StrAndroid.storageConversations(language), size(storage?.conversationsBytes))
                    InfoRow(1, 5, StrAndroid.storageImages(language), size(storage?.imagesBytes))
                    InfoRow(2, 5, StrAndroid.storageMedia(language), size(storage?.mediaBytes))
                    InfoRow(3, 5, StrAndroid.storageTotal(language), size(storage?.totalBytes), emphasis = true)
                    NavRow(
                        index = 4,
                        count = 5,
                        icon = Icons.Outlined.Delete,
                        title = StrAndroid.clearCache(language),
                        onClick = { confirmingClear = true },
                        tint = MaterialTheme.colorScheme.primary,
                        chevron = false,
                        modifier = Modifier.testTag(A11y.SETTINGS_CLEAR_CACHE),
                    )
                }
            }
        }

        item { SectionHeader(Str.about(language)) }
        item {
            Group {
                InfoRow(0, 1, Str.version(language), appVersion, latin = true)
            }
        }

        item {
            Group(Modifier.padding(top = Space.xl)) {
                NavRow(
                    index = 0,
                    count = 1,
                    icon = Icons.AutoMirrored.Outlined.ExitToApp,
                    title = Str.signOut(language),
                    onClick = { confirmingSignOut = true },
                    tint = MaterialTheme.colorScheme.error,
                    chevron = false,
                )
            }
        }
    }

    if (confirmingClear && onClearCache != null) {
        AlertDialog(
            onDismissRequest = { confirmingClear = false },
            icon = { Icon(Icons.Outlined.Delete, contentDescription = null) },
            title = { Text(StrAndroid.clearCache(language)) },
            text = { Text(StrAndroid.clearCacheBody(language)) },
            confirmButton = {
                TextButton(
                    onClick = {
                        confirmingClear = false
                        onClearCache()
                    },
                    modifier = Modifier.testTag(A11y.SETTINGS_CLEAR_CACHE_CONFIRM),
                ) { Text(StrAndroid.clearCache(language)) }
            },
            dismissButton = {
                TextButton(onClick = { confirmingClear = false }) { Text(Str.cancel(language)) }
            },
        )
    }

    if (confirmingSignOut) {
        AlertDialog(
            onDismissRequest = { confirmingSignOut = false },
            icon = { Icon(Icons.AutoMirrored.Outlined.ExitToApp, contentDescription = null) },
            title = { Text(Str.signOut(language)) },
            text = { Text(Str.signOutConfirm(language)) },
            confirmButton = {
                TextButton(onClick = { confirmingSignOut = false; onSignOut() }) {
                    Text(Str.signOut(language), color = MaterialTheme.colorScheme.error)
                }
            },
            dismissButton = {
                TextButton(onClick = { confirmingSignOut = false }) { Text(Str.cancel(language)) }
            },
        )
    }
}

/** What the header row needs, without the screen knowing about `Account`. */
data class AccountHeader(val name: String, val email: String?, val avatarUrl: String?)

/**
 * The page behind the groups: a tone under the cards in light, the surface
 * itself in dark, where lifting the cards is what separates them.
 */
@Composable
internal fun settingsPageColor(): Color =
    if (MaterialTheme.colorScheme.surface.luminance() > 0.5f) {
        MaterialTheme.colorScheme.surfaceContainer
    } else {
        MaterialTheme.colorScheme.surface
    }

/** A group's rows. */
@Composable
internal fun groupColor(): Color =
    if (MaterialTheme.colorScheme.surface.luminance() > 0.5f) {
        MaterialTheme.colorScheme.surfaceContainerLowest
    } else {
        MaterialTheme.colorScheme.surfaceContainerHigh
    }

/** The operator's own card, at the top: a way into the profile. */
@Composable
private fun AccountCard(account: AccountHeader, onOpenProfile: () -> Unit) {
    Surface(
        onClick = onOpenProfile,
        color = groupColor(),
        shape = androidx.compose.foundation.shape.RoundedCornerShape(Radius.xl),
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = Space.lg),
    ) {
        Row(
            Modifier.padding(Space.lg),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            ShapeFrame(
                polygon = ExpressiveShapes.cookie9,
                color = MaterialTheme.colorScheme.primaryContainer,
                modifier = Modifier.size(72.dp),
            ) {
                OperatorAvatar(imageUrl = account.avatarUrl, size = 72.dp)
            }
            Column(Modifier.weight(1f).padding(horizontal = Space.lg)) {
                Text(
                    account.name,
                    style = WebyarType.titleLargeEmphasized,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                if (account.email != null) {
                    // An address read right-to-left puts the domain first.
                    LatinText(
                        account.email,
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 1,
                    )
                }
            }
            Chevron()
        }
    }
}

@Composable
internal fun SectionHeader(text: String) {
    Text(
        text = text,
        style = MaterialTheme.typography.labelLarge,
        color = MaterialTheme.colorScheme.primary,
        modifier = Modifier.padding(start = Space.xxl, end = Space.xxl, top = Space.xl, bottom = Space.sm),
    )
}

/** A group of rows, with the gap between them. */
@Composable
internal fun Group(modifier: Modifier = Modifier, content: @Composable ColumnScope.() -> Unit) {
    Column(
        modifier
            .fillMaxWidth()
            .padding(horizontal = Space.lg),
        verticalArrangement = Arrangement.spacedBy(SegmentGap),
        content = content,
    )
}

/**
 * A row of a group.
 *
 * [selected] non-null makes the row a choice (selectable, announced as
 * selected or not); null makes it a way in (clickable). The difference is
 * what a screen reader says: a choice announces whether it is the current
 * one — the whole point of the workspace list — while a way in announcing
 * "not selected" would be nonsense.
 */
@Composable
internal fun GroupRow(
    index: Int,
    count: Int,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    selected: Boolean? = null,
    role: Role? = null,
    content: @Composable RowScope.() -> Unit,
) {
    Surface(
        color = groupColor(),
        shape = segmentedShape(index, count),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Row(
            modifier
                .fillMaxWidth()
                .then(
                    if (selected == null) {
                        Modifier.clickable(onClick = onClick, role = role)
                    } else {
                        Modifier.selectable(selected = selected, onClick = onClick, role = role)
                    }
                )
                // heightIn, not height: at a large font scale a two-line name
                // has to be allowed to push the row taller rather than be
                // clipped by it.
                .heightIn(min = Size.rowMinHeight)
                .padding(horizontal = Space.lg, vertical = Space.sm),
            verticalAlignment = Alignment.CenterVertically,
            content = content,
        )
    }
}

/** A row that opens something: an icon on a tonal circle, a title, a chevron. */
@Composable
internal fun NavRow(
    index: Int,
    count: Int,
    icon: ImageVector,
    title: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    tint: Color = MaterialTheme.colorScheme.onSurface,
    chevron: Boolean = true,
) {
    GroupRow(index = index, count = count, onClick = onClick, modifier = modifier) {
        Box(
            Modifier
                .size(40.dp)
                .background(MaterialTheme.colorScheme.secondaryContainer, CircleShape),
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                icon,
                contentDescription = null,
                tint = if (tint == MaterialTheme.colorScheme.onSurface) MaterialTheme.colorScheme.onSecondaryContainer else tint,
                modifier = Modifier.size(22.dp),
            )
        }
        Text(
            title,
            style = MaterialTheme.typography.bodyLarge,
            color = tint,
            modifier = Modifier.weight(1f).padding(horizontal = Space.lg),
        )
        if (chevron) Chevron()
    }
}

/** A label and its value, not tappable. */
@Composable
internal fun InfoRow(
    index: Int,
    count: Int,
    label: String,
    value: String,
    latin: Boolean = false,
    emphasis: Boolean = false,
) {
    Surface(color = groupColor(), shape = segmentedShape(index, count), modifier = Modifier.fillMaxWidth()) {
        Row(
            Modifier
                .fillMaxWidth()
                .heightIn(min = Size.minTouchTarget + 8.dp)
                .padding(horizontal = Space.lg, vertical = Space.sm),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                label,
                style = if (emphasis) WebyarType.bodyLargeEmphasized else MaterialTheme.typography.bodyLarge,
                modifier = Modifier.weight(1f),
            )
            Spacer(Modifier.size(Space.md))
            if (latin) {
                LatinText(value, color = MaterialTheme.colorScheme.onSurfaceVariant)
            } else {
                Text(
                    value,
                    style = if (emphasis) WebyarType.bodyMediumEmphasized else MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

/**
 * A setting that is on or off. The Switch owns the semantics: a Row that was
 * also toggleable would announce the whole row as a switch AND contain one,
 * which a screen reader reads out twice.
 */
@Composable
internal fun SwitchRow(
    index: Int,
    count: Int,
    title: String,
    hint: String?,
    checked: Boolean,
    onChange: (Boolean) -> Unit,
    enabled: Boolean = true,
) {
    Surface(color = groupColor(), shape = segmentedShape(index, count), modifier = Modifier.fillMaxWidth()) {
        Row(
            Modifier
                .fillMaxWidth()
                .heightIn(min = Size.rowMinHeight)
                .padding(horizontal = Space.lg, vertical = Space.md),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(Modifier.weight(1f).padding(end = Space.md)) {
                Text(
                    title,
                    style = MaterialTheme.typography.bodyLarge,
                    color = if (enabled) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onSurface.copy(alpha = 0.38f),
                )
                if (hint != null) {
                    Text(
                        hint,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
            Switch(
                checked = checked,
                onCheckedChange = onChange,
                enabled = enabled,
                thumbContent = if (checked) {
                    { Icon(Icons.Filled.Check, contentDescription = null, modifier = Modifier.size(16.dp)) }
                } else {
                    null
                },
            )
        }
    }
}

@Composable
private fun Tick() {
    // The row already carries the Selected trait, so a second spoken
    // "selected" here would be a repeat.
    Icon(Icons.Filled.Check, contentDescription = null, tint = MaterialTheme.colorScheme.primary)
}

@Composable
internal fun Chevron() {
    Icon(
        Icons.AutoMirrored.Filled.KeyboardArrowRight,
        contentDescription = null,
        tint = WebyarTheme.colors.labelTertiary,
        modifier = Modifier.size(22.dp),
    )
}
