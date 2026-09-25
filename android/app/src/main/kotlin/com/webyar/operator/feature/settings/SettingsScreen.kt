package com.webyar.operator.feature.settings

import com.webyar.operator.StorageUsage
import com.webyar.operator.i18n.StrAndroid
import com.webyar.operator.i18n.Format
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Check
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
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
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.webyar.operator.core.model.Workspace
import com.webyar.operator.core.storage.Appearance
import com.webyar.operator.i18n.Language
import com.webyar.operator.i18n.Str
import com.webyar.operator.ui.A11y
import com.webyar.operator.ui.components.Avatar
import com.webyar.operator.ui.components.LatinText
import com.webyar.operator.ui.components.RowDivider
import com.webyar.operator.ui.components.StatusPill
import com.webyar.operator.ui.components.PillTone
import com.webyar.operator.ui.design.Size
import com.webyar.operator.ui.design.Space
import com.webyar.operator.ui.design.WebyarTheme

/**
 * Everything the operator can change about their own account.
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
) {
    var confirmingSignOut by remember { mutableStateOf(false) }
    var confirmingClear by remember { mutableStateOf(false) }

    LazyColumn(modifier.fillMaxWidth(), contentPadding = contentPadding) {

        item { SectionHeader(Str.account(language)) }
        item {
            SettingsRow(onClick = onOpenProfile) {
                Avatar(name = account.name, imageUrl = account.avatarUrl, size = Size.avatarMedium)
                Column(Modifier.weight(1f).padding(horizontal = Space.md)) {
                    Text(
                        account.name,
                        style = MaterialTheme.typography.titleMedium,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                    if (account.email != null) {
                        // An address read right-to-left puts the domain first.
                        LatinText(
                            account.email,
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            maxLines = 1,
                        )
                    }
                }
                Chevron()
            }
        }

        if (workspaces.isNotEmpty()) {
            item { SectionHeader(Str.workspace(language)) }
            items(workspaces, key = { it.id }) { workspace ->
                val isCurrent = workspace.id == selectedWorkspace?.id
                SettingsRow(
                    onClick = { onSelectWorkspace(workspace) },
                    selected = isCurrent,
                    modifier = Modifier.testTag(A11y.workspaceRow(workspace.id)),
                ) {
                    // A logo, not a Picker. Settings used to put these behind
                    // one tap and show names only, and an operator with a
                    // second workspace could miss it entirely — a name on its
                    // own is not how anyone recognises their own company.
                    Avatar(
                        name = workspace.name,
                        imageUrl = workspace.logoUrl,
                        size = Size.avatarSmall,
                    )
                    Text(
                        workspace.name,
                        style = MaterialTheme.typography.bodyLarge,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f).padding(horizontal = Space.md),
                    )
                    if (isCurrent) {
                        Icon(
                            Icons.Filled.Check,
                            // The row already carries the Selected trait, so a
                            // second spoken "selected" here would be a repeat.
                            contentDescription = null,
                            tint = MaterialTheme.colorScheme.primary,
                        )
                    }
                }
            }
            if (planName != null) {
                item { DetailRow(Str.plan(language), planName) }
            }
        }

        item { SectionHeader(Str.language(language)) }
        items(Language.entries, key = { "lang-${it.code}" }) { option ->
            ChoiceRow(
                // Each language names itself, which is the only form a picker
                // should use: somebody looking for Türkçe is not looking for
                // "Turkish".
                label = option.endonym,
                selected = option == language,
                onClick = { onSelectLanguage(option) },
            )
        }

        item { SectionHeader(Str.appearance(language)) }
        items(Appearance.entries, key = { "appearance-${it.key}" }) { option ->
            ChoiceRow(
                label = when (option) {
                    Appearance.SYSTEM -> Str.appearanceSystem(language)
                    Appearance.LIGHT -> Str.appearanceLight(language)
                    Appearance.DARK -> Str.appearanceDark(language)
                },
                selected = option == appearance,
                onClick = { onSelectAppearance(option) },
            )
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

        item { SectionHeader(Str.notifications(language)) }
        item {
            SettingsRow(
                onClick = onOpenNotifications,
                modifier = Modifier.testTag(A11y.SETTINGS_NOTIFICATIONS),
            ) {
                Text(
                    Str.notifications(language),
                    style = MaterialTheme.typography.bodyLarge,
                    modifier = Modifier.weight(1f),
                )
                Chevron()
            }
        }

        item { SectionHeader(Str.security(language)) }
        item {
            SettingsRow(onClick = onOpenSecurity) {
                Text(
                    Str.security(language),
                    style = MaterialTheme.typography.bodyLarge,
                    modifier = Modifier.weight(1f),
                )
                Chevron()
            }
        }
        item {
            SettingsRow(onClick = { confirmingSignOut = true }) {
                Text(
                    Str.signOut(language),
                    style = MaterialTheme.typography.bodyLarge,
                    color = MaterialTheme.colorScheme.error,
                    modifier = Modifier.weight(1f),
                )
            }
        }

        if (onClearCache != null) {
            item { SectionHeader(StrAndroid.storage(language)) }
            item {
                fun size(bytes: Long?) = bytes?.let { Format.fileSize(it, language) } ?: StrAndroid.storageCalculating(language)
                Column(Modifier.testTag(A11y.SETTINGS_STORAGE)) {
                    DetailRow(StrAndroid.storageConversations(language), size(storage?.conversationsBytes))
                    DetailRow(StrAndroid.storageImages(language), size(storage?.imagesBytes))
                    DetailRow(StrAndroid.storageMedia(language), size(storage?.mediaBytes))
                    DetailRow(StrAndroid.storageTotal(language), size(storage?.totalBytes))
                }
            }
            item {
                SettingsRow(
                    onClick = { confirmingClear = true },
                    modifier = Modifier.testTag(A11y.SETTINGS_CLEAR_CACHE),
                ) {
                    Text(
                        StrAndroid.clearCache(language),
                        style = MaterialTheme.typography.bodyLarge,
                        color = MaterialTheme.colorScheme.primary,
                        modifier = Modifier.weight(1f),
                    )
                }
            }
        }

        item { SectionHeader(Str.about(language)) }
        item { DetailRow(Str.version(language), appVersion, latin = true) }
    }

    if (confirmingClear && onClearCache != null) {
        AlertDialog(
            onDismissRequest = { confirmingClear = false },
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

@Composable
private fun SectionHeader(text: String) {
    Text(
        text = text,
        style = MaterialTheme.typography.labelMedium,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.padding(
            start = Space.screenInset,
            end = Space.screenInset,
            top = Space.xl,
            bottom = Space.sm,
        ),
    )
}

/**
 * A row of the list.
 *
 * [selectable] where the row IS a choice, [clickable] where it is a way in,
 * and the difference is what a screen reader says: a selectable row announces
 * whether it is the current one — which is the whole point of the workspace
 * list — while a navigation row announcing "not selected" would be nonsense.
 */
