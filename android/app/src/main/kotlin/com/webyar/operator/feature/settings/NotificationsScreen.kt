package com.webyar.operator.feature.settings

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material3.Button
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
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import com.webyar.operator.core.model.NotificationPrefs
import com.webyar.operator.core.model.NotificationPrefsUpdate
import com.webyar.operator.i18n.Format
import com.webyar.operator.i18n.Language
import com.webyar.operator.i18n.Str
import com.webyar.operator.i18n.StrManual
import com.webyar.operator.ui.A11y
import com.webyar.operator.ui.components.QuietRow
import com.webyar.operator.ui.components.SkeletonList
import com.webyar.operator.ui.design.Size
import com.webyar.operator.ui.design.Space
import java.util.TimeZone
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.filled.Notifications
import com.webyar.operator.ui.components.SegmentGap
import com.webyar.operator.ui.components.segmentedShape
import com.webyar.operator.ui.design.Radius
import com.webyar.operator.ui.design.WebyarType

/**
 * How an operator wants to be told that something happened.
 *
 * Same fifteen switches as the console's notifications page, in the same
 * three groups and the same order, worded identically — see the note over
 * the strings. What is different is the banner at the top: a phone can
 * refuse notifications outright, and a screen of switches that are all on
 * above a phone that stays silent is the worst thing this screen could be.
 *
 * No Save button, which is the console's choice too: a screen of switches
 * with a Save button is a screen people leave without saving. The switch
 * moves and the request follows; a refused request puts it back.
 */
