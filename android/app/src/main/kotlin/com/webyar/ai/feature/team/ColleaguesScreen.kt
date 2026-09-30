package com.webyar.ai.feature.team

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import com.webyar.ai.core.model.Colleague
import com.webyar.ai.i18n.Format
import com.webyar.ai.i18n.Language
import com.webyar.ai.i18n.Str
import com.webyar.ai.i18n.StrAndroid
import com.webyar.ai.ui.A11y
import com.webyar.ai.ui.components.Avatar
import com.webyar.ai.ui.components.EmptyState
import com.webyar.ai.ui.components.ErrorState
import com.webyar.ai.ui.components.SearchField
import com.webyar.ai.ui.components.SearchState
import com.webyar.ai.ui.components.SkeletonList
import com.webyar.ai.ui.components.UnreadBadge
import com.webyar.ai.ui.components.bidiContent
import com.webyar.ai.ui.design.Space
import com.webyar.ai.ui.design.WebyarTheme
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.pulltorefresh.rememberPullToRefreshState
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import com.webyar.ai.ui.components.PullIndicator
import com.webyar.ai.ui.design.Radius
import com.webyar.ai.ui.components.OperatorAvatar
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.runtime.remember
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.withStyle
import com.webyar.ai.ui.components.GroupHeader
import com.webyar.ai.ui.components.LatinText
import com.webyar.ai.ui.components.PillTone
import com.webyar.ai.ui.components.StatusPill
import com.webyar.ai.ui.components.rowTextAlign

/**
 * Everyone on the team, and what they last said.
 *
 * Two groups, the way a messenger keeps them: the colleagues there is a
 * conversation with, newest first, and under them the ones nobody has written
 * to yet, by name — so starting a chat is one tap, and the list of chats is
 * not diluted by people you have never spoken to. A big face on every row,
 * ringed in the brand's colour while something from them is unread.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ColleaguesScreen(
    state: ColleaguesState,
    language: Language,
    onOpen: (Colleague) -> Unit,
    modifier: Modifier = Modifier,
    contentPadding: PaddingValues = PaddingValues(),
    refreshing: Boolean = false,
    search: SearchState? = null,
    onRefresh: () -> Unit = {},
    onRetry: () -> Unit = {},
) {
    Column(modifier.fillMaxSize()) {
        AnimatedVisibility(
            visible = search != null && search.isVisible,
            enter = fadeIn() + expandVertically(),
            exit = fadeOut() + shrinkVertically(),
        ) {
            if (search != null) SearchField(state = search, prompt = Str.search(language))
        }

        val pullState = rememberPullToRefreshState()
        PullToRefreshBox(
            isRefreshing = refreshing,
            onRefresh = onRefresh,
            state = pullState,
            indicator = { PullIndicator(pullState, refreshing) },
            modifier = Modifier.weight(1f),
        ) {
            when (state) {
                is ColleaguesState.Loading -> SkeletonList(
                    Modifier.fillMaxSize().padding(contentPadding),
                    rows = 8,
                )

                is ColleaguesState.Failed -> ErrorState(
                    title = Str.offlineTitle(language),
                    body = state.message,
                    retryLabel = Str.retry(language),
                    onRetry = onRetry,
                )

                is ColleaguesState.Loaded -> if (state.colleagues.isEmpty()) {
                    val searching = search?.text?.isNotBlank() == true
                    EmptyState(
                        icon = if (searching) Icons.Filled.Search else Icons.Filled.Person,
                        title = if (searching) {
                            Str.noResults(language)
                        } else {
                            Str.colleaguesEmptyTitle(language)
                        },
                        body = if (searching) null else Str.colleaguesEmptyBody(language),
                        modifier = Modifier.testTag(A11y.COLLEAGUES_EMPTY),
                    )
                } else {
                    val (chats, others) = remember(state.colleagues) { groups(state.colleagues) }
                    // Headings only when there are two groups to tell apart.
                    val headed = chats.isNotEmpty() && others.isNotEmpty()
                    LazyColumn(
                        Modifier.fillMaxSize().testTag(A11y.COLLEAGUES_LIST),
                        contentPadding = PaddingValues(
                            top = Space.xs + contentPadding.calculateTopPadding(),
                            bottom = Space.xl + contentPadding.calculateBottomPadding(),
                        ),
                        verticalArrangement = Arrangement.spacedBy(2.dp),
                    ) {
                        if (headed) {
                            item(key = "h-chats") { GroupHeader(StrAndroid.colleaguesChats(language), Modifier.animateItem()) }
                        }
                        items(chats, key = { it.userId }) { colleague ->
                            ColleagueRow(colleague, language, Modifier.animateItem()) { onOpen(colleague) }
                        }
                        if (headed) {
                            item(key = "h-others") { GroupHeader(StrAndroid.colleaguesStartChat(language), Modifier.animateItem()) }
                        }
                        items(others, key = { it.userId }) { colleague ->
                            ColleagueRow(colleague, language, Modifier.animateItem()) { onOpen(colleague) }
                        }
                    }
                }
            }
        }
    }
}

/**
 * The chats, newest first, and the colleagues with none yet, by name.
 */
