package com.webyar.operator.feature.contacts

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
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
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import com.webyar.operator.core.model.Contact
import com.webyar.operator.core.model.VisitorProfile
import com.webyar.operator.i18n.Format
import com.webyar.operator.i18n.Language
import com.webyar.operator.i18n.Str
import com.webyar.operator.ui.A11y
import com.webyar.operator.ui.components.Avatar
import com.webyar.operator.ui.components.EmptyState
import com.webyar.operator.ui.components.ErrorState
import com.webyar.operator.ui.components.LatinText
import com.webyar.operator.ui.components.RowDivider
import com.webyar.operator.ui.components.SearchField
import com.webyar.operator.ui.components.SearchState
import com.webyar.operator.ui.components.SkeletonList
import com.webyar.operator.ui.components.bidiContent
import com.webyar.operator.ui.components.rowTextAlign
import com.webyar.operator.ui.design.Size
import com.webyar.operator.ui.design.Space

/**
 * The address book.
 *
 * Same chrome as the inbox on purpose — an inline title, a magnifier that
 * brings a field down into the list, pull to refresh — because it is the same
 * kind of screen and an operator switching tabs should not have to learn a
 * second set of gestures.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ContactsScreen(
    state: ContactsState,
    language: Language,
    onOpen: (Contact) -> Unit,
    modifier: Modifier = Modifier,
    contentPadding: PaddingValues = PaddingValues(),
    intel: Map<String, VisitorProfile> = emptyMap(),
    refreshing: Boolean = false,
    search: SearchState? = null,
    onRefresh: () -> Unit = {},
    onRetry: () -> Unit = {},
) {
    Column(modifier.fillMaxSize()) {
        TopAppBar(
            title = { Text(Str.tabContacts(language), maxLines = 1) },
            actions = {
                if (search != null) {
                    IconButton(
                        onClick = { search.toggle() },
                        modifier = Modifier.testTag(A11y.CONTACTS_SEARCH),
                    ) {
                        Icon(Icons.Filled.Search, contentDescription = Str.search(language))
                    }
                }
            },
        )

        if (search != null && search.isVisible) {
            SearchField(state = search, prompt = Str.search(language))
        }

        PullToRefreshBox(
            isRefreshing = refreshing,
            onRefresh = onRefresh,
            modifier = Modifier.weight(1f),
        ) {
            when (state) {
                // Grey rows rather than a spinner: the shape of the answer is
                // known before the answer is, so nothing jumps when it lands.
                is ContactsState.Loading -> SkeletonList(
                    Modifier.fillMaxSize().padding(contentPadding),
                )

                is ContactsState.Failed -> ErrorState(
                    title = Str.offlineTitle(language),
                    body = state.message,
                    retryLabel = Str.retry(language),
                    onRetry = onRetry,
                )

                is ContactsState.Loaded -> if (state.contacts.isEmpty()) {
                    val searching = search?.text?.isNotBlank() == true
                    EmptyState(
                        // A different icon and a different sentence for the
                        // two empties: "nobody has written in yet" and "your
                        // search found nobody" are not the same news.
                        icon = if (searching) Icons.Filled.Search else Icons.Filled.Person,
                        title = if (searching) {
                            Str.noResults(language)
                        } else {
                            Str.contactsEmptyTitle(language)
                        },
                        body = if (searching) null else Str.contactsEmptyBody(language),
                        modifier = Modifier.testTag(A11y.CONTACTS_EMPTY),
                    )
                } else {
                    LazyColumn(
                        Modifier.fillMaxSize().testTag(A11y.CONTACTS_LIST),
                        contentPadding = contentPadding,
                    ) {
                        items(state.contacts, key = { it.id }) { contact ->
                            ContactRow(
                                contact = contact,
                                language = language,
                                profile = intel[contact.id],
                            ) { onOpen(contact) }
                        }
                    }
                }
            }
        }
    }
}

/**
 * A contact in the list: avatar, name, and the best second identifier we have.
 *
 * The second line is left out entirely rather than drawn blank, so a row never
 * carries an empty line — which on a list of anonymous visitors would be most
 * of them.
 */
@Composable
private fun ContactRow(
    contact: Contact,
    language: Language,
    profile: VisitorProfile?,
    onClick: () -> Unit,
) {
    val name = Format.contactName(
        name = contact.name,
        email = contact.email,
        visitorCode = contact.visitorCode,
        language = language,
    )
    val secondary = contact.email?.takeIf { it.isNotBlank() }
        ?: contact.phone?.takeIf { it.isNotBlank() }

    Column(
        Modifier
            .clickable(onClick = onClick)
            .testTag(A11y.contactRow(contact.id))
    ) {
        Row(
            Modifier
                .fillMaxWidth()
                .heightIn(min = Size.rowMinHeight)
                .padding(horizontal = Space.screenInset, vertical = Space.sm),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            // Same size and same rule as an inbox row, deliberately: a visitor
            // is the same person on both screens and has to look it.
            Avatar(
                name = name,
                imageUrl = contact.avatarUrl,
                os = profile?.device?.os,
                device = profile?.device?.device,
                countryCode = profile?.geo?.countryCode,
            )
            Column(Modifier.weight(1f).padding(horizontal = Space.md)) {
                Text(
                    name,
                    style = MaterialTheme.typography.titleMedium.bidiContent(),
                    fontWeight = FontWeight.SemiBold,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.fillMaxWidth(),
                )
                if (secondary != null) {
                    // An address or a number is an LTR string in every
                    // language: read right-to-left, `operator@webyar.app`
                    // puts the domain first.
                    LatinText(
                        secondary,
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 1,
                        // Forced LTR would otherwise align it left and leave
                        // the address stranded under a right-aligned name.
                        align = rowTextAlign(),
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
            }
        }
        RowDivider()
    }
}
