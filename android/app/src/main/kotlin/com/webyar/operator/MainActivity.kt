package com.webyar.operator

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.tooling.preview.Preview
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.compose.runtime.collectAsState
import com.webyar.operator.core.model.Conversation
import com.webyar.operator.core.net.Backend
import com.webyar.operator.core.net.WebyarApi
import com.webyar.operator.core.storage.SecureStore
import com.webyar.operator.core.storage.SessionCache
import com.webyar.operator.feature.auth.LoginScreen
import com.webyar.operator.feature.chat.ChatScreen
import com.webyar.operator.feature.chat.ChatState
import com.webyar.operator.feature.inbox.InboxScreen
import com.webyar.operator.feature.inbox.InboxState
import com.webyar.operator.i18n.Language
import com.webyar.operator.ui.AppState
import com.webyar.operator.ui.ConversationViewModel
import com.webyar.operator.ui.Session
import com.webyar.operator.ui.design.WebyarTheme

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)

        val api = Backend.create(applicationContext)
        val cache = SessionCache(SecureStore(applicationContext))

        setContent {
            val appState: AppState = viewModel(factory = factory { AppState(api, cache) })
            val language by appState.language.collectAsState()

            // The theme takes the language and sets the layout direction from
            // it — rows, stacks, alignment, which edge padding's leading side
            // is on, and which way a transcript mirrors all follow. On iOS the
            // same thing needs a window-level override AND a UIKit appearance
            // proxy, because menus are drawn in a window SwiftUI's environment
            // never reaches; Compose has no such split.
            WebyarTheme(language = language) {
                Surface(Modifier.fillMaxSize()) {
                    RootScreen(appState, api, language)
                }
            }
        }
    }
}

/** Chooses the login screen or the app, and holds while it does not yet know. */
@Composable
private fun RootScreen(appState: AppState, api: WebyarApi, language: Language) {
    val session by appState.session.collectAsState()

    when (val current = session) {
        is Session.Restoring -> Box(Modifier.fillMaxSize(), Alignment.Center) {
            CircularProgressIndicator()
        }

        is Session.SignedOut -> LoginScreen(
            language = language,
            onSubmit = appState::logIn,
            modifier = Modifier.statusBarsPadding(),
        )

        is Session.SignedIn -> SignedInScreen(appState, api, language)
    }
}

@Composable
private fun SignedInScreen(appState: AppState, api: WebyarApi, language: Language) {
    val conversations: ConversationViewModel =
        viewModel(factory = factory { ConversationViewModel(api) { language } })
    val workspace by appState.selectedWorkspace.collectAsState()
    val inbox by conversations.inbox.collectAsState()
    val chat by conversations.chat.collectAsState()
    var open by remember { mutableStateOf<Conversation?>(null) }

    LaunchedEffect(workspace?.id) {
        workspace?.let { conversations.loadInbox(it.id) }
    }

    val current = open
    if (current == null) {
        InboxScreen(
            state = inbox,
            language = language,
            onOpen = {
                open = it
                conversations.openConversation(it)
            },
            modifier = Modifier.statusBarsPadding(),
        )
    } else {
        ChatScreen(
            state = chat,
            language = language,
            onSend = { body ->
                workspace?.let { conversations.send(current, body, it.id) }
            },
            modifier = Modifier.statusBarsPadding(),
        )
    }
}

/** A one-off factory, so a view model can take what it needs in its constructor. */
private inline fun <reified T : ViewModel> factory(crossinline create: () -> T) =
    object : ViewModelProvider.Factory {
        @Suppress("UNCHECKED_CAST")
        override fun <V : ViewModel> create(modelClass: Class<V>): V = create() as V
    }

@Preview(name = "login — fa", locale = "fa", showBackground = true)
@Composable
private fun LoginPersianPreview() {
    WebyarTheme(Language.FA) {
        Surface { LoginScreen(Language.FA, { _, _ -> Result.success(Unit) }) }
    }
}

@Preview(name = "login — fa, dark", locale = "fa", showBackground = true)
@Composable
private fun LoginPersianDarkPreview() {
    WebyarTheme(Language.FA, dark = true) {
        Surface { LoginScreen(Language.FA, { _, _ -> Result.success(Unit) }) }
    }
}

@Preview(name = "login — en", locale = "en", showBackground = true)
@Composable
private fun LoginEnglishPreview() {
    WebyarTheme(Language.EN) {
        Surface { LoginScreen(Language.EN, { _, _ -> Result.success(Unit) }) }
    }
}

@Preview(name = "login — tr", locale = "tr", showBackground = true)
@Composable
private fun LoginTurkishPreview() {
    WebyarTheme(Language.TR) {
        Surface { LoginScreen(Language.TR, { _, _ -> Result.success(Unit) }) }
    }
}

@Preview(name = "inbox empty — fa", locale = "fa", showBackground = true)
@Composable
private fun InboxEmptyPersianPreview() {
    WebyarTheme(Language.FA) {
        Surface { InboxScreen(InboxState.Loaded(emptyList()), Language.FA, {}) }
    }
}

@Preview(name = "chat empty — fa", locale = "fa", showBackground = true)
@Composable
private fun ChatPersianPreview() {
    WebyarTheme(Language.FA) {
        Surface { ChatScreen(ChatState.Loaded(emptyList()), Language.FA, {}) }
    }
}
