package com.webyar.ai.ui.nav

import android.widget.Toast
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Snackbar
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.repeatOnLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.webyar.ai.LocalAppGraph
import com.webyar.ai.core.net.WebyarApi
import com.webyar.ai.core.push.Notifications
import com.webyar.ai.core.sync.SupportSignal
import com.webyar.ai.feature.chat.Composer
import com.webyar.ai.feature.chat.ComposerCapabilities
import com.webyar.ai.feature.support.SupportHomeScreen
import com.webyar.ai.feature.support.SupportHomeViewModel
import com.webyar.ai.feature.support.SupportThreadScreen
import com.webyar.ai.feature.support.SupportThreadState
import com.webyar.ai.feature.support.SupportThreadViewModel
import com.webyar.ai.feature.support.SupportTicketScreen
import com.webyar.ai.feature.support.SupportTicketViewModel
import com.webyar.ai.feature.support.threadTitle
import com.webyar.ai.i18n.Format
import com.webyar.ai.i18n.Language
import com.webyar.ai.i18n.Str
import com.webyar.ai.i18n.StrAndroid
import com.webyar.ai.ui.AppState
import com.webyar.ai.ui.components.DetailTopBar
import com.webyar.ai.ui.design.Space
import com.webyar.ai.ui.liveLanguage
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.flow.Flow

/** The team's news on the operator's own channel, or by push. */
@Composable
internal fun rememberSupportSignals(): Flow<SupportSignal>? {
    val graph = LocalAppGraph.current
    return remember(graph) { graph?.syncGraph()?.coordinator?.support }
}

/** A support conversation offers text and emoji: files go through email. */
private val SUPPORT_COMPOSER = ComposerCapabilities(
    canAttach = false,
    canRecordVoice = false,
    canUseEmoji = true,
    isAiManaged = false,
)

@Composable
fun SupportHomeRoute(
    api: WebyarApi,
    language: Language,
    onBack: () -> Unit,
    onStartChat: () -> Unit,
    onNewTicket: () -> Unit,
    onOpenThread: (String) -> Unit,
) {
    val home: SupportHomeViewModel =
        viewModel(factory = liveLanguage(language).let { l -> viewModelFactory { SupportHomeViewModel(api, l) } })
    val status by home.status.collectAsStateWithLifecycle()
    val threads by home.threads.collectAsStateWithLifecycle()
    val loaded by home.loaded.collectAsStateWithLifecycle()

    val lifecycleOwner = LocalLifecycleOwner.current
    val signals = rememberSupportSignals()
    LaunchedEffect(lifecycleOwner, signals) {
        lifecycleOwner.repeatOnLifecycle(Lifecycle.State.RESUMED) { home.follow(signals) }
    }

    Scaffold(
        topBar = {
            DetailTopBar(
                title = StrAndroid.supportTitle(language),
                backLabel = StrAndroid.back(language),
                onBack = onBack,
            )
        },
    ) { padding ->
        SupportHomeScreen(
            status = status,
            threads = threads,
            loaded = loaded,
            language = language,
            onStartChat = onStartChat,
            onNewTicket = onNewTicket,
            onOpenThread = { onOpenThread(it.id) },
            modifier = Modifier.padding(padding),
        )
    }
}

