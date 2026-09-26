package com.webyar.operator.feature.chat

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.style.TextOverflow
import com.webyar.operator.core.model.CannedResponse
import com.webyar.operator.i18n.Language
import com.webyar.operator.i18n.Str
import com.webyar.operator.ui.A11y
import com.webyar.operator.ui.components.EmptyState
import com.webyar.operator.ui.components.PillTone
import com.webyar.operator.ui.components.SearchField
import com.webyar.operator.ui.components.StatusPill
import com.webyar.operator.ui.components.rememberSearchState
import com.webyar.operator.ui.design.Size
import com.webyar.operator.ui.design.Space
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Warning
import kotlinx.coroutines.delay
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.draw.clip
import androidx.compose.ui.unit.dp
import com.webyar.operator.ui.design.Radius
import com.webyar.operator.ui.design.WebyarType

/** What the picker knows about the workspace's saved replies. */
sealed interface ShortcutsState {
    data object Loading : ShortcutsState
    data class Loaded(val items: List<CannedResponse>) : ShortcutsState

    /**
     * The deployment has no saved-replies table.
     *
     * Told apart from an ordinary failure because a retry can never fix it —
     * the server answers 501, which means a database built from the self-host
     * migration chain before `198_canned_responses_selfhost.sql`. A "try
     * again" button there would be a lie.
     */
    data object Unavailable : ShortcutsState
    data class Failed(val message: String) : ShortcutsState
}

/**
 * The console's lightning bolt, on a phone.
 *
 * The thing worth getting right is not that a sheet opens. It is that what
 * lands in the draft has had its placeholders filled in — a reply stored as
 * "Hello {{contact.name}}" must reach the visitor as a greeting rather than as
 * a template, and one whose name cannot be resolved must keep its braces so
 * the operator sees it before they send. That rule lives in `CannedText`; this
 * is the surface that applies it.
 *
 * There is no editor here on purpose. Only the author and the workspace's
 * owners can change a saved reply, and a phone is where you reach for one, not
 * where you curate the list.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CannedResponsePicker(
    language: Language,
    state: ShortcutsState,
    onQueryChange: (String) -> Unit,
    onPick: (CannedResponse) -> Unit,
    onDismiss: () -> Unit,
) {
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    val search = rememberSearchState()

    // Debounced, and in an effect rather than in composition: the search is a
    // network call, and calling it from the body would fire one on every
    // recomposition — including the recompositions its own result causes.
    LaunchedEffect(search.text) {
        delay(SEARCH_DEBOUNCE_MS)
        onQueryChange(search.text)
    }

    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = sheetState) {
        Text(
            Str.shortcuts(language),
            style = MaterialTheme.typography.titleMedium,
            modifier = Modifier.padding(horizontal = Space.screenInset, vertical = Space.sm),
        )

        when (state) {
            ShortcutsState.Loading -> Row(
                Modifier.fillMaxWidth().padding(Space.xl),
                horizontalArrangement = androidx.compose.foundation.layout.Arrangement.Center,
            ) { CircularProgressIndicator() }

            ShortcutsState.Unavailable -> EmptyState(
                icon = Icons.Filled.Warning,
                title = Str.shortcutsUnavailableTitle(language),
                body = Str.shortcutsUnavailableBody(language),
            )

            is ShortcutsState.Failed -> EmptyState(
                icon = Icons.Filled.Warning,
                title = Str.offlineTitle(language),
                body = state.message,
            )

            is ShortcutsState.Loaded -> {
                SearchField(state = search, prompt = Str.filterByName(language))
                if (state.items.isEmpty()) {
                    // Not `inboxEmptyTitle` — this is the saved-replies
                    // sheet, and it used to tell an operator looking for a
                    // canned response that there were no conversations. The
                    // right strings were already written and translated.
                    EmptyState(
                        icon = Icons.Filled.Warning,
                        title = Str.shortcutsEmptyTitle(language),
                        body = Str.shortcutsEmptyBody(language),
                    )
                } else {
                    LazyColumn {
                        items(state.items, key = { it.id }) { reply ->
                            ShortcutRow(reply) { onPick(reply) }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun ShortcutRow(reply: CannedResponse, onClick: () -> Unit) {
    // A rounded row on the sheet, like the lists behind it — no dividers.
    Column(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = Space.sm, vertical = 1.dp)
            .clip(RoundedCornerShape(Radius.xl))
            .clickable(onClick = onClick)
            .testTag(A11y.shortcutRow(reply.id)),
    ) {
        Row(
            Modifier
                .fillMaxWidth()
                .heightIn(min = Size.rowMinHeight)
                .padding(horizontal = Space.lg, vertical = Space.md),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(Modifier.weight(1f).padding(end = Space.sm)) {
                Text(
                    reply.title,
                    style = WebyarType.titleMediumEmphasized,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Text(
                    // The RAW body, braces and all. What the operator picks
                    // from should look like what is stored, because the
                    // resolved version depends on the conversation and this
                    // list is not in one yet.
                    reply.body,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            StatusPill(reply.shortcut, tone = PillTone.NEUTRAL)
        }
    }
}

/**
 * Long enough that typing a five-letter shortcut is one request rather than
 * five, short enough that the list feels like it is keeping up.
 */
private const val SEARCH_DEBOUNCE_MS = 220L
