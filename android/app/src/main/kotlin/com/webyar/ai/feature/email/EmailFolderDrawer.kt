package com.webyar.ai.feature.email

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Email
import androidx.compose.material.icons.filled.Star
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalDrawerSheet
import androidx.compose.material3.NavigationDrawerItem
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.webyar.ai.core.model.EmailMailFolder
import com.webyar.ai.core.model.EmailMailbox
import com.webyar.ai.i18n.Format
import com.webyar.ai.i18n.Language
import com.webyar.ai.i18n.StrEmail
import com.webyar.ai.ui.A11y
import com.webyar.ai.ui.components.Glyph
import com.webyar.ai.ui.components.LatinText
import com.webyar.ai.ui.components.bidiContent
import com.webyar.ai.ui.components.rowTextAlign
import com.webyar.ai.ui.design.Space
import com.webyar.ai.ui.design.WebyarTheme

/**
 * A mailbox's folders, the way a mail client keeps them behind its ☰: the
 * mailbox on top (and the others, when a Gmail and a Yahoo are both
 * connected), then Inbox, Starred, Important, Sent, Drafts, All mail, Spam and
 * Trash — as many as the mailbox has — then its own labels by name.
 *
 * Each with the number a mail client puts there: unread for Inbox, Spam and a
 * label, how many drafts for Drafts. It slides in from the reading side,
 * which in Persian is the right.
 */
@Composable
fun EmailFolderDrawer(
    language: Language,
    folders: List<EmailMailFolder>,
    selected: String,
    onSelect: (String) -> Unit,
    modifier: Modifier = Modifier,
    mailboxes: List<EmailMailbox> = emptyList(),
    selectedMailbox: String? = null,
    onSelectMailbox: (String) -> Unit = {},
) {
    val shown = mailboxes.firstOrNull { it.provider == selectedMailbox } ?: mailboxes.firstOrNull()
    val system = folders.filterNot { it.isLabel }
    val labels = folders.filter { it.isLabel }
    ModalDrawerSheet(modifier.widthIn(max = 320.dp).fillMaxHeight()) {
        LazyColumn(Modifier.testTag(A11y.EMAIL_DRAWER), contentPadding = PaddingValues(bottom = Space.lg)) {
            item {
                DrawerHeader(shown)
            }
            if (mailboxes.size > 1) {
                item { SectionTitle(StrEmail.mailboxes(language)) }
                items(mailboxes, key = { "mailbox:${it.provider}" }) { box ->
                    NavigationDrawerItem(
                        icon = { Icon(Icons.Filled.Email, contentDescription = null) },
                        label = {
                            LatinText(
                                box.address?.takeIf { it.isNotBlank() } ?: providerName(box.provider),
                                maxLines = 1,
                                align = rowTextAlign(),
                            )
                        },
                        badge = box.unread?.takeIf { it > 0 }?.let { { Count(it, language) } },
                        selected = box.provider == shown?.provider,
                        onClick = { onSelectMailbox(box.provider) },
                        modifier = Modifier
                            .padding(horizontal = Space.sm)
                            .testTag(A11y.emailMailbox(box.provider)),
                    )
                }
                item { HorizontalDivider(Modifier.padding(horizontal = Space.lg, vertical = Space.sm)) }
            }
            items(system, key = { it.id }) { folder ->
                FolderItem(
                    icon = iconOf(folder.id),
                    label = StrEmail.folderName(language, folder.id) ?: folder.id,
                    count = countOf(folder),
                    selected = folder.id == selected,
                    language = language,
                    onClick = { onSelect(folder.id) },
                    tag = A11y.emailMailFolder(folder.id),
                )
            }
            if (labels.isNotEmpty()) {
                item {
                    HorizontalDivider(Modifier.padding(horizontal = Space.lg, vertical = Space.sm))
                    SectionTitle(StrEmail.labels(language))
                }
                items(labels, key = { it.id }) { folder ->
                    FolderItem(
                        icon = Glyph.Label,
                        label = folder.name ?: folder.id.removePrefix("label:"),
                        count = countOf(folder),
                        selected = folder.id == selected,
                        language = language,
                        onClick = { onSelect(folder.id) },
                        tag = A11y.emailMailFolder(folder.id),
                    )
                }
            }
        }
    }
}

@Composable
private fun DrawerHeader(mailbox: EmailMailbox?) {
    Row(
        Modifier.padding(start = Space.xl, end = Space.lg, top = Space.xl, bottom = Space.md),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Space.md),
    ) {
        MailAvatar(address = mailbox?.address ?: mailbox?.provider ?: "mail", size = 40.dp)
        Column {
            Text(
                providerName(mailbox?.provider),
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.SemiBold,
            )
            mailbox?.address?.takeIf { it.isNotBlank() }?.let {
                LatinText(
                    it,
                    style = MaterialTheme.typography.bodySmall,
                    color = WebyarTheme.colors.labelTertiary,
                    maxLines = 1,
                    align = rowTextAlign(),
                )
            }
        }
    }
}

@Composable
private fun SectionTitle(text: String) {
    Text(
        text,
        style = MaterialTheme.typography.labelLarge,
        color = WebyarTheme.colors.labelTertiary,
        modifier = Modifier.padding(start = Space.xl, end = Space.xl, top = Space.sm, bottom = Space.xs),
    )
}

@Composable
private fun FolderItem(
    icon: ImageVector,
    label: String,
    count: Int?,
    selected: Boolean,
    language: Language,
    onClick: () -> Unit,
    tag: String,
) {
    NavigationDrawerItem(
        icon = { Icon(icon, contentDescription = null, modifier = Modifier.size(22.dp)) },
        label = {
            Text(
                label,
                style = MaterialTheme.typography.bodyLarge.bidiContent(),
                fontWeight = if (count != null) FontWeight.SemiBold else null,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        },
        badge = count?.let { { Count(it, language) } },
        selected = selected,
        onClick = onClick,
        modifier = Modifier.padding(horizontal = Space.sm).testTag(tag),
    )
}

@Composable
private fun Count(value: Int, language: Language) {
    Text(
        Format.number(value, language),
        style = MaterialTheme.typography.labelLarge,
        fontWeight = FontWeight.SemiBold,
    )
}

/** Unread where a mail client shows it; for Drafts, how many there are. */
private fun countOf(folder: EmailMailFolder): Int? =
    (if (folder.id == "drafts") folder.total else folder.unread)?.takeIf { it > 0 }

private fun iconOf(id: String): ImageVector = when (id) {
    "inbox" -> Glyph.Inbox
    "starred" -> Icons.Filled.Star
    "important" -> Glyph.LabelImportant
    "sent" -> Icons.AutoMirrored.Filled.Send
    "drafts" -> Glyph.Drafts
    "spam" -> Glyph.Report
    "trash" -> Icons.Filled.Delete
    else -> Icons.Filled.Email
}

private fun providerName(provider: String?): String = when (provider) {
    "yahoo" -> "Yahoo Mail"
    else -> "Gmail"
}
