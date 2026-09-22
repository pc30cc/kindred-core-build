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
import com.webyar.operator.ui.ConversationViewModel
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
    conversations: ConversationViewModel,
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
                        // The list leaves room for the bar; a pushed screen
                        // does not, because the bar is gone by then.
                        bottomInset = Size.floatingBarHeight + Size.floatingBarBottomGap,
                    )
                }
                composable(Route.CHAT) { entry ->
                    ChatRoute(
                        conversationId = entry.arguments?.getString("conversationId").orEmpty(),
                        appState = appState,
                        conversations = conversations,
                        language = language,
                        onBack = { navController.popBackStack() },
                    )
                }
            }

            navigation(startDestination = Route.CONTACTS, route = Route.CONTACTS_GRAPH) {
                composable(Route.CONTACTS) {
                    ContactsRoute(
                        appState = appState,
                        language = language,
                        bottomInset = Size.floatingBarHeight + Size.floatingBarBottomGap,
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
