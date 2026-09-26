package com.webyar.operator.feature.chat

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.webyar.operator.core.model.AiState
import com.webyar.operator.core.model.CallChannels
import com.webyar.operator.core.model.Conversation
import com.webyar.operator.core.model.ConversationNote
import com.webyar.operator.core.model.ConversationPriority
import com.webyar.operator.core.model.ConversationStatus
import com.webyar.operator.core.model.WorkspaceMember
import com.webyar.operator.core.net.Assignee
import com.webyar.operator.i18n.Format
import com.webyar.operator.i18n.Language
import com.webyar.operator.i18n.Str
import com.webyar.operator.i18n.StrAndroid
import com.webyar.operator.ui.A11y
import com.webyar.operator.ui.components.Avatar
import com.webyar.operator.ui.components.PillTone
import com.webyar.operator.ui.components.PrimaryButton
import com.webyar.operator.ui.components.QuietRow
import com.webyar.operator.ui.components.RowDivider
import com.webyar.operator.ui.components.StatusPill
import com.webyar.operator.ui.design.Size
import com.webyar.operator.ui.design.Space
import androidx.compose.foundation.shape.RoundedCornerShape
import com.webyar.operator.ui.design.Radius
import androidx.compose.foundation.background
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import com.webyar.operator.ui.components.FilledField
import com.webyar.operator.ui.design.WebyarType
import com.webyar.operator.ui.components.OperatorAvatar

/** Which sheet the header menu has opened, if any. */
enum class ChatSheet { STATUS, PRIORITY, TRANSFER, TAGS, NOTES }

/**
 * Everything the operator can do to a conversation without writing in it.
 *
 * A menu rather than a toolbar: these are occasional actions, and a row of
 * five icons across the top of a phone takes space from the thing the screen
 * is actually for.
 *
 * Take-over is at the top and only when it means something — on a thread the
 * AI still owns. Offering it on a thread a person is already answering would
 * be a button that does nothing.
 */
@Composable
fun ConversationMenu(
    language: Language,
    conversation: Conversation?,
    callChannels: CallChannels,
    onOpenSheet: (ChatSheet) -> Unit,
    onTakeOver: () -> Unit,
    onVoiceCall: () -> Unit,
    onVideoCall: () -> Unit,
) {
    var open by remember { mutableStateOf(false) }
    val aiManaged = conversation?.let { AiState.resolve(it) == AiState.AI_MANAGED } == true

    Box {
        IconButton(
            onClick = { open = true },
            modifier = Modifier.testTag(A11y.CHAT_MENU),
        ) {
            Icon(Icons.Filled.MoreVert, contentDescription = StrAndroid.moreOptions(language))
        }
        androidx.compose.material3.DropdownMenu(
            expanded = open,
            onDismissRequest = { open = false },
            shape = RoundedCornerShape(Radius.lg),
        ) {
            if (aiManaged) {
                MenuItem(Str.takeOver(language)) { open = false; onTakeOver() }
            }
            MenuItem(Str.changeStatus(language)) { open = false; onOpenSheet(ChatSheet.STATUS) }
            MenuItem(Str.changePriority(language)) { open = false; onOpenSheet(ChatSheet.PRIORITY) }
            MenuItem(Str.transferConversation(language)) { open = false; onOpenSheet(ChatSheet.TRANSFER) }
            MenuItem(Str.tags(language)) { open = false; onOpenSheet(ChatSheet.TAGS) }
            MenuItem(Str.internalNotes(language)) { open = false; onOpenSheet(ChatSheet.NOTES) }
            if (callChannels.voice) {
                MenuItem(Str.voiceCall(language)) { open = false; onVoiceCall() }
            }
            if (callChannels.video) {
                MenuItem(Str.videoCall(language)) { open = false; onVideoCall() }
            }
        }
    }
}

@Composable
private fun MenuItem(label: String, onClick: () -> Unit) {
    androidx.compose.material3.DropdownMenuItem(text = { Text(label) }, onClick = onClick)
}