@Composable
fun NotificationsScreen(
    language: Language,
    state: NotificationsState,
    /** Null where the platform has no such permission — API 32 and below. */
    systemPermission: SystemNotificationPermission?,
    onSet: (apply: (NotificationPrefs) -> NotificationPrefs, field: NotificationPrefsUpdate) -> Unit,
    onRetry: () -> Unit,
    modifier: Modifier = Modifier,
    contentPadding: PaddingValues = PaddingValues(),
) {
    val prefs = state.prefs

    if (prefs == null) {
        if (state.loading) {
            SkeletonList(modifier.padding(contentPadding), rows = 8, lines = 1)
        } else {
            Column(
                modifier.fillMaxWidth().padding(contentPadding),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                QuietRow(state.loadError ?: StrManual.notificationsLoadFailed(language))
                TextButton(onClick = onRetry, modifier = Modifier.testTag(A11y.NOTIFICATIONS_RETRY)) {
                    Text(Str.retry(language))
                }
            }
        }
        return
    }

    // Everything below the master switch is dead while it is on. Shown
    // rather than hidden: an operator who turned everything off should be
    // able to see what they turned off.
    val live = prefs.disableAll != true

    LazyColumn(
        modifier
            .fillMaxWidth()
            .testTag(A11y.NOTIFICATIONS_LIST),
        contentPadding = contentPadding,
        verticalArrangement = Arrangement.spacedBy(SegmentGap),
    ) {
        systemPermission?.takeIf { !it.granted }?.let { permission ->
            item { PermissionBanner(language, permission) }
        }

        item {
            Text(
                StrManual.notificationsIntro(language),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(
                    start = Space.screenInset,
                    end = Space.screenInset,
                    top = Space.lg,
                    bottom = Space.sm,
                ),
            )
        }

        prefs.disableAll?.let { disabled ->
            item {
                SwitchRow(
                    index = 0,
                    count = 1,
                    title = Str.pushMuteAll(language),
                    hint = Str.pushMuteAllFooter(language),
                    checked = disabled,
                    tag = A11y.NOTIFICATIONS_DISABLE_ALL,
                    onChange = { on ->
                        onSet({ it.copy(disableAll = on) }, NotificationPrefsUpdate(disableAll = on))
                    },
                )
            }
        }

        // MARK: - Push
        //
        // The group header is drawn only when the group has something in it.
        // Which keys that is depends on the server: see [NotificationPrefs].
        val push = listOfNotNull(
            prefs.pushScope, prefs.pushWhenOnline, prefs.pushWhenOffline,
            prefs.pushPreview, prefs.pushInternalNotes,
            prefs.playSound,
        )
        if (push.isNotEmpty()) {
            item {
                GroupHeader(
                    Str.notifications(language),
                    Str.pushPresenceFooter(language),
                )
            }
        }

        // The switches of the push group, in the order they are drawn, so
        // each knows where it sits in the group — the ends are rounded, the
        // joins are not.
        val pushSwitches = listOfNotNull(
            prefs.pushWhenOnline?.let { "online" },
            prefs.pushWhenOffline?.let { "offline" },
            prefs.pushInternalNotes?.let { "notes" },
            prefs.pushPreview?.let { "preview" },
            prefs.playSound?.let { "sound" },
        )
        fun at(key: String) = pushSwitches.indexOf(key)

        prefs.scope?.let { scope ->
            item {
                ScopeChoice(
                    language = language,
                    selected = scope,
                    enabled = live,
                    onSelect = { chosen ->
                        onSet(
                            { it.copy(pushScope = chosen.wire) },
                            NotificationPrefsUpdate(pushScope = chosen.wire),
                        )
                    },
                )
            }
        }

        prefs.pushWhenOnline?.let { on ->
            item {
                SwitchRow(
                    index = at("online"),
                    count = pushSwitches.size,
                    title = Str.pushWhenOnline(language),
                    checked = on,
                    enabled = live,
                    onChange = { value ->
                        onSet(
                            { it.copy(pushWhenOnline = value) },
                            NotificationPrefsUpdate(pushWhenOnline = value),
                        )
                    },
                )
            }
        }
        prefs.pushWhenOffline?.let { on ->
            item {
                SwitchRow(
                    index = at("offline"),
                    count = pushSwitches.size,
                    title = Str.pushWhenOffline(language),
                    checked = on,
                    enabled = live,
                    onChange = { value ->
                        onSet(
                            { it.copy(pushWhenOffline = value) },
                            NotificationPrefsUpdate(pushWhenOffline = value),
                        )
                    },
                )
            }
        }
        prefs.pushInternalNotes?.let { on ->
            item {
                SwitchRow(
                    index = at("notes"),
                    count = pushSwitches.size,
                    title = Str.pushInternalNotes(language),
                    checked = on,
                    enabled = live,
                    onChange = { value ->
                        onSet(
                            { it.copy(pushInternalNotes = value) },
                            NotificationPrefsUpdate(pushInternalNotes = value),
                        )
                    },
                )
            }
        }
        prefs.pushPreview?.let { on ->
            item {
                SwitchRow(
                    index = at("preview"),
                    count = pushSwitches.size,
                    title = Str.pushShowPreview(language),
                    hint = Str.pushShowPreviewFooter(language),
                    checked = on,
                    enabled = live,
                    tag = A11y.NOTIFICATIONS_PREVIEW,
                    onChange = { value ->
                        onSet(
                            { it.copy(pushPreview = value) },
                            NotificationPrefsUpdate(pushPreview = value),
                        )
                    },
                )
            }
        }
        prefs.playSound?.let { on ->
            item {
                SwitchRow(
                    index = at("sound"),
                    count = pushSwitches.size,
                    title = Str.pushSound(language),
                    checked = on,
                    enabled = live,
                    onChange = { value ->
                        onSet({ it.copy(playSound = value) }, NotificationPrefsUpdate(playSound = value))
                    },
                )
            }
        }


        // MARK: - Quiet hours
        prefs.quietHoursEnabled?.let { quiet ->
            item {
                GroupHeader(
                    Str.pushQuietHours(language),
                    Str.pushQuietFooter(language),
                )
            }
            item {
                SwitchRow(
                    index = 0,
                    count = if (quiet) 2 else 1,
                    title = StrManual.notificationsQuietEnable(language),
                    checked = quiet,
                    enabled = live,
                    tag = A11y.NOTIFICATIONS_QUIET_HOURS,
                    onChange = { on ->
                        onSet(
                            { it.copy(quietHoursEnabled = on) },
                            NotificationPrefsUpdate(
                                quietHoursEnabled = on,
                                // The window has to exist for the flag to mean
                                // anything, and the phone's own zone is the only
                                // one the operator has told us about.
                                quietHoursStart = prefs.quietHoursStart ?: DEFAULT_QUIET_START,
                                quietHoursEnd = prefs.quietHoursEnd ?: DEFAULT_QUIET_END,
                                quietHoursTimezone = prefs.quietHoursTimezone
                                    ?: TimeZone.getDefault().id,
                            ),
                        )
                    },
                )
            }
            if (quiet) {
                item {
                    QuietWindow(
                        index = 1,
                        count = 2,
                        language = language,
                        start = prefs.quietHoursStart ?: DEFAULT_QUIET_START,
                        end = prefs.quietHoursEnd ?: DEFAULT_QUIET_END,
                        enabled = live,
                        onStart = { value ->
                            onSet(
                                { it.copy(quietHoursStart = value) },
                                NotificationPrefsUpdate(quietHoursStart = value),
                            )
                        },
                        onEnd = { value ->
                            onSet(
                                { it.copy(quietHoursEnd = value) },
                                NotificationPrefsUpdate(quietHoursEnd = value),
                            )
                        },
                    )
                }
            }
        }

        item { StatusFooter(language, state) }
    }
}

