package com.webyar.operator

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.tooling.preview.Preview
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.compose.runtime.collectAsState
import com.webyar.operator.core.net.Backend
import com.webyar.operator.core.net.WebyarApi
import com.webyar.operator.core.storage.Appearance
import com.webyar.operator.core.storage.Preferences
import com.webyar.operator.core.storage.SecureStore
import com.webyar.operator.core.storage.SessionCache
import com.webyar.operator.feature.auth.LoginScreen
import com.webyar.operator.feature.inbox.InboxScreen
import com.webyar.operator.feature.chat.ChatScreen
import com.webyar.operator.feature.chat.ChatState
import com.webyar.operator.feature.inbox.InboxState
import com.webyar.operator.i18n.Language
import com.webyar.operator.ui.AppState
import com.webyar.operator.feature.contacts.ContactsViewModel
import com.webyar.operator.feature.inbox.InboxViewModel
import com.webyar.operator.feature.email.EmailInboxViewModel
import com.webyar.operator.feature.team.ColleaguesViewModel
import com.webyar.operator.ui.Session
import com.webyar.operator.ui.nav.AppShell
import com.webyar.operator.ui.design.WebyarTheme

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)

        val api = Backend.create(applicationContext)
        val store = SecureStore(applicationContext)
        val cache = SessionCache(store)
        val prefs = Preferences(store)

        setContent {
            val appState: AppState = viewModel(factory = factory { AppState(api, cache, prefs) })
            val language by appState.language.collectAsState()
            val appearance by appState.appearance.collectAsState()

            // The theme takes the language and sets the layout direction from
            // it — rows, stacks, alignment, which edge padding's leading side
            // is on, and which way a transcript mirrors all follow. On iOS the
            // same thing needs a window-level override AND a UIKit appearance
            // proxy, because menus are drawn in a window SwiftUI's environment
            // never reaches; Compose has no such split.
            WebyarTheme(
                language = language,
                dark = when (appearance) {
                    Appearance.SYSTEM -> isSystemInDarkTheme()
                    Appearance.LIGHT -> false
                    Appearance.DARK -> true
                },
            ) {
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
    // Held here rather than inside a route: the inbox and the chat are two
    // views of the same thing, and a view model per route would make the chat
    // re-fetch a list the inbox already has.
    val conversations: InboxViewModel =
        viewModel(factory = factory { InboxViewModel(api) { language } })
    // Held here rather than in the contacts route for the same reason: the
    // detail screen reads the row out of the list the list already fetched,
    // and a model scoped to the route would drop it on the way in.
    val contacts: ContactsViewModel =
        viewModel(factory = factory { ContactsViewModel(api) { language } })
    val colleagues: ColleaguesViewModel =
        viewModel(factory = factory { ColleaguesViewModel(api) { language } })
    val email: EmailInboxViewModel =
        viewModel(factory = factory { EmailInboxViewModel(api) { language } })

    AppShell(
        appState = appState,
        api = api,
        conversations = conversations,
        contacts = contacts,
        colleagues = colleagues,
        email = email,
        language = language,
    )
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
