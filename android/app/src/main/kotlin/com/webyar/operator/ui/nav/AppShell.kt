package com.webyar.operator.ui.nav

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Email
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.outlined.Email
import androidx.compose.material.icons.outlined.Person
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavGraph.Companion.findStartDestination
import androidx.navigation.NavHostController
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navigation
import com.webyar.operator.i18n.Language
import com.webyar.operator.i18n.Str
import com.webyar.operator.ui.AppState
import com.webyar.operator.core.net.WebyarApi
import com.webyar.operator.ui.AppTab
import com.webyar.operator.feature.contacts.ContactsViewModel
import com.webyar.operator.feature.inbox.InboxViewModel
import com.webyar.operator.core.model.CallChannel
import com.webyar.operator.feature.email.EmailInboxViewModel
import com.webyar.operator.feature.promo.PromoFullScreen
import com.webyar.operator.feature.promo.PromotionCenter
import com.webyar.operator.feature.team.ColleaguesViewModel
import com.webyar.operator.ui.components.FloatingTabBar
import com.webyar.operator.ui.components.TabItem
import com.webyar.operator.ui.design.Size

/**
 * The signed-in shell: one NavHost, a nested graph per tab, and the bar.
 *
 * Which tabs exist is the plan's decision, not this file's — [AppState.tabs]
 * answers that, and holds a gated tab back until the plan has resolved either
 * way.
 *
 * The graphs are always all three, though, even when the bar lists two. That
 * is deliberate: a graph nobody can reach costs nothing, while adding and
 * removing graphs at runtime is how a navigation controller ends up rebuilding
 * its back stack under the operator. The bar decides what is reachable; the
 * host just holds the rooms.
 */
