package com.webyar.operator.ui.nav

import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.Settings
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.Dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.webyar.operator.feature.chat.ChatScreen
import com.webyar.operator.feature.inbox.InboxScreen
import com.webyar.operator.feature.inbox.InboxState
import com.webyar.operator.i18n.Language
import com.webyar.operator.i18n.Str
import com.webyar.operator.ui.AppState
import com.webyar.operator.ui.ConversationViewModel
import com.webyar.operator.ui.components.EmptyState

/**
 * The screens, as the navigation graph sees them.
 *
 * A "route" here is the thin piece that takes what the graph knows — an id
 * from the URL, the callbacks that move to the next place — and hands the
 * screen what it actually needs. The screens themselves stay unaware that
 * navigation exists, which is what keeps them previewable and testable
 * without a NavController.
 */

@Composable
fun InboxRoute(
    appState: AppState,
    conversations: ConversationViewModel,
    language: Language,
    onOpenConversation: (String) -> Unit,
    bottomInset: Dp,
) {
    val workspace by appState.selectedWorkspace.collectAsStateWithLifecycle()
    val inbox by conversations.inbox.collectAsStateWithLifecycle()

    LaunchedEffect(workspace?.id) {
        workspace?.let { conversations.loadInbox(it.id) }
    }

    InboxScreen(
        state = inbox,
        language = language,
        onOpen = { conversation ->
            conversations.openConversation(conversation)
            onOpenConversation(conversation.id)
        },
        modifier = Modifier.statusBarsPadding(),
        contentPadding = PaddingValues(bottom = bottomInset),
    )
}

@Composable
fun ChatRoute(
    conversationId: String,
    appState: AppState,
    conversations: ConversationViewModel,
    language: Language,
    onBack: () -> Unit,
) {
    val workspace by appState.selectedWorkspace.collectAsStateWithLifecycle()
    val chat by conversations.chat.collectAsStateWithLifecycle()
    val inbox by conversations.inbox.collectAsStateWithLifecycle()

    // The route carries an id, not an object — which is right, because a route
    // has to survive process death and an object does not. The conversation is
    // looked up from the list that is already loaded; if the process WAS
    // restarted, the list reloads first and this resolves on the next frame.
    val conversation = (inbox as? InboxState.Loaded)
        ?.conversations
        ?.firstOrNull { it.id == conversationId }

    LaunchedEffect(conversationId, conversation?.id) {
        conversation?.let { conversations.openConversation(it) }
    }

    ChatScreen(
        state = chat,
        language = language,
        onSend = { body ->
            val current = conversation ?: return@ChatScreen
            workspace?.let { conversations.send(current, body, it.id) }
        },
        modifier = Modifier.statusBarsPadding(),
        onBack = onBack,
    )
}

/**
 * Contacts, until the contacts screen exists.
 *
 * An honest placeholder rather than a blank: the tab is plan-gated, so an
 * operator who can see it has paid for it, and a blank screen would read as
 * the feature being broken rather than as this build not having it yet.
 */
@Composable
fun ContactsRoute(
    appState: AppState,
    language: Language,
    bottomInset: Dp,
) {
    EmptyState(
        icon = Icons.Filled.Person,
        title = Str.tabContacts(language),
        body = null,
        modifier = Modifier.statusBarsPadding(),
    )
}

/** Settings, until the settings screen exists. */
@Composable
fun SettingsRoute(
    appState: AppState,
    language: Language,
    bottomInset: Dp,
) {
    EmptyState(
        icon = Icons.Filled.Settings,
        title = Str.tabSettings(language),
        body = null,
        modifier = Modifier.statusBarsPadding(),
    )
}
