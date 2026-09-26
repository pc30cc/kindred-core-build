package com.webyar.operator.feature.settings

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.input.PasswordVisualTransformation
import com.webyar.operator.core.model.AccountSession
import com.webyar.operator.i18n.Format
import com.webyar.operator.i18n.Language
import com.webyar.operator.i18n.Str
import com.webyar.operator.i18n.StrManual
import com.webyar.operator.ui.A11y
import com.webyar.operator.ui.components.FilledField
import com.webyar.operator.ui.components.PillTone
import com.webyar.operator.ui.components.PrimaryButton
import com.webyar.operator.ui.components.QuietRow
import com.webyar.operator.ui.components.StatusPill
import com.webyar.operator.ui.components.segmentedShape
import com.webyar.operator.ui.design.Size
import com.webyar.operator.ui.design.Space
import com.webyar.operator.ui.design.WebyarTheme
import com.webyar.operator.ui.design.WebyarType

/**
 * Everywhere this account is signed in, and the password.
 *
 * The two live together because they answer the same question — "is my account
 * still mine?" — and somebody who has just changed their password is exactly
 * the person who wants to see the other sessions and end them.
 *
 * The sessions come first: looking at where the account is signed in is the
 * thing done often, changing the password the thing done rarely. Both are
 * Android 16's grouped cards — each session a row of one group, the password
 * form a card of its own.
 */
@Composable
fun SecurityScreen(
    language: Language,
    currentPassword: String,
    newPassword: String,
    sessions: List<AccountSession>,
    currentSessionId: String?,
    busy: Boolean,
    message: String?,
    isError: Boolean,
    onCurrentPasswordChange: (String) -> Unit,
    onNewPasswordChange: (String) -> Unit,
    onChangePassword: () -> Unit,
    onRevoke: (AccountSession) -> Unit,
    onRevokeOthers: () -> Unit,
    modifier: Modifier = Modifier,
) {
    // `imePadding` for the two password fields: the Scaffold above passes the
    // system bars down in `modifier` but never the keyboard. Shortening the
    // list's viewport is what lets a focused field scroll clear of it.
    LazyColumn(
        modifier.fillMaxWidth().imePadding(),
        contentPadding = PaddingValues(bottom = Space.xl),
        verticalArrangement = Arrangement.spacedBy(SessionGap),
    ) {
        item { SectionHeader(Str.activeSessions(language)) }

        if (sessions.isEmpty()) {
            item { QuietRow("—") }
        } else {
            itemsIndexed(sessions, key = { _, it -> it.id }) { index, session ->
                SessionRow(
                    session = session,
                    language = language,
                    index = index,
                    count = sessions.size,
                    isCurrent = session.isCurrent == true || session.id == currentSessionId,
                    onRevoke = { onRevoke(session) },
                )
            }
            // Offered only when there is more than this device to end, so
            // the button never promises something it would not do.
            if (sessions.size > 1) {
                item {
                    Column(
                        Modifier
                            .fillMaxWidth()
                            .padding(horizontal = Space.lg, vertical = Space.md),
                        verticalArrangement = Arrangement.spacedBy(Space.sm),
                    ) {
                        FilledTonalButton(
                            onClick = onRevokeOthers,
                            enabled = !busy,
                            colors = ButtonDefaults.filledTonalButtonColors(
                                containerColor = MaterialTheme.colorScheme.errorContainer,
                                contentColor = MaterialTheme.colorScheme.onErrorContainer,
                            ),
                            modifier = Modifier.testTag(A11y.SECURITY_REVOKE_OTHERS),
                        ) {
                            Text(StrManual.signOutOtherDevices(language))
                        }
                        Text(
                            StrManual.signOutOtherDevicesHelp(language),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.padding(horizontal = Space.sm),
                        )
                    }
                }
            }
        }

        item { SectionHeader(Str.changePassword(language)) }

        item {
            Surface(
                color = groupColor(),
                shape = segmentedShape(0, 1),
                modifier = Modifier.fillMaxWidth().padding(horizontal = Space.lg),
            ) {
                Column(
                    Modifier.padding(Space.lg),
                    verticalArrangement = Arrangement.spacedBy(Space.sm),
                ) {
                    FilledField(
                        value = currentPassword,
                        onValueChange = onCurrentPasswordChange,
                        label = Str.currentPassword(language),
                        enabled = !busy,
                        visualTransformation = PasswordVisualTransformation(),
                        modifier = Modifier.fillMaxWidth(),
                    )
                    FilledField(
                        value = newPassword,
                        onValueChange = onNewPasswordChange,
                        label = Str.newPassword(language),
                        enabled = !busy,
                        visualTransformation = PasswordVisualTransformation(),
                        modifier = Modifier.fillMaxWidth(),
                    )
                    if (message != null) {
                        Text(
                            message,
                            style = MaterialTheme.typography.bodyMedium,
                            color = if (isError) {
                                MaterialTheme.colorScheme.error
                            } else {
                                WebyarTheme.colors.success
                            },
                        )
                    }
                    PrimaryButton(
                        label = Str.changePassword(language),
                        onClick = onChangePassword,
                        busy = busy,
                        // The length rule is the server's; checking it here
                        // only saves a round trip, so the button stays honest
                        // about what it will accept rather than about what it
                        // will send.
                        enabled = currentPassword.isNotEmpty() && newPassword.length >= MIN_PASSWORD,
                        modifier = Modifier.padding(top = Space.sm),
                    )
                }
            }
        }
    }
}

private const val MIN_PASSWORD = 8

/** Rows of one group sit this close; everything else is spaced by its own padding. */
private val SessionGap = com.webyar.operator.ui.components.SegmentGap

@Composable
private fun SessionRow(
    session: AccountSession,
    language: Language,
    index: Int,
    count: Int,
    isCurrent: Boolean,
    onRevoke: () -> Unit,
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
                    listOfNotNull(session.browser, session.os).joinToString(" · ").ifEmpty {
                        session.device ?: "—"
                    },
                    style = if (isCurrent) WebyarType.bodyLargeEmphasized else MaterialTheme.typography.bodyLarge,
                )
                val detail = listOfNotNull(
                    session.locationLabel,
                    session.lastActiveAt?.let { Format.listTimestamp(it, language) },
                ).joinToString(" · ")
                if (detail.isNotEmpty()) {
                    Text(
                        detail,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
            if (isCurrent) {
                // Never revocable: ending the session you are holding logs you
                // out mid-tap, which reads as a crash rather than as a choice.
                StatusPill(Str.thisDevice(language), tone = PillTone.BRAND)
            } else {
                TextButton(onClick = onRevoke) {
                    Text(Str.revokeSession(language), color = MaterialTheme.colorScheme.error)
                }
            }
        }
    }
}