// MARK: - The sheets

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun Sheet(title: String, onDismiss: () -> Unit, content: @Composable () -> Unit) {
    val state = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = state) {
        Text(
            title,
            style = MaterialTheme.typography.titleMedium,
            modifier = Modifier.padding(horizontal = Space.screenInset, vertical = Space.sm),
        )
        content()
    }
}

@Composable
fun StatusSheet(
    language: Language,
    current: ConversationStatus?,
    onPick: (ConversationStatus) -> Unit,
    onDismiss: () -> Unit,
) {
    Sheet(Str.changeStatus(language), onDismiss) {
        ConversationStatus.entries.forEach { status ->
            ChoiceRow(
                label = when (status) {
                    ConversationStatus.OPEN -> Str.filterOpen(language)
                    ConversationStatus.PENDING -> Str.statusPending(language)
                    ConversationStatus.RESOLVED -> Str.filterResolved(language)
                    ConversationStatus.CLOSED -> Str.statusClosed(language)
                },
                selected = status == current,
                onClick = { onPick(status); onDismiss() },
            )
        }
    }
}

@Composable
fun PrioritySheet(
    language: Language,
    current: ConversationPriority?,
    onPick: (ConversationPriority) -> Unit,
    onDismiss: () -> Unit,
) {
    Sheet(Str.changePriority(language), onDismiss) {
        ConversationPriority.entries.forEach { priority ->
            ChoiceRow(
                label = when (priority) {
                    ConversationPriority.LOW -> Str.priorityLow(language)
                    ConversationPriority.NORMAL -> Str.priorityNormal(language)
                    ConversationPriority.HIGH -> Str.priorityHigh(language)
                    ConversationPriority.URGENT -> Str.priorityUrgent(language)
                },
                selected = priority == current,
                onClick = { onPick(priority); onDismiss() },
            )
        }
    }
}

/**
 * Who the conversation goes to.
 *
 * A suspended member is SHOWN and refused rather than hidden: the operator
 * knows their colleague exists, and a list that quietly omits them reads as a
 * bug in the list rather than as a fact about the colleague.
 */
