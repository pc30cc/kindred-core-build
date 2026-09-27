package com.webyar.operator.ui.nav

import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.adaptive.ExperimentalMaterial3AdaptiveApi
import androidx.compose.material3.adaptive.currentWindowAdaptiveInfo
import androidx.compose.material3.adaptive.layout.calculatePaneScaffoldDirective
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Modifier
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.repeatOnLifecycle
import com.webyar.operator.core.model.LiveVisitor
import com.webyar.operator.feature.analytics.AnalyticsReportScreen
import com.webyar.operator.feature.analytics.AnalyticsScreen
import com.webyar.operator.feature.analytics.AnalyticsSection
import com.webyar.operator.feature.analytics.AnalyticsViewModel
import com.webyar.operator.feature.visitors.VisitorDetailScreen
import com.webyar.operator.feature.visitors.VisitorText
import com.webyar.operator.feature.visitors.VisitorsScreen
import com.webyar.operator.feature.visitors.VisitorsViewModel
import com.webyar.operator.i18n.Language
import com.webyar.operator.i18n.StrAndroid
import com.webyar.operator.i18n.StrInsights
import com.webyar.operator.ui.AppState
import com.webyar.operator.ui.components.DetailTopBar
import com.webyar.operator.ui.components.rememberSearchState

/**
 * The Visitors and Website analytics tabs, as the navigation graph sees them
 * — beside [ScreenRoutes], which holds the rest, and written the same way:
 * the route takes what the graph knows and hands the screen what it needs.
 */

@Composable
fun VisitorsRoute(
    appState: AppState,
    visitors: VisitorsViewModel,
    language: Language,
    selectedId: String?,
    onOpenVisitor: (String) -> Unit,
) {
    val workspace by appState.selectedWorkspace.collectAsStateWithLifecycle()
    val state by visitors.state.collectAsStateWithLifecycle()
    val search = rememberSearchState(resetOn = workspace?.id ?: "-")
    LaunchedEffect(search) {
        snapshotFlow { search.text }.collect(visitors::setSearch)
    }
    LaunchedEffect(workspace?.id) {
        workspace?.let { visitors.bind(it.id) }
    }
    // Asked for every few seconds while the tab is on screen, and not at all
    // while it is not — no poll runs in the background.
    val lifecycle = LocalLifecycleOwner.current
    LaunchedEffect(workspace?.id, lifecycle) {
        if (workspace == null) return@LaunchedEffect
        lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) { visitors.followWhileVisible() }
    }
    VisitorsScreen(
        state = state,
        language = language,
        onOpen = { onOpenVisitor(it.id) },
        onOpenPin = onOpenVisitor,
        onRefresh = visitors::refresh,
        onOnlineOnly = visitors::setOnlineOnly,
        onChatOnly = visitors::setChatOnly,
        onCountry = visitors::setCountry,
        onIncludeOffline = visitors::setIncludeOffline,
        onClearFilters = {
            // The field as well as the filter: a query left in the field
            // would read as still applied to a list it no longer narrows.
            search.close()
            visitors.clearFilters()
        },
        modifier = Modifier.statusBarsPadding(),
        search = search,
        selectedId = selectedId,
    )
}

