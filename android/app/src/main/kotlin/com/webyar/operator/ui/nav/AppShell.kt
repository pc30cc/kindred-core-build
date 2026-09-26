package com.webyar.operator.ui.nav

import androidx.compose.animation.AnimatedContentTransitionScope
import androidx.compose.animation.ContentTransform
import androidx.compose.animation.ExperimentalSharedTransitionApi
import androidx.compose.animation.SharedTransitionLayout
import androidx.compose.animation.SharedTransitionScope
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.scaleIn
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Email
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.outlined.Email
import androidx.compose.material.icons.outlined.Person
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.adaptive.ExperimentalMaterial3AdaptiveApi
import androidx.compose.material3.adaptive.currentWindowAdaptiveInfo
import androidx.compose.material3.adaptive.navigation3.ListDetailSceneStrategy
import androidx.compose.material3.adaptive.navigation3.rememberListDetailSceneStrategy
import androidx.compose.material3.adaptive.navigationsuite.NavigationSuiteItem
import androidx.compose.material3.adaptive.navigationsuite.NavigationSuiteScaffold
import androidx.compose.material3.adaptive.navigationsuite.NavigationSuiteScaffoldDefaults
import androidx.compose.material3.adaptive.navigationsuite.NavigationSuiteType
import androidx.compose.material3.adaptive.navigationsuite.rememberNavigationSuiteScaffoldState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.navigation3.rememberViewModelStoreNavEntryDecorator
import androidx.navigation3.runtime.NavKey
import androidx.navigation3.runtime.entryProvider
import androidx.navigation3.runtime.rememberDecoratedNavEntries
import androidx.navigation3.runtime.rememberSaveableStateHolderNavEntryDecorator
import androidx.navigation3.scene.Scene
import androidx.navigation3.ui.NavDisplay
import com.webyar.operator.core.model.CallChannel
import com.webyar.operator.core.net.WebyarApi
import com.webyar.operator.feature.contacts.ContactsViewModel
import com.webyar.operator.feature.email.EmailInboxViewModel
import com.webyar.operator.feature.inbox.InboxViewModel
import com.webyar.operator.feature.promo.PromoFullScreen
import com.webyar.operator.feature.promo.PromotionCenter
import com.webyar.operator.feature.team.ColleaguesViewModel
import com.webyar.operator.i18n.Language
import com.webyar.operator.i18n.Str
import com.webyar.operator.i18n.StrAndroid
import com.webyar.operator.ui.AppState
import com.webyar.operator.ui.AppTab
import com.webyar.operator.ui.components.ShapeFrame
import com.webyar.operator.ui.design.ExpressiveShapes
import com.webyar.operator.ui.design.Motion
import com.webyar.operator.ui.design.Space

/**
 * The scope shared-element transitions run in, for a screen that wants one —
 * the avatar that carries over from an inbox row to the chat it opens. Null
 * outside the shell (tests, previews), where a screen simply does without.
 */
@OptIn(ExperimentalSharedTransitionApi::class)
val LocalSharedTransitionScope = staticCompositionLocalOf<SharedTransitionScope?> { null }

/**
 * The signed-in shell.
 *
 * - **Navigation 3.** One back stack per tab ([Navigator]); the stacks are
 *   plain lists the app owns and they survive process death.
 * - **Adaptive.** [NavigationSuiteScaffold] puts Material's short navigation
 *   bar on a phone and a navigation rail on a tablet, a foldable or a phone
 *   turned sideways. On a wide window the list-detail strategy lays a list and
 *   the thing opened from it side by side — the inbox and a chat, the contacts
 *   and a contact — from the same back stack a phone shows one at a time.
 * - **Motion.** Moving deeper slides along the reading direction (mirrored in
 *   Persian); switching tabs fades through, because tabs are siblings, not a
 *   sequence; Back is predictive — the gesture previews the screen underneath.
 *
 * Which tabs exist is the plan's decision, not this file's — [AppState.tabs]
 * answers that. The stacks are always all three even when the bar lists two:
 * a stack nobody can reach costs nothing.
 */