/**
 * Which conversations are worth a notification.
 *
 * A choice, not a switch, so it is drawn as one — four rows with a tick, the
 * same shape the language and appearance pickers use two screens away.
 */
@Composable
private fun ScopeChoice(
    language: Language,
    selected: NotificationPrefs.Scope,
    enabled: Boolean,
    onSelect: (NotificationPrefs.Scope) -> Unit,
) {
    Column(
        Modifier.fillMaxWidth().padding(horizontal = Space.lg, vertical = Space.sm),
        verticalArrangement = Arrangement.spacedBy(SegmentGap),
    ) {
        Text(
            Str.pushScopeTitle(language),
            style = MaterialTheme.typography.labelLarge,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(horizontal = Space.lg, vertical = Space.xs),
        )
        val options = NotificationPrefs.Scope.entries
        options.forEachIndexed { index, option ->
            Surface(
                color = if (option == selected) {
                    MaterialTheme.colorScheme.secondaryContainer
                } else {
                    groupColor()
                },
                shape = segmentedShape(index, options.size),
                modifier = Modifier.fillMaxWidth(),
            ) {
                Row(
                    Modifier
                        .fillMaxWidth()
                        .clickable(enabled = enabled) { onSelect(option) }
                        .heightIn(min = Size.rowMinHeight)
                        .padding(horizontal = Space.lg, vertical = Space.sm)
                        .testTag(A11y.notificationsScope(option.wire)),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        when (option) {
                            NotificationPrefs.Scope.ALL -> Str.pushScopeAll(language)
                            NotificationPrefs.Scope.ASSIGNED -> Str.pushScopeAssigned(language)
                            NotificationPrefs.Scope.MENTIONS -> Str.pushScopeMentions(language)
                            NotificationPrefs.Scope.NONE -> Str.pushScopeNone(language)
                        },
                        style = if (option == selected) {
                            WebyarType.bodyLargeEmphasized
                        } else {
                            MaterialTheme.typography.bodyLarge
                        },
                        color = if (enabled) {
                            MaterialTheme.colorScheme.onSurface
                        } else {
                            MaterialTheme.colorScheme.onSurfaceVariant
                        },
                        modifier = Modifier.weight(1f),
                    )
                    if (option == selected) {
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
        }
    }
}

/** Midnight to seven, which is what "quiet hours" means to most people. */
private const val DEFAULT_QUIET_START = "22:00"
private const val DEFAULT_QUIET_END = "07:00"

/**
 * What the phone itself has decided, and how to change its mind.
 *
 * Two different situations, and they are not interchangeable: a permission
 * never asked for can be asked for, and one already refused can only be
 * changed in the system's own settings — Android will not show the dialog
 * again.
 */
data class SystemNotificationPermission(
    val granted: Boolean,
    /** False once the operator has refused; the dialog will not appear again. */
    val canAsk: Boolean,
    val onAsk: () -> Unit,
    val onOpenSettings: () -> Unit,
)

@Composable
private fun PermissionBanner(language: Language, permission: SystemNotificationPermission) {
    Surface(
        color = MaterialTheme.colorScheme.errorContainer,
        contentColor = MaterialTheme.colorScheme.onErrorContainer,
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = Space.lg, vertical = Space.md)
            .testTag(A11y.NOTIFICATIONS_PERMISSION),
        shape = RoundedCornerShape(Radius.xl),
    ) {
        Column(
            Modifier.padding(Space.lg),
            verticalArrangement = Arrangement.spacedBy(Space.xs),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(
                    Icons.Filled.Notifications,
                    contentDescription = null,
                    modifier = Modifier.padding(end = Space.sm),
                )
                Text(Str.pushDeniedTitle(language), style = WebyarType.titleMediumEmphasized)
            }
            Text(
                Str.pushDeniedBody(language),
                style = MaterialTheme.typography.bodySmall,
            )
            Box(Modifier.padding(top = Space.sm)) {
                if (permission.canAsk) {
                    Button(onClick = permission.onAsk) {
                        Text(Str.pushTurnOn(language))
                    }
                } else {
                    // Android will not show the dialog a second time, so the
                    // only honest offer left is the settings page itself.
                    Button(onClick = permission.onOpenSettings) {
                        Text(Str.pushOpenSettings(language))
                    }
                }
            }
        }
    }
}

