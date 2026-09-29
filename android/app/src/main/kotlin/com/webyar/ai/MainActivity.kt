package com.webyar.ai

import android.Manifest
import android.content.pm.PackageManager
import androidx.core.content.ContextCompat
import android.os.Build
import android.os.Bundle
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import kotlinx.coroutines.launch
import android.content.Intent
import android.view.WindowManager
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.key
import androidx.compose.runtime.remember
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.lifecycle.ViewModelStore
import androidx.lifecycle.ViewModelStoreOwner
import androidx.lifecycle.viewmodel.compose.LocalViewModelStoreOwner
import com.webyar.ai.core.push.CallNotifications
import com.webyar.ai.core.push.IncomingCallLink
import com.webyar.ai.core.push.Notifications
import com.webyar.ai.core.push.PushPayload
import com.webyar.ai.core.push.from
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.Box
import androidx.compose.ui.draw.blur
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import com.webyar.ai.feature.auth.MaintenanceOverlay
import kotlinx.coroutines.delay
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.tooling.preview.Preview
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.compose.runtime.collectAsState
import com.webyar.ai.core.net.ApiError
import com.webyar.ai.core.net.WebyarApi
import com.webyar.ai.core.storage.Appearance
import com.webyar.ai.feature.auth.LoginScreen
import com.webyar.ai.feature.auth.RestoringScreen
import com.webyar.ai.feature.inbox.InboxScreen
import com.webyar.ai.feature.chat.ChatScreen
import com.webyar.ai.feature.chat.ChatState
import com.webyar.ai.feature.inbox.InboxState
import com.webyar.ai.i18n.Language
import com.webyar.ai.ui.AppState
import com.webyar.ai.feature.contacts.ContactsViewModel
import com.webyar.ai.feature.inbox.InboxViewModel
import androidx.compose.ui.platform.LocalContext
import com.webyar.ai.feature.email.EmailInboxViewModel
import com.webyar.ai.feature.promo.PromoCounters
import com.webyar.ai.feature.promo.PromotionCenter
import com.webyar.ai.feature.team.ColleaguesViewModel
import com.webyar.ai.ui.LocalLanguageSource
import com.webyar.ai.ui.Session
import com.webyar.ai.ui.nav.AppShell
import com.webyar.ai.ui.design.WebyarTheme

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
            // Read from the configuration, so it changes the moment the phone
            // does — switched by hand, or by its own schedule at sunset.
            val systemDark = isSystemInDarkTheme()
            val dark = when (appearance) {
                Appearance.SYSTEM -> systemDark
                Appearance.LIGHT -> false
                Appearance.DARK -> true
            }
            // The system bars follow the app's own light or dark, and follow it
            // again every time it changes. Set once at launch, as they were,
            // they kept the shade the phone had then: dark icons on a dark bar
            // after the phone went dark, or under an app set to Dark on a
            // light phone.
            DisposableEffect(dark) {
                enableEdgeToEdge(
                    statusBarStyle = SystemBarStyle.auto(
                        android.graphics.Color.TRANSPARENT,
                        android.graphics.Color.TRANSPARENT,
                    ) { dark },
                    navigationBarStyle = SystemBarStyle.auto(LIGHT_SCRIM, DARK_SCRIM) { dark },
                )
                onDispose {}
            }
            // The app's choice made the system's too (Android 12 and later), so
            // what the system draws for the app — the splash at the next
            // launch above all — is in the same light or dark as the app.
            val appearanceLoaded by appState.appearanceLoaded.collectAsState()
            LaunchedEffect(appearance, appearanceLoaded) {
                if (appearanceLoaded) applyNightMode(appearance)
            }

            WebyarTheme(
                language = language,
                dark = dark,
                dynamicColor = dynamicColor,
            ) {
                val languageSource = remember(appState) { { appState.language.value } }
                CompositionLocalProvider(LocalAppGraph provides graph, LocalLanguageSource provides languageSource) {
                    Surface(Modifier.fillMaxSize()) {
                        RootScreen(appState, api, language)
                    }
                }
            }
        }
    }

    /**
     * Tells the system which of light and dark this app is in, so that what
     * it draws on the app's behalf matches: the launch splash, above all.
     * "System" hands the choice back to the phone.
     */
    private fun applyNightMode(appearance: Appearance) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return
        val manager = getSystemService(android.app.UiModeManager::class.java) ?: return
        val mode = when (appearance) {
            Appearance.SYSTEM -> android.app.UiModeManager.MODE_NIGHT_AUTO
            Appearance.LIGHT -> android.app.UiModeManager.MODE_NIGHT_NO
            Appearance.DARK -> android.app.UiModeManager.MODE_NIGHT_YES
        }
        runCatching { manager.setApplicationNightMode(mode) }
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
        // A ringing call — Answer, or the ring itself, possibly full screen
        // over the lock screen.
        runCatching { IncomingCallLink.from(intent) }.getOrNull()?.let { call ->
            showOverLockScreen(true)
            if (call.answer) {
                // Answered: the ring has done its job on this phone.
                CallNotifications.stop(this, call.callId, missed = false, language = appState.language.value)
                CallNotifications.forget(call.callId)
            }
            appState.openIncomingCall(call)
            return
        }
        // This activity is exported; extras another app put there are not
        // worth a crash at launch.
        val link = runCatching { PushPayload.from(intent) }.getOrNull() ?: return
        appState.openFromNotification(link)
        Notifications.cancelFor(this, link)
    }

    /**
     * Over the lock screen, and waking it, while a call is on: a phone rings
     * and is answered without being unlocked first. Switched off again when
     * the call screen goes, so the rest of the app is never shown to whoever
     * holds a locked phone.
     */
    fun showOverLockScreen(on: Boolean) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(on)
            setTurnScreenOn(on)
        } else {
            @Suppress("DEPRECATION")
            if (on) {
                window.addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON)
            } else {
                window.clearFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON)
            }
        }
    }
}

