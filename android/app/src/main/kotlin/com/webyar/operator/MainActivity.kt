package com.webyar.operator

import android.os.Bundle
import android.content.Intent
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.lifecycle.ViewModelStore
import androidx.lifecycle.ViewModelStoreOwner
import androidx.lifecycle.viewmodel.compose.LocalViewModelStoreOwner
import com.webyar.operator.core.push.Notifications
import com.webyar.operator.core.push.PushPayload
import com.webyar.operator.core.push.from
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
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
import com.webyar.operator.core.net.WebyarApi
import com.webyar.operator.core.storage.Appearance
import com.webyar.operator.feature.auth.LoginScreen
import com.webyar.operator.feature.inbox.InboxScreen
import com.webyar.operator.feature.chat.ChatScreen
import com.webyar.operator.feature.chat.ChatState
import com.webyar.operator.feature.inbox.InboxState
import com.webyar.operator.i18n.Language
import com.webyar.operator.ui.AppState
import com.webyar.operator.feature.contacts.ContactsViewModel
import com.webyar.operator.feature.inbox.InboxViewModel
import androidx.compose.ui.platform.LocalContext
import com.webyar.operator.feature.email.EmailInboxViewModel
import com.webyar.operator.feature.promo.PromoCounters
import com.webyar.operator.feature.promo.PromotionCenter
import com.webyar.operator.feature.team.ColleaguesViewModel
import com.webyar.operator.ui.Session
import com.webyar.operator.ui.nav.AppShell
import com.webyar.operator.ui.design.WebyarTheme

class MainActivity : ComponentActivity() {

    private lateinit var appState: AppState

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)

        // Counted once per launch, here rather than in the promotion center:
        // the app counts launches and the center does not. The shell rebuilds
        // its center whenever the language changes, and a counter that reset
        // with it would let a promotion in on a first run.
        PromoCounters(applicationContext).noteLaunch()

        val graph = appGraph
        graph.start()
        val api = graph.api

        appState = ViewModelProvider(
            this,
            factory { AppState(api, graph.sessionCache, graph.preferences, graph.hooks) },
        )[AppState::class.java]
        // A notification tap that started the app. Not on a recreation: that
        // intent has already been followed.
        if (savedInstanceState == null) handleNotificationTap(intent)

        setContent {
            val language by appState.language.collectAsState()
            val appearance by appState.appearance.collectAsState()
            val dynamicColor by appState.dynamicColor.collectAsState()

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
                dynamicColor = dynamicColor,
            ) {
                CompositionLocalProvider(LocalAppGraph provides graph) {
                    Surface(Modifier.fillMaxSize()) {
                        RootScreen(appState, api, language)
                    }
                }
            }
        }
    }

    /**
     * A notification tapped while the app was already running. The activity
     * is `singleTop`, so this is the same instance and the same back stack —
     * the conversation opens on top of wherever the operator was.
     */
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleNotificationTap(intent)
    }

    private fun handleNotificationTap(intent: Intent?) {
        // Reopened from Recents after the process died: the system hands back
        // the intent that first launched it, and that tap was already followed.
        if (intent == null || intent.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY != 0) return
        // This activity is exported; extras another app put there are not
        // worth a crash at launch.
        val link = runCatching { PushPayload.from(intent) }.getOrNull() ?: return
        appState.openFromNotification(link)
        link.conversationId?.let { Notifications.cancelConversation(this, it) }
    }
}

/** Chooses the login screen or the app, and holds while it does not yet know. */
@Composable
private fun RootScreen(appState: AppState, api: WebyarApi, language: Language) {
    val session by appState.session.collectAsState()
    val stores: SessionStores = viewModel(factory = factory { SessionStores() })

    // Signed out: every view model the session made is cleared now, so the
    // next operator starts from nothing — not from the last one's inbox.
    LaunchedEffect(session) {
        if (session is Session.SignedOut) stores.release()
    }

    when (val current = session) {
        is Session.Restoring -> Box(Modifier.fillMaxSize(), Alignment.Center) {
            CircularProgressIndicator()
        }

        // No `statusBarsPadding` here: the screen takes `safeDrawing`, which
        // is the status bar AND the cutout AND the keyboard. Passing the
        // first as well would pad the top twice.
        is Session.SignedOut -> LoginScreen(
            language = language,
            onSubmit = appState::logIn,
        )

        is Session.SignedIn -> {
            val owner = remember(current.user.id) {
                object : ViewModelStoreOwner {
                    override val viewModelStore: ViewModelStore = stores.storeFor(current.user.id)
                }
            }
            CompositionLocalProvider(LocalViewModelStoreOwner provides owner) {
                SignedInScreen(appState, api, language)
            }
        }
    }
}

/**
 * The view models of one signed-in session, in a store of their own.
 *
 * The inbox, the chats, the contacts — held by the activity, they would
 * survive a sign-out and greet the next operator with the last one's rows.
 * Held here, they are cleared the moment the session ends.
 */
class SessionStores : ViewModel() {
    private var owner: String? = null
    private var store: ViewModelStore? = null

    fun storeFor(userId: String): ViewModelStore {
        if (owner != userId) release()
        return store ?: ViewModelStore().also {
            store = it
            owner = userId
        }
    }

    fun release() {
        store?.clear()
        store = null
        owner = null
    }

    override fun onCleared() = release()
}

@Composable
private fun SignedInScreen(appState: AppState, api: WebyarApi, language: Language) {
    val graph = LocalAppGraph.current
    val sync = remember(graph) { graph?.syncGraph() }
    // Held here rather than inside a route: the inbox and the chat are two
    // views of the same thing, and a view model per route would make the chat
    // re-fetch a list the inbox already has.
    val conversations: InboxViewModel =
        viewModel(factory = factory {
            if (sync != null) InboxViewModel(api, sync) { language } else InboxViewModel(api) { language }
        })
    // Held here rather than in the contacts route for the same reason: the
    // detail screen reads the row out of the list the list already fetched,
    // and a model scoped to the route would drop it on the way in.
    val contacts: ContactsViewModel =
        viewModel(factory = factory { ContactsViewModel(api) { language } })
    val colleagues: ColleaguesViewModel =
        viewModel(factory = factory { ColleaguesViewModel(api) { language } })
    val email: EmailInboxViewModel =
        viewModel(factory = factory { EmailInboxViewModel(api) { language } })
    val context = LocalContext.current
    val promotions: PromotionCenter =
        viewModel(factory = factory { PromotionCenter(api, PromoCounters(context)) })

    AppShell(
        appState = appState,
        api = api,
        conversations = conversations,
        contacts = contacts,
        colleagues = colleagues,
        email = email,
        promotions = promotions,
        language = language,
    )
}

/**
 * The app's graph, for the routes that build view models from it. Null in
 * previews and in tests that compose a screen on its own — the routes then
 * fall back to an in-memory sync layer.
 */
val LocalAppGraph = staticCompositionLocalOf<AppGraph?> { null }

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