@Composable
private fun GroupHeader(title: String, hint: String) {
    Column(
        Modifier.padding(
            start = Space.xxl,
            end = Space.xxl,
            top = Space.xl,
            bottom = Space.sm,
        ),
        verticalArrangement = Arrangement.spacedBy(Space.xxs),
    ) {
        Text(title, style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.primary)
        Text(
            hint,
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

@Composable
private fun SwitchRow(
    index: Int,
    count: Int,
    title: String,
    checked: Boolean,
    onChange: (Boolean) -> Unit,
    hint: String? = null,
    enabled: Boolean = true,
    tag: String? = null,
) {
    Surface(
        color = groupColor(),
        shape = segmentedShape(index, count),
        modifier = Modifier.fillMaxWidth().padding(horizontal = Space.lg),
    ) {
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
                    color = if (enabled) {
                        MaterialTheme.colorScheme.onSurface
                    } else {
                        MaterialTheme.colorScheme.onSurface.copy(alpha = 0.38f)
                    },
                )
                if (hint != null) {
                    Text(
                        hint,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
            // The Switch owns the semantics — a Row that was also toggleable
            // would announce the whole row as a switch AND contain one, which
            // a screen reader reads out twice — so it owns the test tag too.
            // A tag on the Row would name a node that is never disabled and
            // never on.
            Switch(
                checked = checked,
                onCheckedChange = onChange,
                enabled = enabled,
                thumbContent = if (checked) {
                    { Icon(Icons.Filled.Check, contentDescription = null, modifier = Modifier.size(16.dp)) }
                } else {
                    null
                },
                modifier = if (tag != null) Modifier.testTag(tag) else Modifier,
            )
        }
    }
}

/**
 * The two ends of the quiet window.
 *
 * Drawn left-to-right whatever the language — a span of time reads start-then-
 * end everywhere, the same reason the voice-note transport is pinned — and the
 * digits themselves are the reader's own.
 */
@Composable
private fun QuietWindow(
    index: Int,
    count: Int,
    language: Language,
    start: String,
    end: String,
    enabled: Boolean,
    onStart: (String) -> Unit,
    onEnd: (String) -> Unit,
) {
    Surface(
        color = groupColor(),
        shape = segmentedShape(index, count),
        modifier = Modifier.fillMaxWidth().padding(horizontal = Space.lg),
    ) {
    Row(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = Space.lg, vertical = Space.md),
        horizontalArrangement = Arrangement.spacedBy(Space.md),
    ) {
        TimeField(
            label = Str.pushQuietFrom(language),
            value = start,
            language = language,
            enabled = enabled,
            tag = A11y.NOTIFICATIONS_QUIET_START,
            onPick = onStart,
            modifier = Modifier.weight(1f),
        )
        TimeField(
            label = Str.pushQuietTo(language),
            value = end,
            language = language,
            enabled = enabled,
            tag = A11y.NOTIFICATIONS_QUIET_END,
            onPick = onEnd,
            modifier = Modifier.weight(1f),
        )
    }
    }
}

@Composable
private fun TimeField(
    label: String,
    value: String,
    language: Language,
    enabled: Boolean,
    tag: String,
    onPick: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    var picking by remember { mutableStateOf(false) }

    Column(modifier) {
        Text(
            label,
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Surface(
            color = MaterialTheme.colorScheme.surfaceContainerHighest,
            shape = RoundedCornerShape(Radius.lg),
            modifier = Modifier
                .fillMaxWidth()
                .padding(top = Space.xxs)
                .clickable(enabled = enabled) { picking = true }
                .testTag(tag),
        ) {
            Text(
                Format.clockLabel(value, language),
                style = WebyarType.titleLargeEmphasized,
                color = if (enabled) {
                    MaterialTheme.colorScheme.onSurface
                } else {
                    MaterialTheme.colorScheme.onSurfaceVariant
                },
                modifier = Modifier.padding(horizontal = Space.md, vertical = Space.md),
            )
        }
    }

    if (picking) {
        ClockPicker(
            language = language,
            value = value,
            onDismiss = { picking = false },
            onPick = {
                picking = false
                onPick(it)
            },
        )
    }
}

@Composable
private fun StatusFooter(language: Language, state: NotificationsState) {
    Column(
        Modifier
            .fillMaxWidth()
            .navigationBarsPadding()
            .padding(horizontal = Space.screenInset, vertical = Space.lg),
        verticalArrangement = Arrangement.spacedBy(Space.xs),
    ) {
        Text(
            when {
                state.isSaving -> StrManual.notificationsSaving(language)
                else -> StrManual.notificationsAutoSaved(language)
            },
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.testTag(A11y.NOTIFICATIONS_STATUS),
        )
        state.saveError?.let {
            Text(
                it,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.error,
                modifier = Modifier.testTag(A11y.NOTIFICATIONS_SAVE_ERROR),
            )
        }
    }
}