/**
 * Asks for a reset link, as the iOS app does: a request that never reached
 * the server is reported (it says nothing about the address), and anything
 * else reads as sent. The endpoint answers the same for an address with an
 * account and one without, and saying otherwise here would turn this screen
 * into a way to test which addresses are registered.
 */
private suspend fun requestReset(api: WebyarApi, email: String, language: Language): Result<Unit> =
    try {
        api.requestPasswordReset(email.trim().lowercase(), language.code)
        Result.success(Unit)
    } catch (e: kotlinx.coroutines.CancellationException) {
        throw e
    } catch (e: ApiError.Transport) {
        Result.failure(e)
    } catch (_: Throwable) {
        Result.success(Unit)
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

    // Super Admin's maintenance notice, asked for every minute the app is
    // on screen and at once when it comes back to it — the sign-in screen
    // included, since nobody signs in while it is on.
    val maintenance by appState.maintenance.collectAsState()
    val checkingPlatform by appState.checkingPlatform.collectAsState()
    val lifecycleOwner = LocalLifecycleOwner.current
    LaunchedEffect(appState, lifecycleOwner) {
        lifecycleOwner.repeatOnLifecycle(Lifecycle.State.RESUMED) {
            while (true) {
                appState.checkPlatform()
                delay(PLATFORM_CHECK_MS)
            }
        }
    }

    Box(Modifier.fillMaxSize()) {
        Box(
            Modifier
                .fillMaxSize()
                // Under the notice the app stays in view, blurred (Android 12
                // and later), and out of TalkBack's reach as it is of a tap.
                .then(if (maintenance != null) Modifier.blur(12.dp).clearAndSetSemantics {} else Modifier),
        ) {
            when (val current = session) {
                // The iOS app's launch: the loader turning, the signature below.
                is Session.Restoring -> RestoringScreen(language)

                // No `statusBarsPadding` here: the screen takes `safeDrawing`,
                // which is the status bar AND the cutout AND the keyboard.
                // Passing the first as well would pad the top twice.
                is Session.SignedOut -> LoginScreen(
                    language = language,
                    onSubmit = appState::logIn,
                    // "Forgot password?" was never offered: nothing passed this,
                    // so the screen that asks for a link could not be reached.
                    onRequestReset = { email -> requestReset(api, email, language) },
                )

                is Session.SignedIn -> {
                    val owner = remember(current.user.id) {
                        object : ViewModelStoreOwner {
                            override val viewModelStore: ViewModelStore = stores.storeFor(current.user.id)
                        }
                    }
                    // Keyed by the operator: the stacks and scroll positions
                    // are saved state, and a process restored to the login
                    // screen must not hand the last operator's open chats to
                    // the next one.
                    key(current.user.id) {
                        CompositionLocalProvider(LocalViewModelStoreOwner provides owner) {
                            SignedInScreen(appState, api, language)
                        }
                    }
                }
            }
        }
        maintenance?.let { notice ->
            MaintenanceOverlay(
                notice = notice,
                language = language,
                checking = checkingPlatform,
                onRetry = { appState.checkPlatform() },
            )
        }
    }
}