@Composable
fun LiveVisitorRoute(
    appState: AppState,
    sessionId: String,
    visitors: VisitorsViewModel,
    language: Language,
    onBack: () -> Unit,
    onOpenChat: (String) -> Unit,
) {
    val workspace by appState.selectedWorkspace.collectAsStateWithLifecycle()
    // A visitor belongs to the workspace they were opened in: on a switch the
    // page closes rather than showing — or starting a chat with — a visitor
    // of the workspace the operator just left.
    var openedIn by rememberSaveable(sessionId) { mutableStateOf<String?>(null) }
    LaunchedEffect(workspace?.id) {
        val ws = workspace?.id ?: return@LaunchedEffect
        val bound = openedIn
        if (bound != null && bound != ws) {
            onBack()
            return@LaunchedEffect
        }
        openedIn = ws
        // Bound here as well as by the list: on a phone the list is not
        // composed under this page, and after the process was away nothing
        // else would bind it.
        visitors.bind(ws)
        visitors.openHistory(sessionId)
    }
    // The row keeps itself current while it is read; on a phone the list,
    // which usually asks, is not on screen.
    val lifecycle = LocalLifecycleOwner.current
    LaunchedEffect(workspace?.id, lifecycle) {
        if (workspace == null) return@LaunchedEffect
        lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) { visitors.followWhileVisible() }
    }
    val state by visitors.state.collectAsStateWithLifecycle()
    val history by visitors.history.collectAsStateWithLifecycle()
    val busy by visitors.chatBusy.collectAsStateWithLifecycle()
    val notice by visitors.notice.collectAsStateWithLifecycle()
    // The row as the list has it now; the last one seen while they drop off
    // the list, so a visitor who just left does not blank the page.
    val live = state.visitors.firstOrNull { it.id == sessionId }
    var lastSeen by remember(sessionId) { mutableStateOf<LiveVisitor?>(null) }
    LaunchedEffect(live) { if (live != null) lastSeen = live }
    val visitor = live ?: lastSeen

    val snackbar = remember { SnackbarHostState() }
    LaunchedEffect(notice) {
        val text = notice ?: return@LaunchedEffect
        snackbar.showSnackbar(text)
        visitors.dismissNotice()
    }
    Scaffold(
        topBar = {
            DetailTopBar(
                title = visitor?.let { VisitorText.name(it, language) } ?: StrInsights.visitorDetails(language),
                backLabel = StrAndroid.back(language),
                onBack = onBack,
            )
        },
        snackbarHost = { SnackbarHost(snackbar) },
    ) { padding ->
        VisitorDetailScreen(
            visitor = visitor,
            now = state.now,
            history = history?.takeIf { it.sessionId == sessionId },
            chatBusy = busy,
            language = language,
            onChat = { visitor?.let { v -> visitors.chat(v, onOpenChat) } },
            modifier = Modifier.padding(padding),
            onRetryHistory = { visitors.openHistory(sessionId) },
        )
    }
}

@Composable
fun AnalyticsRoute(
    appState: AppState,
    analytics: AnalyticsViewModel,
    language: Language,
    selected: AnalyticsSection?,
    onOpenSection: (AnalyticsSection) -> Unit,
) {
    val workspace by appState.selectedWorkspace.collectAsStateWithLifecycle()
    val state by analytics.state.collectAsStateWithLifecycle()
    LaunchedEffect(workspace?.id) {
        workspace?.let { analytics.bind(it.id) }
    }
    val lifecycle = LocalLifecycleOwner.current
    LaunchedEffect(workspace?.id, lifecycle) {
        if (workspace == null) return@LaunchedEffect
        lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) { analytics.followLiveWhileVisible() }
    }
    AnalyticsScreen(
        state = state,
        language = language,
        selected = selected,
        onOpen = onOpenSection,
        onRange = analytics::setRange,
        onRefresh = analytics::refresh,
        modifier = Modifier.statusBarsPadding(),
    )
}

@OptIn(ExperimentalMaterial3AdaptiveApi::class)
@Composable
fun AnalyticsSectionRoute(
    appState: AppState,
    section: AnalyticsSection,
    analytics: AnalyticsViewModel,
    language: Language,
    onBack: () -> Unit,
) {
    val workspace by appState.selectedWorkspace.collectAsStateWithLifecycle()
    val state by analytics.state.collectAsStateWithLifecycle()
    // Bound here too: on a phone the list is not composed under the report,
    // and a report restored after the process was away has nothing else to
    // bind it. A workspace switch re-binds and asks again.
    LaunchedEffect(workspace?.id, section, state.range) {
        val ws = workspace?.id ?: return@LaunchedEffect
        analytics.bind(ws)
        analytics.load(section)
    }
    // Beside the list, the list's range picker is in view; on its own, the
    // page carries one so a phone need not go back to change it.
    val twoPanes = calculatePaneScaffoldDirective(currentWindowAdaptiveInfo()).maxHorizontalPartitions > 1
    Scaffold(
        topBar = {
            DetailTopBar(
                // The page's own header names the report; the bar says where it is.
                title = StrInsights.navAnalytics(language),
                backLabel = StrAndroid.back(language),
                onBack = onBack,
            )
        },
    ) { padding ->
        AnalyticsReportScreen(
            section = section,
            state = state,
            language = language,
            onRange = analytics::setRange,
            onSourceDimension = analytics::setSourceDimension,
            onPagesKind = analytics::setPagesKind,
            onGeoDimension = analytics::setGeoDimension,
            onRetry = analytics::refresh,
            modifier = Modifier.padding(padding),
            showRange = !twoPanes,
            contentPadding = PaddingValues(),
        )
    }
}
