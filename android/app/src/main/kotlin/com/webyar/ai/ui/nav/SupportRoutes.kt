package com.webyar.ai.ui.nav

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
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
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.repeatOnLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.webyar.ai.LocalAppGraph
import com.webyar.ai.core.media.AttachmentRules
import com.webyar.ai.core.net.WebyarApi
import com.webyar.ai.core.push.Notifications
import com.webyar.ai.core.sync.SupportSignal
import com.webyar.ai.feature.chat.Composer
import com.webyar.ai.feature.chat.ComposerCapabilities
import com.webyar.ai.feature.support.SupportChatScreen
import com.webyar.ai.feature.support.SupportChatState
import com.webyar.ai.feature.support.SupportComposer
import com.webyar.ai.feature.support.SupportChatViewModel
import com.webyar.ai.feature.support.SupportTeamMark
import com.webyar.ai.feature.support.presenceText
import com.webyar.ai.i18n.Language
import com.webyar.ai.i18n.Str
import com.webyar.ai.i18n.StrAndroid
import com.webyar.ai.ui.AppState
import com.webyar.ai.ui.components.DetailTopBar
import com.webyar.ai.ui.design.Space
import com.webyar.ai.ui.liveLanguage
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.launch

/** The team's news on the operator's own channel, or by push. */
@Composable
internal fun rememberSupportSignals(): Flow<SupportSignal>? {
    val graph = LocalAppGraph.current
    return remember(graph) { graph?.syncGraph()?.coordinator?.support }
}

/** Text and a file — a photo or a document — and nothing else: no voice, no emoji. */
private val SUPPORT_COMPOSER = ComposerCapabilities(
    canAttach = true,
    canRecordVoice = false,
    canUseEmoji = false,
    isAiManaged = false,
)

/** The support chat: one screen for every conversation with the platform's team. */
@Composable
fun SupportChatRoute(
    appState: AppState,
    api: WebyarApi,
    language: Language,
    onBack: () -> Unit,
) {
    val chat: SupportChatViewModel = viewModel(
        key = "support-chat",
        factory = liveLanguage(language).let { l -> viewModelFactory { SupportChatViewModel(api, l) } },
    )
    val workspace by appState.selectedWorkspace.collectAsStateWithLifecycle()
    val state by chat.state.collectAsStateWithLifecycle()
    val status by chat.status.collectAsStateWithLifecycle()
    val draft by chat.draft.collectAsStateWithLifecycle()
    val notice by chat.notice.collectAsStateWithLifecycle()
    val ratingBusy by chat.rating.collectAsStateWithLifecycle()
    val myAvatar by appState.avatarUrl.collectAsStateWithLifecycle()

    LaunchedEffect(workspace?.id) { chat.open(workspace?.id) }

    // Read while resumed — "unread" is cleared here — with the team's news
    // as it comes, and a poll in case the channel is down.
    val lifecycleOwner = LocalLifecycleOwner.current
    val signals = rememberSupportSignals()
    LaunchedEffect(lifecycleOwner, signals) {
        lifecycleOwner.repeatOnLifecycle(Lifecycle.State.RESUMED) { chat.follow(signals) }
    }

    // On screen, the team's next reply needs no notification, and the ones
    // already in the tray have done their job.
    val context = LocalContext.current
    val graph = LocalAppGraph.current
    val coordinator = remember(graph) { graph?.syncGraph()?.coordinator }
    LaunchedEffect(lifecycleOwner, coordinator) {
        lifecycleOwner.repeatOnLifecycle(Lifecycle.State.RESUMED) {
            Notifications.cancelSupport(context)
            coordinator?.openSupportChat()
            try {
                awaitCancellation()
            } finally {
                coordinator?.closeSupportChat()
            }
        }
    }

    // The bytes are read here rather than in the view model: a Uri is a
    // permission grant to this Activity, and off the main thread, since a
    // document from a cloud provider takes a moment to come.
    val pickScope = rememberCoroutineScope()
    val sendPicked: (android.net.Uri) -> Unit = { uri ->
        pickScope.launch {
            when (val picked = readPickedFileOffMain(context, uri, maxBytes = SupportChatViewModel.MAX_FILE_BYTES)) {
                is PickedFile.Ready -> chat.sendFile(picked.bytes, picked.fileName, picked.mimeType)
                PickedFile.TooLarge -> chat.report(StrAndroid.supportFileTooLarge(language))
                else -> picked.problemText(language)?.let(chat::report)
            }
        }
    }
    val photoPicker = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri ->
        uri?.let(sendPicked)
    }
    val filePicker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        uri?.let(sendPicked)
    }

    Scaffold(
        topBar = {
            DetailTopBar(
                title = status?.teamName?.takeIf { it.isNotBlank() } ?: StrAndroid.supportTitle(language),
                subtitle = status?.let { presenceText(it.online, language) },
                backLabel = StrAndroid.back(language),
                onBack = onBack,
                leading = { SupportTeamMark(online = status?.online) },
            )
        },
    ) { padding ->
        Box(Modifier.padding(padding)) {
            SupportChatScreen(
                state = state,
                status = status,
                language = language,
                onRetryLoad = chat::refresh,
                onRetryMessage = chat::retry,
                onRate = chat::rate,
                onStartNew = chat::startNewConversation,
                ratingBusy = ratingBusy,
                loadAttachment = chat::attachment,
                myAvatarUrl = myAvatar,
            ) {
                Composer(
                    language = language,
                    draft = draft,
                    onDraftChange = chat::setDraft,
                    capabilities = SUPPORT_COMPOSER,
                    sending = false,
                    onSend = chat::send,
                    onAttachPhoto = {
                        // Images only: the support endpoint takes no video.
                        val opened = photoPicker.launchPicker(
                            PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)
                        )
                        if (!opened) chat.report(Str.attachmentFailed(language))
                    },
                    onAttachFile = {
                        if (!filePicker.launchPicker(AttachmentRules.PICKABLE_MIME_TYPES)) {
                            chat.report(Str.attachmentFailed(language))
                        }
                    },
                    onOpenShortcuts = {},
                    onStartRecording = {},
                    // Back after "start a new conversation": straight to typing.
                    focusOnOpen = (state as? SupportChatState.Loaded)?.composer == SupportComposer.New,
                )
            }
            notice?.let { text ->
                Snackbar(
                    modifier = Modifier.align(Alignment.BottomCenter).padding(Space.md),
                    action = { TextButton(onClick = chat::clearNotice) { Text(Str.cancel(language)) } },
                ) { Text(text) }
            }
        }
    }
}