internal fun groups(colleagues: List<Colleague>): Pair<List<Colleague>, List<Colleague>> {
    val (chats, others) = colleagues.partition { it.lastMessage != null }
    return chats.sortedByDescending { it.lastMessage?.createdAt } to others.sortedBy { it.displayName.lowercase() }
}

/** A face big enough to know somebody by at a glance. */
private val FaceSize = 56.dp

@Composable
private fun ColleagueRow(
    colleague: Colleague,
    language: Language,
    modifier: Modifier = Modifier,
    onClick: () -> Unit,
) {
    val unread = colleague.unread ?: 0
    val last = colleague.lastMessage
    val role = StrAndroid.colleagueRole(language, colleague.role)

    // The inbox's rounded row: no dividers, and a tone under the rows that
    // have something unread, so they are found before they are read.
    Box(
        modifier
            .fillMaxWidth()
            .padding(horizontal = Space.sm)
            .clip(RoundedCornerShape(Radius.xl))
            .background(
                if (unread > 0) MaterialTheme.colorScheme.surfaceContainerLow else Color.Transparent,
            )
            .clickable(onClick = onClick)
            .testTag(A11y.colleagueRow(colleague.userId))
    ) {
        Row(
            Modifier
                .fillMaxWidth()
                .heightIn(min = 80.dp)
                .padding(horizontal = Space.md, vertical = Space.md),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Face(colleague.avatarUrl, ringed = unread > 0)
            Column(
                Modifier.weight(1f).padding(start = Space.md),
                verticalArrangement = Arrangement.spacedBy(3.dp),
            ) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    // The name takes all the room the time leaves, the role
                    // pill right after it rather than at the far end.
                    Row(Modifier.weight(1f), verticalAlignment = Alignment.CenterVertically) {
                        Text(
                            colleague.displayName,
                            style = MaterialTheme.typography.titleMedium.bidiContent(),
                            fontWeight = if (unread > 0) FontWeight.Bold else FontWeight.SemiBold,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.weight(1f, fill = false),
                        )
                        if (role != null) {
                            StatusPill(role, tone = PillTone.BRAND, modifier = Modifier.padding(start = Space.xs))
                        }
                    }
                    last?.createdAt?.let {
                        Text(
                            Format.listTimestamp(it, language),
                            style = MaterialTheme.typography.labelMedium,
                            color = if (unread > 0) MaterialTheme.colorScheme.primary else WebyarTheme.colors.labelTertiary,
                            fontWeight = if (unread > 0) FontWeight.SemiBold else null,
                            maxLines = 1,
                            modifier = Modifier.padding(start = Space.sm),
                        )
                    }
                }
                Row(verticalAlignment = Alignment.CenterVertically) {
                    if (last != null) {
                        Text(
                            buildAnnotatedString {
                                // What the operator sent themselves is said so,
                                // the way every messenger does.
                                if (last.outgoing == true) {
                                    withStyle(SpanStyle(color = WebyarTheme.colors.labelTertiary)) {
                                        append(StrAndroid.youPrefix(language))
                                    }
                                }
                                append(colleague.preview(language))
                            },
                            style = MaterialTheme.typography.bodyMedium.bidiContent(),
                            color = if (unread > 0) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onSurfaceVariant,
                            fontWeight = if (unread > 0) FontWeight.Medium else null,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.weight(1f),
                        )
                    } else if (!colleague.fullName.isNullOrBlank()) {
                        // Nobody has written yet: who they are, to know whom
                        // a first message goes to. (Without a name the
                        // address is already the name, and not said twice.)
                        LatinText(
                            colleague.email.orEmpty(),
                            style = MaterialTheme.typography.bodyMedium,
                            color = WebyarTheme.colors.labelTertiary,
                            maxLines = 1,
                            align = rowTextAlign(),
                            modifier = Modifier.weight(1f),
                        )
                    }
                    if (unread > 0) {
                        UnreadBadge(unread, language, Modifier.padding(start = Space.sm))
                    }
                }
            }
        }
    }
}

/**
 * A colleague's face, ringed in the brand's colour while something from them
 * is unread — the ring is seen before the badge is read.
 */
@Composable
private fun Face(imageUrl: String?, ringed: Boolean) {
    Box(
        Modifier
            .size(FaceSize)
            .then(
                if (ringed) {
                    Modifier.border(2.dp, MaterialTheme.colorScheme.primary, CircleShape).padding(3.dp)
                } else {
                    Modifier
                },
            ),
        contentAlignment = Alignment.Center,
    ) {
        OperatorAvatar(imageUrl = imageUrl, size = if (ringed) FaceSize - 6.dp else FaceSize)
    }
}

/**
 * The one line under a colleague's name.
 *
 * An attachment-only message has no body, so it is named by what it is — the
 * same rule the conversation rows follow, and the reason a colleague who sent
 * you a photo does not appear to have sent you nothing.
 */
internal fun Colleague.preview(language: Language): String {
    val last = lastMessage ?: return ""
    last.body?.takeIf { it.isNotBlank() }?.let { return Format.preview(it) }
    return when (last.attachmentKind) {
        "image" -> Str.photo(language)
        "audio" -> Str.voiceNote(language)
        "video" -> Str.videoFile(language)
        "file" -> Str.file(language)
        else -> ""
    }
}