@Composable
fun TransferSheet(
    language: Language,
    members: List<WorkspaceMember>,
    currentAssignee: String?,
    onPick: (Assignee) -> Unit,
    onDismiss: () -> Unit,
) {
    Sheet(Str.transferConversation(language), onDismiss) {
        LazyColumn {
            item {
                ChoiceRow(
                    label = Str.unassigned(language),
                    selected = currentAssignee == null,
                    onClick = { onPick(Assignee.Nobody); onDismiss() },
                )
            }
            items(members, key = { it.id }) { member ->
                val usable = member.canReceiveWork
                Row(
                    Modifier
                        .fillMaxWidth()
                        .then(
                            if (usable) {
                                Modifier.clickable {
                                    onPick(Assignee.To(member.userId)); onDismiss()
                                }
                            } else {
                                Modifier
                            }
                        )
                        .heightIn(min = Size.rowMinHeight)
                        .padding(horizontal = Space.screenInset, vertical = Space.sm),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    OperatorAvatar(imageUrl = member.profile?.avatarUrl, size = Size.avatarSmall)
                    Text(
                        member.displayName,
                        style = MaterialTheme.typography.bodyLarge,
                        color = if (usable) {
                            MaterialTheme.colorScheme.onSurface
                        } else {
                            MaterialTheme.colorScheme.onSurfaceVariant
                        },
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f).padding(horizontal = Space.md),
                    )
                    if (member.userId == currentAssignee) {
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
    }
}

@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
fun TagsSheet(
    language: Language,
    tags: List<String>,
    onSave: (List<String>) -> Unit,
    onDismiss: () -> Unit,
) {
    var working by remember(tags) { mutableStateOf(tags) }
    var draft by remember { mutableStateOf("") }

    Sheet(Str.tags(language), onDismiss) {
        Column(Modifier.padding(horizontal = Space.screenInset)) {
            if (working.isEmpty()) {
                QuietRow(Str.noTags(language))
            } else {
                FlowRow(horizontalArrangement = Arrangement.spacedBy(Space.sm)) {
                    working.forEach { tag ->
                        Box(Modifier.clickable { working = working - tag }) {
                            StatusPill(tag, tone = PillTone.BRAND)
                        }
                    }
                }
            }

            Row(
                Modifier.fillMaxWidth().padding(vertical = Space.md),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                FilledField(
                    value = draft,
                    onValueChange = { draft = it },
                    label = Str.addTag(language),
                    modifier = Modifier.weight(1f),
                )
                TextButton(
                    onClick = {
                        val tag = draft.trim()
                        // De-duplicated here rather than server-side: the same
                        // tag twice is not an error the server reports, it is
                        // simply a list with a repeat in it.
                        if (tag.isNotEmpty() && tag !in working) working = working + tag
                        draft = ""
                    },
                    enabled = draft.isNotBlank(),
                ) { Text(Str.addTag(language)) }
            }

            PrimaryButton(
                Str.done(language),
                onClick = { onSave(working); onDismiss() },
                modifier = Modifier.padding(bottom = Space.lg),
            )
        }
    }
}

/**
 * The team's own notes on a conversation.
 *
 * The privacy line is not decoration. An internal note and a reply are written
 * in the same kind of box, and the one mistake that cannot be undone here is
 * sending a note to the visitor — so the sheet says whose eyes it is for,
 * every time, rather than relying on the operator remembering which sheet they
 * opened.
 */
@Composable
fun NotesSheet(
    language: Language,
    notes: List<ConversationNote>,
    onAdd: (String) -> Unit,
    onDelete: (ConversationNote) -> Unit,
    onDismiss: () -> Unit,
) {
    var draft by remember { mutableStateOf("") }

    Sheet(Str.internalNotes(language), onDismiss) {
        Text(
            Str.notesPrivacyNote(language),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(horizontal = Space.screenInset),
        )

        if (notes.isEmpty()) {
            QuietRow(Str.noNotes(language))
        } else {
            LazyColumn(Modifier.heightIn(max = 320.dp)) {
                items(notes, key = { it.id }) { note ->
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .padding(horizontal = Space.screenInset, vertical = Space.sm),
                        verticalAlignment = Alignment.Top,
                    ) {
                        Column(Modifier.weight(1f)) {
                            Text(note.body, style = MaterialTheme.typography.bodyMedium)
                            Text(
                                listOfNotNull(
                                    note.authorName.takeIf { it.isNotEmpty() },
                                    note.createdAt?.let { Format.listTimestamp(it, language) },
                                ).joinToString(" · "),
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                        IconButton(onClick = { onDelete(note) }) {
                            Icon(
                                Icons.Filled.Delete,
                                contentDescription = null,
                                tint = MaterialTheme.colorScheme.error,
                            )
                        }
                    }
                    RowDivider()
                }
            }
        }

        Column(Modifier.padding(horizontal = Space.screenInset, vertical = Space.md)) {
            FilledField(
                value = draft,
                onValueChange = { draft = it },
                label = Str.writeNote(language),
                singleLine = false,
                maxLines = 4,
                modifier = Modifier.fillMaxWidth(),
            )
            PrimaryButton(
                Str.send(language),
                onClick = { onAdd(draft); draft = "" },
                enabled = draft.isNotBlank(),
                modifier = Modifier.padding(top = Space.sm, bottom = Space.lg),
            )
        }
    }
}

@Composable
private fun ChoiceRow(label: String, selected: Boolean, onClick: () -> Unit) {
    // A rounded row that fills with a tone when it is the current choice —
    // the sheet's version of the settings pickers.
    Row(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = Space.sm, vertical = 1.dp)
            .clip(RoundedCornerShape(Radius.lg))
            .background(if (selected) MaterialTheme.colorScheme.secondaryContainer else Color.Transparent)
            .clickable(onClick = onClick)
            .heightIn(min = Size.minTouchTarget)
            .padding(horizontal = Space.lg, vertical = Space.sm),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            label,
            style = if (selected) WebyarType.bodyLargeEmphasized else MaterialTheme.typography.bodyLarge,
            modifier = Modifier.weight(1f),
        )
        if (selected) {
            Icon(
                Icons.Filled.Check,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.primary,
            )
        }
    }
}
