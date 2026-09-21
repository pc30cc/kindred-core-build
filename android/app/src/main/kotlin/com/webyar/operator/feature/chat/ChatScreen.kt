package com.webyar.operator.feature.chat

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import com.webyar.operator.core.model.Message
import com.webyar.operator.i18n.Language
import com.webyar.operator.i18n.Str
import com.webyar.operator.i18n.StrAndroid
import com.webyar.operator.ui.A11y

/**
 * One conversation, and the field to answer it in.
 *
 * Two things here are the Android answers to problems the iOS app records at
 * length, and both are one line rather than the sagas they were there.
 *
 * The transcript follows the keyboard. `imePadding()` is the whole of it;
 * `PinnedScrollView.swift` needs `keyboardWillChangeFrameNotification`, a
 * settle loop and a safe-area argument because SwiftUI reports the keyboard as
 * a bottom safe area and a `GeometryReader` never shrinks.
 *
 * And a bubble has a maximum width. On iOS that is a computed fraction of the
 * screen; here `widthIn(max = …)` against the row means a long message wraps
 * instead of pushing the timestamp off the edge, at any screen size, which
 * matters more on Android than anywhere — the same layout has to hold from a
 * 5-inch phone to a tablet.
 */
@Composable
fun ChatScreen(
    state: ChatState,
    language: Language,
    onSend: (String) -> Unit,
    modifier: Modifier = Modifier,
    /**
     * Null when the transcript is not something you came into from somewhere.
     *
     * The system Back gesture always works — the navigation graph sees to
     * that — so this is the visible affordance, not the mechanism. A screen
     * with no way back ON SCREEN is still reachable by gesture; a screen that
     * draws a back arrow which does nothing is not.
     */
    onBack: (() -> Unit)? = null,
) {
    Column(modifier.fillMaxSize().imePadding()) {
        if (onBack != null) ChatTopBar(language = language, onBack = onBack)
        Box(Modifier.weight(1f)) {
            when (state) {
                is ChatState.Loading -> Box(Modifier.fillMaxSize(), Alignment.Center) {
                    CircularProgressIndicator()
                }

                is ChatState.Failed -> Box(Modifier.fillMaxSize().padding(24.dp), Alignment.Center) {
                    Text(state.message, style = MaterialTheme.typography.bodyMedium)
                }

                is ChatState.Loaded -> if (state.messages.isEmpty()) {
                    Box(Modifier.fillMaxSize().padding(24.dp), Alignment.Center) {
                        Text(Str.chatEmpty(language), style = MaterialTheme.typography.bodyMedium)
                    }
                } else {
                    Transcript(state.messages)
                }
            }
        }
        Composer(language = language, onSend = onSend)
    }
}

@Composable
private fun Transcript(messages: List<Message>) {
    val listState = rememberLazyListState()

    // A transcript opens on its newest message, not its oldest. Re-run when
    // one arrives so a sent message is visible rather than just appended.
    LaunchedEffect(messages.size) {
        if (messages.isNotEmpty()) listState.animateScrollToItem(messages.lastIndex)
    }

    LazyColumn(
        state = listState,
        modifier = Modifier.fillMaxSize().testTag(A11y.CHAT_TRANSCRIPT),
        contentPadding = androidx.compose.foundation.layout.PaddingValues(16.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        items(messages, key = { it.id }) { message -> Bubble(message) }
    }
}

@Composable
private fun Bubble(message: Message) {
    val outgoing = message.senderType.isOutgoing
    val colors = MaterialTheme.colorScheme
    Row(
        modifier = Modifier.fillMaxWidth().testTag(A11y.messageRow(message.id)),
        // Compose resolves Start and End against the layout direction, so a
        // Persian transcript mirrors with no conditional here.
        horizontalArrangement = if (outgoing) Arrangement.End else Arrangement.Start,
    ) {
        Text(
            text = message.body,
            style = MaterialTheme.typography.bodyMedium,
            color = if (outgoing) colors.onPrimaryContainer else colors.onSurfaceVariant,
            modifier = Modifier
                .widthIn(max = 280.dp)
                .clip(RoundedCornerShape(16.dp))
                .background(if (outgoing) colors.primaryContainer else colors.surfaceVariant)
                .padding(horizontal = 12.dp, vertical = 8.dp),
        )
    }
}

@Composable
private fun Composer(language: Language, onSend: (String) -> Unit) {
    var draft by remember { mutableStateOf("") }

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .navigationBarsPadding()
            .padding(horizontal = 12.dp, vertical = 8.dp),
        verticalAlignment = Alignment.Bottom,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        OutlinedTextField(
            value = draft,
            onValueChange = { draft = it },
            placeholder = { Text(Str.messagePlaceholder(language)) },
            modifier = Modifier.weight(1f).testTag(A11y.COMPOSER_FIELD),
            maxLines = 5,
        )
        IconButton(
            onClick = {
                val text = draft.trim()
                if (text.isNotEmpty()) {
                    onSend(text)
                    draft = ""
                }
            },
            enabled = draft.isNotBlank(),
            modifier = Modifier.testTag(A11y.COMPOSER_SEND),
        ) {
            Icon(Icons.AutoMirrored.Filled.Send, contentDescription = Str.send(language))
        }
    }
}

sealed interface ChatState {
    data object Loading : ChatState
    data class Loaded(val messages: List<Message>) : ChatState
    data class Failed(val message: String) : ChatState
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ChatTopBar(language: Language, onBack: () -> Unit) {
    TopAppBar(
        title = {},
        navigationIcon = {
            IconButton(onClick = onBack) {
                Icon(
                    // AutoMirrored: a back arrow points the way you came, and
                    // in Persian that is the other way. This is the one family
                    // of icons that MUST mirror, as against the bubble beak
                    // and the flag badge, which must not.
                    imageVector = Icons.AutoMirrored.Filled.ArrowBack,
                    contentDescription = StrAndroid.back(language),
                )
            }
        },
        colors = TopAppBarDefaults.topAppBarColors(
            containerColor = androidx.compose.ui.graphics.Color.Transparent,
        ),
    )
}
