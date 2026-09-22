package com.webyar.operator.feature.settings

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
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
import com.webyar.operator.ui.A11y
import com.webyar.operator.ui.components.PillTone
import com.webyar.operator.ui.components.PrimaryButton
import com.webyar.operator.ui.components.QuietRow
import com.webyar.operator.ui.components.RowDivider
import com.webyar.operator.ui.components.StatusPill
import com.webyar.operator.ui.design.Size
import com.webyar.operator.ui.design.Space

/**
 * The password, and everywhere this account is signed in.
 *
 * The two live together because they answer the same question — "is my account
 * still mine?" — and somebody who has just changed their password is exactly
 * the person who wants to see the other sessions and end them.
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
    LazyColumn(modifier.fillMaxWidth().imePadding()) {
        item {
            Column(
                Modifier.fillMaxWidth().padding(Space.screenInset),
            ) {
                Text(Str.changePassword(language), style = MaterialTheme.typography.titleMedium)
                OutlinedTextField(
                    value = currentPassword,
                    onValueChange = onCurrentPasswordChange,
                    label = { Text(Str.currentPassword(language)) },
                    singleLine = true,
                    enabled = !busy,
                    visualTransformation = PasswordVisualTransformation(),
                    modifier = Modifier.fillMaxWidth().padding(top = Space.md),
                )
                OutlinedTextField(
                    value = newPassword,
                    onValueChange = onNewPasswordChange,
                    label = { Text(Str.newPassword(language)) },
                    singleLine = true,
                    enabled = !busy,
                    visualTransformation = PasswordVisualTransformation(),
                    modifier = Modifier.fillMaxWidth().padding(top = Space.sm),
                )
                if (message != null) {
                    Text(
                        message,
                        style = MaterialTheme.typography.bodyMedium,
                        color = if (isError) {
                            MaterialTheme.colorScheme.error
                        } else {
                            com.webyar.operator.ui.design.WebyarTheme.colors.success
                        },
                        modifier = Modifier.padding(top = Space.sm),
                    )
                }
                PrimaryButton(
                    label = Str.changePassword(language),
                    onClick = onChangePassword,
                    busy = busy,
                    // The length rule is the server's; checking it here only
                    // saves a round trip, so the button stays honest about
                    // what it will accept rather than about what it will send.
                    enabled = currentPassword.isNotEmpty() && newPassword.length >= MIN_PASSWORD,
                    modifier = Modifier.padding(top = Space.lg),
                )
            }
        }

        item {
            Text(
                Str.activeSessions(language),
                style = MaterialTheme.typography.titleMedium,
                modifier = Modifier.padding(
                    start = Space.screenInset, end = Space.screenInset, top = Space.xl,
                ),
            )
        }

        if (sessions.isEmpty()) {
            item { QuietRow("—") }
        } else {
            items(sessions, key = { it.id }) { session ->
                SessionRow(
                    session = session,
                    language = language,
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
                            .padding(horizontal = Space.screenInset, vertical = Space.lg),
                    ) {
                        TextButton(
                            onClick = onRevokeOthers,
                            enabled = !busy,
                            modifier = Modifier.testTag(A11y.SECURITY_REVOKE_OTHERS),
                        ) {
                            Text(
                                Str.signOutOtherDevices(language),
                                color = MaterialTheme.colorScheme.error,
                            )
                        }
                        Text(
                            Str.signOutOtherDevicesHelp(language),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }
        }
    }
}

private const val MIN_PASSWORD = 8

@Composable
private fun SessionRow(
    session: AccountSession,
    language: Language,
    isCurrent: Boolean,
    onRevoke: () -> Unit,
) {
    Column {
        Row(
            Modifier
                .fillMaxWidth()
                .heightIn(min = Size.rowMinHeight)
                .padding(horizontal = Space.screenInset, vertical = Space.sm),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(Modifier.weight(1f).padding(end = Space.md)) {
                Text(
                    listOfNotNull(session.browser, session.os).joinToString(" · ").ifEmpty {
                        session.device ?: "—"
                    },
                    style = MaterialTheme.typography.bodyLarge,
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
        RowDivider()
    }
}