@Composable
private fun SettingsRow(
    onClick: () -> Unit,
    selected: Boolean? = null,
    modifier: Modifier = Modifier,
    content: @Composable RowScope.() -> Unit,
) {
    Column {
        Row(
            modifier
                .fillMaxWidth()
                .then(
                    if (selected == null) {
                        Modifier.clickable(onClick = onClick)
                    } else {
                        Modifier.selectable(selected = selected, onClick = onClick)
                    }
                )
                // heightIn, not height: at a large font scale a two-line name
                // has to be allowed to push the row taller rather than be
                // clipped by it.
                .heightIn(min = Size.rowMinHeight)
                .padding(horizontal = Space.screenInset, vertical = Space.sm),
            verticalAlignment = Alignment.CenterVertically,
            content = content,
        )
        RowDivider()
    }
}

@Composable
private fun ChoiceRow(label: String, selected: Boolean, onClick: () -> Unit) {
    Column {
        Row(
            Modifier
                .fillMaxWidth()
                .selectable(
                    selected = selected,
                    role = Role.RadioButton,
                    onClick = onClick,
                )
                .heightIn(min = Size.minTouchTarget)
                .padding(horizontal = Space.screenInset, vertical = Space.sm),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(label, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.weight(1f))
            if (selected) {
                Icon(
                    Icons.Filled.Check,
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.primary,
                )
            }
        }
        RowDivider()
    }
}

@Composable
private fun DetailRow(label: String, value: String, latin: Boolean = false) {
    Column {
        Row(
            Modifier
                .fillMaxWidth()
                .heightIn(min = Size.minTouchTarget)
                .padding(horizontal = Space.screenInset, vertical = Space.sm),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            Text(label, style = MaterialTheme.typography.bodyLarge)
            if (latin) {
                LatinText(value, color = MaterialTheme.colorScheme.onSurfaceVariant)
            } else {
                Text(
                    value,
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        RowDivider()
    }
}

@Composable
private fun Chevron() {
    Icon(
        Icons.AutoMirrored.Filled.KeyboardArrowRight,
        contentDescription = null,
        tint = WebyarTheme.colors.labelTertiary,
        modifier = Modifier.size(20.dp),
    )
}