@Composable
fun AppShell(
    appState: AppState,
    api: WebyarApi,
    conversations: InboxViewModel,
    contacts: ContactsViewModel,
    colleagues: ColleaguesViewModel,
    email: EmailInboxViewModel,
    promotions: PromotionCenter,
    language: Language,
    modifier: Modifier = Modifier,
    navController: NavHostController = rememberNavController(),
) {
    val tabs by appState.tabs.collectAsStateWithLifecycle()
    val selectedTab by appState.selectedTab.collectAsStateWithLifecycle()
    val backStackEntry by navController.currentBackStackEntryAsState()
    val currentRoute = backStackEntry?.destination?.route

    // A plan change can take away the tab that is open — switching workspace
    // is the ordinary way that happens. Without this the shell would be left
    // showing a tab the bar no longer lists.
    LaunchedEffect(tabs) {
        if (selectedTab !in tabs) {
            appState.selectTab(AppTab.INBOX)
            navController.switchTo(AppTab.INBOX)
        }
    }

    Box(modifier.fillMaxSize()) {
        NavHost(
            navController = navController,
            startDestination = Route.INBOX_GRAPH,
            modifier = Modifier.fillMaxSize(),
        ) {
            navigation(startDestination = Route.INBOX, route = Route.INBOX_GRAPH) {
                composable(Route.INBOX) {
                    InboxRoute(
                        appState = appState,
                        conversations = conversations,
                        language = language,
                        onOpenConversation = { navController.navigate(Route.chat(it)) },
                        onOpenColleagues = { navController.navigate(Route.COLLEAGUES) },
                        onOpenEmail = { navController.navigate(Route.EMAIL) },
                        promotions = promotions,
                        // The list leaves room for the bar; a pushed screen
                        // does not, because the bar is gone by then.
                        bottomInset = Size.floatingBarHeight + Size.floatingBarBottomGap,
                    )
                }
                composable(Route.CHAT) { entry ->
                    ChatRoute(
                        conversationId = entry.arguments?.getString("conversationId").orEmpty(),
                        appState = appState,
                        api = api,
                        conversations = conversations,
                        language = language,
                        onBack = { navController.popBackStack() },
                        onStartCall = { channel ->
                            navController.navigate(Route.call(entry.arguments?.getString("conversationId").orEmpty(), channel.wire))
                        },
                    )
                }
                composable(Route.CALL) { entry ->
                    CallRoute(
                        conversationId = entry.arguments?.getString("conversationId").orEmpty(),
                        channel = CallChannel.from(entry.arguments?.getString("channel")),
                        appState = appState,
                        api = api,
                        language = language,
                        onDone = { navController.popBackStack() },
                    )
                }
                // The internal inbox lives inside the Inbox graph, not in a
                // tab of its own — which is where the console keeps it, and
                // what makes Back from a colleague's thread land on the
                // conversation list rather than somewhere else.
                composable(Route.COLLEAGUES) {
                    ColleaguesRoute(
                        appState = appState,
                        colleagues = colleagues,
                        language = language,
                        onOpenThread = { navController.navigate(Route.teamThread(it)) },
                        onBack = { navController.popBackStack() },
                    )
                }
                composable(Route.TEAM_THREAD) { entry ->
                    TeamThreadRoute(
                        peerId = entry.arguments?.getString("peerId").orEmpty(),
                        appState = appState,
                        api = api,
                        colleagues = colleagues,
                        language = language,
                        onBack = { navController.popBackStack() },
                    )
                }
                composable(Route.EMAIL) {
                    EmailInboxRoute(
                        appState = appState,
                        email = email,
                        language = language,
                        onOpenThread = { navController.navigate(Route.emailThread(it)) },
                        onBack = { navController.popBackStack() },
                    )
                }
                composable(Route.EMAIL_THREAD) { entry ->
                    EmailThreadRoute(
                        threadId = entry.arguments?.getString("threadId").orEmpty(),
                        appState = appState,
                        api = api,
                        email = email,
                        language = language,
                        onBack = { navController.popBackStack() },
                    )
                }
            }

            navigation(startDestination = Route.CONTACTS, route = Route.CONTACTS_GRAPH) {
                composable(Route.CONTACTS) {
                    ContactsRoute(
                        appState = appState,
                        contacts = contacts,
                        language = language,
                        onOpenContact = { navController.navigate(Route.contact(it)) },
                        bottomInset = Size.floatingBarHeight + Size.floatingBarBottomGap,
                    )
                }
                composable(Route.CONTACT) { entry ->
                    ContactDetailRoute(
                        contactId = entry.arguments?.getString("contactId").orEmpty(),
                        contacts = contacts,
                        language = language,
                        onBack = { navController.popBackStack() },
                    )
                }
            }

            navigation(startDestination = Route.SETTINGS, route = Route.SETTINGS_GRAPH) {
                composable(Route.SETTINGS) {
                    SettingsRoute(
                        appState = appState,
                        api = api,
                        language = language,
                        onOpenProfile = { navController.navigate(Route.PROFILE) },
                        onOpenSecurity = { navController.navigate(Route.SECURITY) },
                        bottomInset = Size.floatingBarHeight + Size.floatingBarBottomGap,
                    )
                }
                composable(Route.PROFILE) {
                    ProfileRoute(api = api, language = language, onBack = { navController.popBackStack() })
                }
                composable(Route.SECURITY) {
                    SecurityRoute(api = api, language = language, onBack = { navController.popBackStack() })
                }
            }
        }

        AnimatedVisibility(
            visible = Route.isRoot(currentRoute),
            enter = slideInVertically { it } + fadeIn(),
            exit = slideOutVertically { it } + fadeOut(),
            modifier = Modifier
                .align(Alignment.BottomCenter)
                // navigationBarsPadding, but NOT imePadding: the bar belongs
                // to the device, not to the text being typed. Letting the
                // keyboard push it would put the whole bar in the middle of
                // the screen the moment a composer opened — which is exactly
                // what SwiftUI does by default, and what the iOS shell has an
                // `ignoresSafeArea(.keyboard)` to undo.
                .navigationBarsPadding()
                .padding(bottom = Size.floatingBarBottomGap - 8.dp),
        ) {
            FloatingTabBar(
                items = tabs.map { it.item(language) },
                selected = selectedTab,
                onSelect = { tab ->
                    appState.selectTab(tab)
                    navController.switchTo(tab)
                },
            )
        }

        // Over everything, including the bar. A full-screen promotion with a
        // tab bar floating on top of it is a card the operator can navigate
        // out from under without ever closing — which is exactly the pattern
        // the stores object to.
        val fullscreen by promotions.fullscreen.collectAsStateWithLifecycle()
        fullscreen?.let {
            PromoFullScreen(
                creative = it,
                language = language,
                onDismiss = promotions::dismissFullScreen,
            )
        }
    }
}

/**
 * Switching tabs, with each tab's own stack kept.
 *
 * `saveState`/`restoreState` are what make a tab remember where it was, and
 * `popUpTo(start)` is what stops the back stack growing a new entry every time
 * somebody taps between two tabs — without it, Back after a minute of tapping
 * walks the whole history of taps.
 */
private fun NavHostController.switchTo(tab: AppTab) {
    navigate(Route.graphFor(tab)) {
        popUpTo(graph.findStartDestination().id) { saveState = true }
        launchSingleTop = true
        restoreState = true
    }
}

@Composable
private fun AppTab.item(language: Language): TabItem<AppTab> = when (this) {
    AppTab.INBOX -> TabItem(
        this, Str.tabInbox(language),
        Icons.Outlined.Email, Icons.Filled.Email,
    )
    AppTab.CONTACTS -> TabItem(
        this, Str.tabContacts(language),
        Icons.Outlined.Person, Icons.Filled.Person,
    )
    AppTab.SETTINGS -> TabItem(
        this, Str.tabSettings(language),
        Icons.Outlined.Settings, Icons.Filled.Settings,
    )
}
