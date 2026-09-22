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
import androidx.compose.material3.Button
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
import com.webyar.operator.ui.A11y
import com.webyar.operator.ui.components.QuietRow
import com.webyar.operator.ui.components.RowDivider
import com.webyar.operator.ui.components.SkeletonList
import com.webyar.operator.ui.design.Size
import com.webyar.operator.ui.design.Space
import java.util.TimeZone

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
                QuietRow(state.loadError ?: Str.notificationsLoadFailed(language))
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
    val live = !prefs.disableAll

    LazyColumn(
        modifier
            .fillMaxWidth()
            .testTag(A11y.NOTIFICATIONS_LIST),
        contentPadding = contentPadding,
    ) {
        systemPermission?.takeIf { !it.granted }?.let { permission ->
            item { PermissionBanner(language, permission) }
        }

        item {
            Text(
                Str.notificationsIntro(language),
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

        item {
            SwitchRow(
                title = Str.notificationsDisableAll(language),
                hint = Str.notificationsDisableAllHelp(language),
                checked = prefs.disableAll,
                tag = A11y.NOTIFICATIONS_DISABLE_ALL,
                onChange = { on ->
                    onSet({ it.copy(disableAll = on) }, NotificationPrefsUpdate(disableAll = on))
                },
            )
        }

        item { GroupHeader(Str.notificationsPushTitle(language), Str.notificationsPushHint(language)) }
        item {
            SwitchRow(
                title = Str.notificationsNotifyOnline(language),
                checked = prefs.pushWhenOnline,
                enabled = live,
                onChange = { on ->
                    onSet({ it.copy(pushWhenOnline = on) }, NotificationPrefsUpdate(pushWhenOnline = on))
                },
            )
        }
        item {
            SwitchRow(
                title = Str.notificationsNotifyOffline(language),
                checked = prefs.pushWhenOffline,
                enabled = live,
                onChange = { on ->
                    onSet({ it.copy(pushWhenOffline = on) }, NotificationPrefsUpdate(pushWhenOffline = on))
                },
            )
        }
        item {
            SwitchRow(
                title = Str.notificationsNotifyVisitorBrowsing(language),
                checked = prefs.pushVisitorBrowsing,
                enabled = live,
                onChange = { on ->
                    onSet(
                        { it.copy(pushVisitorBrowsing = on) },
                        NotificationPrefsUpdate(pushVisitorBrowsing = on),
                    )
                },
            )
        }
        item {
            SwitchRow(
                title = Str.notificationsPlaySound(language),
                checked = prefs.playSound,
                enabled = live,
                onChange = { on ->
                    onSet({ it.copy(playSound = on) }, NotificationPrefsUpdate(playSound = on))
                },
            )
        }

        item { GroupHeader(Str.notificationsEmailTitle(language), Str.notificationsEmailHint(language)) }
        item {
            SwitchRow(
                title = Str.notificationsEmailUnread(language),
                checked = prefs.emailUnreadMessages,
                enabled = live,
                onChange = { on ->
                    onSet(
                        { it.copy(emailUnreadMessages = on) },
                        NotificationPrefsUpdate(emailUnreadMessages = on),
                    )
                },
            )
        }
        item {
            SwitchRow(
                title = Str.notificationsEmailTranscripts(language),
                checked = prefs.emailTranscripts,
                enabled = live,
                onChange = { on ->
                    onSet(
                        { it.copy(emailTranscripts = on) },
                        NotificationPrefsUpdate(emailTranscripts = on),
                    )
                },
            )
        }
        item {
            SwitchRow(
                title = Str.notificationsEmailRatings(language),
                checked = prefs.emailUserRatings,
                enabled = live,
                onChange = { on ->
                    onSet(
                        { it.copy(emailUserRatings = on) },
                        NotificationPrefsUpdate(emailUserRatings = on),
                    )
                },
            )
        }
        item {
            SwitchRow(
                title = Str.notificationsEmailInvoices(language),
                checked = prefs.emailPaidInvoices,
                enabled = live,
                onChange = { on ->
                    onSet(
                        { it.copy(emailPaidInvoices = on) },
                        NotificationPrefsUpdate(emailPaidInvoices = on),
                    )
                },
            )
        }
        item {
            SwitchRow(
                title = Str.notificationsEmailWeekly(language),
                checked = prefs.emailWeeklySummary,
                enabled = live,
                onChange = { on ->
                    onSet(
                        { it.copy(emailWeeklySummary = on) },
                        NotificationPrefsUpdate(emailWeeklySummary = on),
                    )
                },
            )
        }
        item {
            SwitchRow(
                title = Str.notificationsEmailProduct(language),
                checked = prefs.emailProductUpdates,
                enabled = live,
                onChange = { on ->
                    onSet(
                        { it.copy(emailProductUpdates = on) },
                        NotificationPrefsUpdate(emailProductUpdates = on),
                    )
                },
            )
        }

        item { GroupHeader(Str.notificationsQuietTitle(language), Str.notificationsQuietHint(language)) }
        item {
            SwitchRow(
                title = Str.notificationsQuietEnable(language),
                checked = prefs.quietHoursEnabled,
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
        if (prefs.quietHoursEnabled) {
            item {
                QuietWindow(
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

        item { StatusFooter(language, state) }
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
            .padding(horizontal = Space.screenInset, vertical = Space.md)
            .testTag(A11y.NOTIFICATIONS_PERMISSION),
        shape = MaterialTheme.shapes.medium,
    ) {
        Column(
            Modifier.padding(Space.lg),
            verticalArrangement = Arrangement.spacedBy(Space.xs),
        ) {
            Text(Str.notificationsBlocked(language), style = MaterialTheme.typography.titleSmall)
            Text(
                Str.notificationsBlockedHelp(language),
                style = MaterialTheme.typography.bodySmall,
            )
            Box(Modifier.padding(top = Space.sm)) {
                if (permission.canAsk) {
                    Button(onClick = permission.onAsk) {
                        Text(Str.notificationsAllow(language))
                    }
                } else {
                    // Android will not show the dialog a second time, so the
                    // only honest offer left is the settings page itself.
                    Button(onClick = permission.onOpenSettings) {
                        Text(Str.notificationsOpenSystemSettings(language))
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
            start = Space.screenInset,
            end = Space.screenInset,
            top = Space.xl,
            bottom = Space.xs,
        ),
    ) {
        Text(title, style = MaterialTheme.typography.titleSmall)
        Text(
            hint,
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

@Composable
private fun SwitchRow(
    title: String,
    checked: Boolean,
    onChange: (Boolean) -> Unit,
    hint: String? = null,
    enabled: Boolean = true,
    tag: String? = null,
) {
    Column {
        Row(
            Modifier
                .fillMaxWidth()
                .heightIn(min = Size.rowMinHeight)
                .padding(horizontal = Space.screenInset, vertical = Space.sm)
                .then(if (tag != null) Modifier.testTag(tag) else Modifier),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(Modifier.weight(1f).padding(end = Space.md)) {
                Text(title, style = MaterialTheme.typography.bodyLarge)
                if (hint != null) {
                    Text(
                        hint,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
            // The Switch owns the semantics: a Row that was also toggleable
            // would announce the whole row as a switch AND contain one, which
            // a screen reader reads out twice.
            Switch(checked = checked, onCheckedChange = onChange, enabled = enabled)
        }
        RowDivider()
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
    language: Language,
    start: String,
    end: String,
    enabled: Boolean,
    onStart: (String) -> Unit,
    onEnd: (String) -> Unit,
) {
    Row(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = Space.screenInset, vertical = Space.sm),
        horizontalArrangement = Arrangement.spacedBy(Space.md),
    ) {
        TimeField(
            label = Str.notificationsQuietStart(language),
            value = start,
            language = language,
            enabled = enabled,
            tag = A11y.NOTIFICATIONS_QUIET_START,
            onPick = onStart,
            modifier = Modifier.weight(1f),
        )
        TimeField(
            label = Str.notificationsQuietEnd(language),
            value = end,
            language = language,
            enabled = enabled,
            tag = A11y.NOTIFICATIONS_QUIET_END,
            onPick = onEnd,
            modifier = Modifier.weight(1f),
        )
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
            shape = MaterialTheme.shapes.small,
            modifier = Modifier
                .fillMaxWidth()
                .padding(top = Space.xxs)
                .clickable(enabled = enabled) { picking = true }
                .testTag(tag),
        ) {
            Text(
                Format.clockLabel(value, language),
                style = MaterialTheme.typography.bodyLarge,
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
                state.isSaving -> Str.notificationsSaving(language)
                else -> Str.notificationsAutoSaved(language)
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