/** How often a screen that is open asks whether the platform is down. */
private const val PLATFORM_CHECK_MS = 60_000L

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
    // The language read when it is needed, not captured: these models
    // outlive a language change, and a captured one kept every later error
    // in the language the session started in.
    val currentLanguage = { appState.language.value }
    val conversations: InboxViewModel =
        viewModel(factory = factory {
            if (sync != null) InboxViewModel(api, sync, currentLanguage) else InboxViewModel(api, language = currentLanguage)
        })
    // Held here rather than in the contacts route for the same reason: the
    // detail screen reads the row out of the list the list already fetched,
    // and a model scoped to the route would drop it on the way in.
    val contacts: ContactsViewModel =
        viewModel(factory = factory { ContactsViewModel(api, currentLanguage) })
    val colleagues: ColleaguesViewModel =
        viewModel(factory = factory { ColleaguesViewModel(api, currentLanguage) })
    val email: EmailInboxViewModel =
        viewModel(factory = factory { EmailInboxViewModel(api, currentLanguage) })
    val context = LocalContext.current
    val promotions: PromotionCenter =
        viewModel(factory = factory { PromotionCenter(api, PromoCounters(context)) })

    AskForNotificationsOnce(appState)

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
 * Android 13 and later deliver no notification until the app is allowed to,
 * and nothing asked outside Settings → Notifications — so a fresh install
 * signed in and never heard a customer write. Asked once per sign-in, when
 * the app is in front and not yet allowed; the system itself stops asking
 * after the operator has said no twice, and Settings keeps the way back.
 */
@Composable
private fun AskForNotificationsOnce(appState: AppState) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
    val context = LocalContext.current
    val graph = LocalAppGraph.current
    val userId = (appState.session.collectAsState().value as? Session.SignedIn)?.user?.id ?: return
    var asked by rememberSaveable(userId) { mutableStateOf(false) }
    val ask = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { allowed ->
        graph?.let { g -> g.appScope.launch { g.push.sync("permission ${if (allowed) "granted" else "denied"}") } }
    }
    LaunchedEffect(userId) {
        if (asked) return@LaunchedEffect
        asked = true
        val granted = ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) ==
            PackageManager.PERMISSION_GRANTED
        if (!granted) ask.launch(Manifest.permission.POST_NOTIFICATIONS)
    }
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

/**
 * The navigation bar's scrims under three-button navigation — the platform's
 * own defaults for `enableEdgeToEdge`, which it keeps private. Gesture
 * navigation draws no scrim at all.
 */
private val LIGHT_SCRIM = android.graphics.Color.argb(0xe6, 0xFF, 0xFF, 0xFF)
private val DARK_SCRIM = android.graphics.Color.argb(0x80, 0x1b, 0x1b, 0x1b)