@OptIn(ExperimentalSharedTransitionApi::class, ExperimentalMaterial3AdaptiveApi::class)
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
) {
    val tabs by appState.tabs.collectAsStateWithLifecycle()
    val selectedTab by appState.selectedTab.collectAsStateWithLifecycle()
    val navigator = rememberNavigator(
        currentTab = { appState.selectedTab.value },
        selectTab = appState::selectTab,
    )

    // A plan change can take away the tab that is open — switching workspace
    // is the ordinary way that happens.
    LaunchedEffect(tabs) {
        if (selectedTab !in tabs) appState.selectTab(AppTab.INBOX)
    }

    // A notification tap: once the session and the workspaces are known, and
    // the workspace it names is checked to be this operator's, the Inbox tab
    // opens the conversation — by id, from the cache.
    val pendingLink by appState.pendingLink.collectAsStateWithLifecycle()
    val workspaces by appState.workspaces.collectAsStateWithLifecycle()
    LaunchedEffect(pendingLink, workspaces) {
        val link = appState.resolvePendingLink() ?: return@LaunchedEffect
        val id = link.conversationId ?: return@LaunchedEffect
        navigator.open(ChatKey(id))
    }

    val entryProvider = entryProvider<NavKey> {
        entry<InboxKey>(
            metadata = ListDetailSceneStrategy.listPane(
                sceneKey = InboxKey,
                detailPlaceholder = { DetailPlaceholder(StrAndroid.pickConversation(language)) },
            ) + tabOf(AppTab.INBOX),
        ) {
            InboxRoute(
                appState = appState,
                conversations = conversations,
                language = language,
                onOpenConversation = { navigator.open(ChatKey(it)) },
                onOpenColleagues = { navigator.open(ColleaguesKey) },
                onOpenEmail = { navigator.open(EmailKey) },
                promotions = promotions,
                bottomInset = 0.dp,
            )
        }
        entry<ChatKey>(metadata = ListDetailSceneStrategy.detailPane(sceneKey = InboxKey) + tabOf(AppTab.INBOX)) { key ->
            ChatRoute(
                conversationId = key.conversationId,
                appState = appState,
                api = api,
                conversations = conversations,
                language = language,
                onBack = { navigator.back() },
                onStartCall = { channel -> navigator.open(CallKey(key.conversationId, channel.wire)) },
            )
        }
        entry<CallKey>(metadata = tabOf(AppTab.INBOX)) { key ->
            CallRoute(
                conversationId = key.conversationId,
                channel = CallChannel.from(key.channel),
                appState = appState,
                api = api,
                conversations = conversations,
                language = language,
                onDone = { navigator.back() },
            )
        }
        entry<ColleaguesKey>(
            metadata = ListDetailSceneStrategy.listPane(
                sceneKey = ColleaguesKey,
                detailPlaceholder = { DetailPlaceholder(StrAndroid.pickItem(language)) },
            ) + tabOf(AppTab.INBOX),
        ) {
            ColleaguesRoute(
                appState = appState,
                colleagues = colleagues,
                language = language,
                onOpenThread = { navigator.open(TeamThreadKey(it)) },
                onBack = { navigator.back() },
            )
        }
        entry<TeamThreadKey>(metadata = ListDetailSceneStrategy.detailPane(sceneKey = ColleaguesKey) + tabOf(AppTab.INBOX)) { key ->
            TeamThreadRoute(
                peerId = key.peerId,
                appState = appState,
                api = api,
                colleagues = colleagues,
                language = language,
                onBack = { navigator.back() },
            )
        }
        entry<EmailKey>(
            metadata = ListDetailSceneStrategy.listPane(
                sceneKey = EmailKey,
                detailPlaceholder = { DetailPlaceholder(StrAndroid.pickItem(language)) },
            ) + tabOf(AppTab.INBOX),
        ) {
            EmailInboxRoute(
                appState = appState,
                email = email,
                language = language,
                onOpenThread = { navigator.open(EmailThreadKey(it)) },
                onBack = { navigator.back() },
            )
        }
        entry<EmailThreadKey>(metadata = ListDetailSceneStrategy.detailPane(sceneKey = EmailKey) + tabOf(AppTab.INBOX)) { key ->
            EmailThreadRoute(
                threadId = key.threadId,
                appState = appState,
                api = api,
                email = email,
                language = language,
                onBack = { navigator.back() },
            )
        }
        entry<ContactsKey>(
            metadata = ListDetailSceneStrategy.listPane(
                sceneKey = ContactsKey,
                detailPlaceholder = { DetailPlaceholder(StrAndroid.pickContact(language)) },
            ) + tabOf(AppTab.CONTACTS),
        ) {
            ContactsRoute(
                appState = appState,
                contacts = contacts,
                language = language,
                onOpenContact = { navigator.open(ContactKey(it)) },
                bottomInset = 0.dp,
            )
        }
        entry<ContactKey>(metadata = ListDetailSceneStrategy.detailPane(sceneKey = ContactsKey) + tabOf(AppTab.CONTACTS)) { key ->
            ContactDetailRoute(
                contactId = key.contactId,
                contacts = contacts,
                language = language,
                onBack = { navigator.back() },
            )
        }
        entry<SettingsKey>(
            metadata = ListDetailSceneStrategy.listPane(
                sceneKey = SettingsKey,
                detailPlaceholder = { DetailPlaceholder(StrAndroid.pickItem(language)) },
            ) + tabOf(AppTab.SETTINGS),
        ) {
            SettingsRoute(
                appState = appState,
                api = api,
                language = language,
                onOpenProfile = { navigator.open(ProfileKey) },
                onOpenSecurity = { navigator.open(SecurityKey) },
                onOpenNotifications = { navigator.open(NotificationsKey) },
                bottomInset = 0.dp,
            )
        }
        entry<ProfileKey>(metadata = ListDetailSceneStrategy.detailPane(sceneKey = SettingsKey) + tabOf(AppTab.SETTINGS)) {
            ProfileRoute(api = api, language = language, onBack = { navigator.back() })
        }
        entry<SecurityKey>(metadata = ListDetailSceneStrategy.detailPane(sceneKey = SettingsKey) + tabOf(AppTab.SETTINGS)) {
            SecurityRoute(api = api, language = language, onBack = { navigator.back() })
        }
        entry<NotificationsKey>(metadata = ListDetailSceneStrategy.detailPane(sceneKey = SettingsKey) + tabOf(AppTab.SETTINGS)) {
            NotificationsRoute(api = api, language = language, onBack = { navigator.back() })
        }
    }

    // Every tab's stack is decorated on every composition, not only the one
    // in front: that is what keeps a tab's scroll positions and view models
    // while another tab is open. Each stack has decorators of its own.
    val decorated = AppTab.entries.associateWith { tab ->
        key(tab) {
            rememberDecoratedNavEntries(
                backStack = navigator.stack(tab),
                entryDecorators = listOf(
                    rememberSaveableStateHolderNavEntryDecorator(),
                    rememberViewModelStoreNavEntryDecorator(),
                ),
                entryProvider = entryProvider,
            )
        }
    }
    // The inbox's root sits under every other tab, so Back from another tab's
    // root lands there — with the predictive preview showing it.
    val entries = if (selectedTab == AppTab.INBOX) {
        decorated.getValue(AppTab.INBOX)
    } else {
        decorated.getValue(AppTab.INBOX).take(1) + decorated.getValue(selectedTab)
    }

    val adaptiveInfo = currentWindowAdaptiveInfo()
    val suiteType = NavigationSuiteScaffoldDefaults.navigationSuiteType(adaptiveInfo)
    val isBar = suiteType == NavigationSuiteType.ShortNavigationBarCompact ||
        suiteType == NavigationSuiteType.ShortNavigationBarMedium
    // A bar leaves a pushed screen — a chat, a thread — to have the whole
    // height; a rail, beside the content, stays.
    val showSuite = !isBar || navigator.top?.isRoot() != false
    val suiteState = rememberNavigationSuiteScaffoldState()
    LaunchedEffect(showSuite) {
        if (showSuite) suiteState.show() else suiteState.hide()
    }

    val listDetail = rememberListDetailSceneStrategy<NavKey>()
    val rtl = LocalLayoutDirection.current == LayoutDirection.Rtl

    Box(modifier.fillMaxSize()) {
        NavigationSuiteScaffold(
            navigationItems = {
                tabs.forEach { tab ->
                    val item = tab.item(language)
                    NavigationSuiteItem(
                        selected = tab == selectedTab,
                        onClick = { navigator.select(tab) },
                        icon = {
                            Icon(
                                if (tab == selectedTab) item.selectedIcon else item.icon,
                                contentDescription = null,
                            )
                        },
                        label = { Text(item.title, maxLines = 1) },
                        navigationSuiteType = suiteType,
                    )
                }
            },
            navigationSuiteType = suiteType,
            state = suiteState,
        ) {
            SharedTransitionLayout {
                CompositionLocalProvider(LocalSharedTransitionScope provides this) {
                    NavDisplay(
                        entries = entries,
                        onBack = { navigator.back() },
                        sceneStrategies = listOf(listDetail),
                        sharedTransitionScope = this,
                        transitionSpec = { forward(rtl) },
                        popTransitionSpec = { backward(rtl) },
                    )
                }
            }
        }

        // Over everything, including the navigation. A full-screen promotion
        // with a bar on top of it is a card the operator can navigate out
        // from under without ever closing.
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

private const val TAB_METADATA = "webyar.tab"

private fun tabOf(tab: AppTab): Map<String, Any> = mapOf(TAB_METADATA to tab)

private fun Scene<NavKey>.tab(): Any? = entries.lastOrNull()?.metadata?.get(TAB_METADATA)

/**
 * Deeper into a tab: Material's shared axis along the reading direction —
 * the new screen comes in from the end, the old one gives way towards the
 * start, both a fifth of the width, on the Expressive springs. Between tabs:
 * fade through, which says "somewhere else" rather than "further in".
 */
private fun AnimatedContentTransitionScope<Scene<NavKey>>.forward(rtl: Boolean): ContentTransform =
    if (initialState.tab() != targetState.tab()) {
        fadeThrough()
    } else {
        (slideInHorizontally(Motion.slowSpatial()) { width -> if (rtl) -width / 5 else width / 5 } +
            fadeIn(Motion.effects())) togetherWith
            (slideOutHorizontally(Motion.slowSpatial()) { width -> if (rtl) width / 5 else -width / 5 } +
                fadeOut(Motion.fastEffects()))
    }

private fun AnimatedContentTransitionScope<Scene<NavKey>>.backward(rtl: Boolean): ContentTransform =
    if (initialState.tab() != targetState.tab()) {
        fadeThrough()
    } else {
        (slideInHorizontally(Motion.slowSpatial()) { width -> if (rtl) width / 5 else -width / 5 } +
            fadeIn(Motion.effects())) togetherWith
            (slideOutHorizontally(Motion.slowSpatial()) { width -> if (rtl) -width / 5 else width / 5 } +
                fadeOut(Motion.fastEffects()))
    }

private fun fadeThrough(): ContentTransform =
    (fadeIn(Motion.effects()) + scaleIn(Motion.spatial(), initialScale = 0.94f)) togetherWith
        fadeOut(Motion.fastEffects())

/**
 * What the detail pane shows on a wide window before anything is opened:
 * an expressive shape, and one line saying what goes here.
 */
@Composable
private fun DetailPlaceholder(text: String) {
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(Space.xl),
            modifier = Modifier.padding(Space.xxl).widthIn(max = 320.dp),
        ) {
            ShapeFrame(
                polygon = ExpressiveShapes.cookie9,
                color = MaterialTheme.colorScheme.secondaryContainer,
                modifier = Modifier.size(120.dp),
            ) {
                Icon(
                    Icons.Outlined.Email,
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.onSecondaryContainer,
                    modifier = Modifier.size(40.dp),
                )
            }
            Text(
                text,
                style = MaterialTheme.typography.titleMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                textAlign = TextAlign.Center,
            )
        }
    }
}

/** One destination in the bar or rail. */
private data class TabItem(val title: String, val icon: ImageVector, val selectedIcon: ImageVector)

@Composable
private fun AppTab.item(language: Language): TabItem = when (this) {
    AppTab.INBOX -> TabItem(Str.tabInbox(language), Icons.Outlined.Email, Icons.Filled.Email)
    AppTab.CONTACTS -> TabItem(Str.tabContacts(language), Icons.Outlined.Person, Icons.Filled.Person)
    AppTab.SETTINGS -> TabItem(Str.tabSettings(language), Icons.Outlined.Settings, Icons.Filled.Settings)
}