/** One support thread; [threadId] null is a new chat, which its first message starts. */
@Composable
fun SupportThreadRoute(
    threadId: String?,
    appState: AppState,
    api: WebyarApi,
    language: Language,
    onBack: () -> Unit,
) {
    val thread: SupportThreadViewModel = viewModel(
        key = "support-thread-${threadId ?: "new"}",
        factory = liveLanguage(language).let { l -> viewModelFactory { SupportThreadViewModel(api, l) } },
    )
    val workspace by appState.selectedWorkspace.collectAsStateWithLifecycle()
    val state by thread.state.collectAsStateWithLifecycle()
    val draft by thread.draft.collectAsStateWithLifecycle()
    val notice by thread.notice.collectAsStateWithLifecycle()
    val current by thread.threadId.collectAsStateWithLifecycle()
    val myAvatar by appState.avatarUrl.collectAsStateWithLifecycle()

    LaunchedEffect(threadId, workspace?.id) { thread.open(threadId, workspace?.id) }

    val lifecycleOwner = LocalLifecycleOwner.current
    val signals = rememberSupportSignals()
    LaunchedEffect(lifecycleOwner, signals) {
        lifecycleOwner.repeatOnLifecycle(Lifecycle.State.RESUMED) { thread.follow(signals) }
    }

    // On screen, the team's next reply needs no notification, and the one
    // already in the tray has done its job.
    val context = LocalContext.current
    val graph = LocalAppGraph.current
    val coordinator = remember(graph) { graph?.syncGraph()?.coordinator }
    LaunchedEffect(lifecycleOwner, current, coordinator) {
        val id = current ?: return@LaunchedEffect
        lifecycleOwner.repeatOnLifecycle(Lifecycle.State.RESUMED) {
            Notifications.cancelSupportThread(context, id)
            coordinator?.openSupportThread(id)
            try {
                awaitCancellation()
            } finally {
                coordinator?.closeSupportThread(id)
            }
        }
    }

    val loaded = state as? SupportThreadState.Loaded
    Scaffold(
        topBar = {
            DetailTopBar(
                title = loaded?.thread?.let { threadTitle(it, language) } ?: StrAndroid.supportChat(language),
                subtitle = loaded?.thread?.let { StrAndroid.supportStatus(language, it.status) },
                backLabel = StrAndroid.back(language),
                onBack = onBack,
            )
        },
    ) { padding ->
        Box(Modifier.padding(padding)) {
            SupportThreadScreen(
                state = state,
                language = language,
                onRetryLoad = thread::load,
                onRetryMessage = thread::retry,
                myAvatarUrl = myAvatar,
            ) {
                Composer(
                    language = language,
                    draft = draft,
                    onDraftChange = thread::setDraft,
                    capabilities = SUPPORT_COMPOSER,
                    sending = false,
                    onSend = thread::send,
                    onAttachPhoto = {},
                    onAttachFile = {},
                    onOpenShortcuts = {},
                    onStartRecording = {},
                )
            }
            notice?.let { text ->
                Snackbar(
                    modifier = Modifier.align(Alignment.BottomCenter).padding(Space.md),
                    action = { TextButton(onClick = thread::clearNotice) { Text(Str.cancel(language)) } },
                ) { Text(text) }
            }
        }
    }
}

@Composable
fun SupportTicketRoute(
    appState: AppState,
    api: WebyarApi,
    language: Language,
    onBack: () -> Unit,
    /** The ticket is filed: show it in place of the form. */
    onCreated: (String) -> Unit,
) {
    val ticket: SupportTicketViewModel =
        viewModel(factory = liveLanguage(language).let { l -> viewModelFactory { SupportTicketViewModel(api, l) } })
    val workspace by appState.selectedWorkspace.collectAsStateWithLifecycle()
    val subject by ticket.subject.collectAsStateWithLifecycle()
    val body by ticket.body.collectAsStateWithLifecycle()
    val submitting by ticket.submitting.collectAsStateWithLifecycle()
    val error by ticket.error.collectAsStateWithLifecycle()
    val created by ticket.created.collectAsStateWithLifecycle()
    val context = LocalContext.current

    LaunchedEffect(created) {
        val thread = created ?: return@LaunchedEffect
        Toast.makeText(
            context,
            StrAndroid.supportTicketSent(language, Format.number(thread.number, language)),
            Toast.LENGTH_LONG,
        ).show()
        onCreated(thread.id)
    }

    Scaffold(
        topBar = {
            DetailTopBar(
                title = StrAndroid.supportNewTicket(language),
                backLabel = StrAndroid.back(language),
                onBack = onBack,
            )
        },
    ) { padding ->
        SupportTicketScreen(
            subject = subject,
            body = body,
            submitting = submitting,
            error = error,
            language = language,
            onSubjectChange = ticket::setSubject,
            onBodyChange = ticket::setBody,
            onSubmit = { ticket.submit(workspace?.id) },
            modifier = Modifier.padding(padding),
        )
    }
}
