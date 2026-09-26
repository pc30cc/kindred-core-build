package com.webyar.operator.ui.nav

import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.Settings
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.webyar.operator.feature.chat.ChatScreen
import com.webyar.operator.feature.contacts.ContactDetailScreen
import com.webyar.operator.feature.contacts.ContactsScreen
import com.webyar.operator.feature.contacts.ContactsViewModel
import com.webyar.operator.feature.inbox.InboxScreen
import com.webyar.operator.feature.inbox.InboxState
import com.webyar.operator.i18n.Language
import com.webyar.operator.i18n.Format
import androidx.activity.compose.rememberLauncherForActivityResult
import android.os.Build
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.ui.Alignment
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.TopAppBar
import androidx.compose.ui.platform.LocalContext
import com.webyar.operator.feature.settings.AccountViewModel
import com.webyar.operator.feature.settings.ProfileScreen
import com.webyar.operator.feature.settings.SecurityScreen
import com.webyar.operator.i18n.StrAndroid
import androidx.compose.material3.Snackbar
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import com.webyar.operator.feature.chat.RecordedVoice
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import com.webyar.operator.feature.settings.NotificationsScreen
import com.webyar.operator.feature.settings.NotificationsViewModel
import com.webyar.operator.feature.settings.SystemNotificationPermission
import com.webyar.operator.core.media.AttachmentRules
import com.webyar.operator.core.model.MobileAppConfig
import com.webyar.operator.core.model.CallChannel
import com.webyar.operator.core.model.CallChannels
import com.webyar.operator.core.model.CannedText
import com.webyar.operator.core.model.Entitlements
import com.webyar.operator.core.model.InboxFilter
import com.webyar.operator.feature.chat.CannedResponsePicker
import com.webyar.operator.feature.chat.ChatSheet
import com.webyar.operator.feature.chat.ChatViewModel
import com.webyar.operator.feature.chat.ComposerCapabilities
import com.webyar.operator.feature.chat.ConversationMenu
import com.webyar.operator.feature.chat.NotesSheet
import com.webyar.operator.feature.chat.PrioritySheet
import com.webyar.operator.feature.chat.StatusSheet
import com.webyar.operator.feature.chat.TagsSheet
import com.webyar.operator.feature.chat.TransferSheet
import com.webyar.operator.feature.team.ColleaguesScreen
import com.webyar.operator.feature.team.ColleaguesViewModel
import com.webyar.operator.feature.team.TeamThreadScreen
import com.webyar.operator.feature.team.TeamThreadViewModel
import com.webyar.operator.feature.chat.Composer
import com.webyar.operator.ui.components.SearchState
import com.webyar.operator.ui.components.DetailTopBar
import androidx.compose.ui.graphics.Color
import com.webyar.operator.feature.settings.settingsPageColor
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.TextButton
import com.webyar.operator.feature.email.EmailInboxScreen
import com.webyar.operator.feature.email.EmailInboxViewModel
import com.webyar.operator.feature.email.EmailThreadScreen
import com.webyar.operator.feature.email.EmailThreadViewModel
import com.webyar.operator.ui.components.LatinText
import com.webyar.operator.ui.components.PlainComposer
import com.webyar.operator.ui.components.rowTextAlign
import com.webyar.operator.ui.design.WebyarTheme
import androidx.compose.material.icons.filled.Email
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Star
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.LocalContentColor
import androidx.compose.foundation.layout.Column
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import androidx.compose.ui.platform.testTag
import com.webyar.operator.ui.A11y
import com.webyar.operator.feature.promo.PromoBanner
import com.webyar.operator.feature.promo.PromotionCenter
import com.webyar.operator.feature.call.CallScreen
import com.webyar.operator.feature.call.CallSession
import com.webyar.operator.feature.call.LiveKitRoom
import com.webyar.operator.ui.design.Space
import android.content.pm.PackageManager
import androidx.compose.runtime.DisposableEffect
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import com.webyar.operator.feature.chat.VoiceRecorder
import com.webyar.operator.i18n.Str
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewmodel.compose.viewModel
import com.webyar.operator.BuildConfig
import com.webyar.operator.core.net.WebyarApi
import com.webyar.operator.feature.settings.AccountHeader
import com.webyar.operator.feature.settings.SettingsScreen
import com.webyar.operator.feature.settings.SettingsViewModel
import com.webyar.operator.ui.Session
import com.webyar.operator.ui.AppState
import com.webyar.operator.feature.inbox.InboxViewModel
import com.webyar.operator.ui.components.EmptyState
import com.webyar.operator.ui.components.bidiContent
import com.webyar.operator.ui.components.rememberSearchState
import com.webyar.operator.LocalAppGraph
import kotlinx.coroutines.launch
import com.webyar.operator.core.cache.CacheScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.foundation.shape.RoundedCornerShape
import com.webyar.operator.ui.design.Radius
import com.webyar.operator.core.model.Contact
import com.webyar.operator.ui.components.OperatorAvatar
import androidx.compose.ui.unit.dp
import com.webyar.operator.feature.email.EmailReplyMode
import com.webyar.operator.feature.email.EmailComposeViewModel
import com.webyar.operator.feature.email.EmailComposeScreen
import com.webyar.operator.core.model.EmailAttachmentView
import com.webyar.operator.i18n.StrEmail
import com.webyar.operator.ui.components.AttachmentFiles
import com.webyar.operator.ui.components.Glyph
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.AlertDialog
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.lifecycle.compose.LifecycleResumeEffect
import androidx.activity.compose.BackHandler
import androidx.compose.runtime.rememberCoroutineScope
import kotlinx.coroutines.withContext
import kotlinx.coroutines.Dispatchers
import androidx.compose.foundation.layout.size

/**
 * The screens, as the navigation graph sees them.
 *
 * A "route" here is the thin piece that takes what the graph knows — an id
 * from the URL, the callbacks that move to the next place — and hands the
 * screen what it actually needs. The screens themselves stay unaware that
 * navigation exists, which is what keeps them previewable and testable
 * without a NavController.
 */

@Composable
fun InboxRoute(
    appState: AppState,
    conversations: InboxViewModel,
    language: Language,
    onOpenConversation: (String) -> Unit,
    onOpenColleagues: () -> Unit,
    onOpenEmail: () -> Unit,
    promotions: PromotionCenter,
    bottomInset: Dp,
    /** For the colleagues' unread count on their button; null leaves it off. */
    api: WebyarApi? = null,
) {
    val workspace by appState.selectedWorkspace.collectAsStateWithLifecycle()
    val plan by appState.entitlements.collectAsStateWithLifecycle()
    val access by appState.access.collectAsStateWithLifecycle()
    val inbox by conversations.state.collectAsStateWithLifecycle()
    val filter by conversations.filter.collectAsStateWithLifecycle()
    val counts by conversations.counts.collectAsStateWithLifecycle()
    val channels by conversations.channels.collectAsStateWithLifecycle()
    val channel by conversations.channel.collectAsStateWithLifecycle()
    val intel by conversations.intel.collectAsStateWithLifecycle()
    val refreshing by conversations.refreshing.collectAsStateWithLifecycle()
    val syncProblem by conversations.syncProblem.collectAsStateWithLifecycle()

    // Closing the field on a queue change is the same rule the view model
    // applies to the terms: a search box left open over a list it no longer
    // describes is worse than no search box.
    val search = rememberSearchState(resetOn = filter)
    // snapshotFlow rather than reading `search.text` here: a keystroke should
    // recompose the field and the list, not this whole route.
    LaunchedEffect(search) {
        snapshotFlow { search.text }.collect(conversations::setQuery)
    }

    LaunchedEffect(workspace?.id) {
        workspace?.let { conversations.bind(it.id) }
    }

    // A screen that lives by the plan: one over three minutes old is asked for again.
    LaunchedEffect(Unit) { appState.refreshPlanIfStale() }

    // The installed channel inboxes the plan lets this workspace work in (the
    // web's channelInboxVisible) — an owner/admin surface, as in the console's
    // sidebar. One that goes away must not stay selected.
    val visibleChannels = remember(channels, plan, access) {
        if (!access.isAdmin) emptyList()
        else channels.filter { Entitlements.channelInboxVisible(plan.value, it.key) }
    }
    LaunchedEffect(visibleChannels, channel) {
        if (channel != null && visibleChannels.none { it.key == channel }) conversations.selectChannel(null)
    }

    // The queues: the AI queue is the web's aiQueueVisible, which also depends
    // on the AI switches and on whether it already holds threads.
    // The colleagues' unread messages, for the badge on their button. Asked
    // whenever the inbox comes back on screen — which is also when an
    // operator has just been reading them.
    val teamChat = plan.value?.featureEnabled("inbox_team_chat") == true
    var colleaguesUnread by remember { mutableStateOf<Int?>(null) }
    LaunchedEffect(workspace?.id, teamChat, api) {
        val id = workspace?.id
        colleaguesUnread = if (api == null || id == null || !teamChat) {
            null
        } else {
            runCatching { api.colleagues(id).totalUnread }.getOrNull()
        }
    }

    val allFilters = conversations.filters(plan.value, access, counts.automated)
    val chipFilters = conversations.chips(plan.value, access, counts.automated)
    // A queue that has just gone away must not stay selected with nothing behind it.
    LaunchedEffect(allFilters, filter) {
        if (filter !in allFilters) conversations.select(InboxFilter.OPEN)
    }

    // Loaded here and offered here, and nowhere else in the app: the inbox is
    // the one screen an operator is not in the middle of something on.
    val promoted by promotions.promotions.collectAsStateWithLifecycle()
    val dismissed by promotions.bannerDismissed.collectAsStateWithLifecycle()
    // Both flows are collected even though only one is read below: the answer
    // depends on both, and a value read out of a flow nobody is collecting
    // never recomposes when it changes — the banner would refuse to go away.
    val banner = remember(promoted, dismissed, plan) { promotions.banner(plan.value) }
    LaunchedEffect(workspace?.id, language) {
        promotions.load(workspace?.id, language)
    }
    LaunchedEffect(promoted, plan) {
        promotions.offerFullScreen(plan.value)
    }

    InboxScreen(
        state = inbox,
        language = language,
        onOpen = { onOpenConversation(it.id) },
        modifier = Modifier.statusBarsPadding(),
        contentPadding = PaddingValues(bottom = bottomInset),
        filter = filter,
        allFilters = allFilters,
        chipFilters = chipFilters,
        counts = counts,
        channels = visibleChannels,
        selectedChannel = channel,
        intel = intel,
        refreshing = refreshing,
        search = search,
        onSelectFilter = conversations::select,
        onSelectChannel = conversations::selectChannel,
        onRefresh = {
            // Also whatever the launch failed to load: with no workspace
            // there is no list to refresh, and pulling is what people try.
            appState.retryIfIncomplete()
            conversations.refresh()
        },
        // Gated on the plan: a row that leads to a screen the server will
        // refuse is worse than no row.
        //
        // The keys are the registry's own, checked against
        // `server/services/billing/capabilityRegistry.ts`. They used to be
        // `team_chat` and `email`, which are not keys at all, and so both
        // rows showed on every plan, including one whose `email_inbox` is
        // false. Only a key that is exactly true opens a row.
        onOpenColleagues = onOpenColleagues
            .takeIf { plan.value?.featureEnabled("inbox_team_chat") == true },
        // The mailbox is also an owner/admin section, as in the console's sidebar.
        onOpenEmail = onOpenEmail
            .takeIf { access.isAdmin && plan.value?.moduleEnabled("email_inbox") == true },
        colleaguesUnread = colleaguesUnread,
        banner = banner?.let { creative ->
            {
                PromoBanner(
                    creative = creative,
                    language = language,
                    onDismiss = promotions::dismissBanner,
                )
            }
        },
        syncNotice = syncProblem,
    )
}

@Composable
fun ChatRoute(
    conversationId: String,
    appState: AppState,
    api: WebyarApi,
    conversations: InboxViewModel,
    language: Language,
    onBack: () -> Unit,
    onStartCall: (CallChannel) -> Unit,
    onOpenVisitor: (VisitorKey) -> Unit = {},
) {
    val graph = LocalAppGraph.current
    val chatModel: ChatViewModel =
        viewModel(factory = viewModelFactory {
            val sync = graph?.syncGraph()
            if (sync != null) ChatViewModel(api, sync) { language } else ChatViewModel(api) { language }
        })
    val workspace by appState.selectedWorkspace.collectAsStateWithLifecycle()
    val session by appState.session.collectAsStateWithLifecycle()
    val plan by appState.entitlements.collectAsStateWithLifecycle()
    val inbox by conversations.state.collectAsStateWithLifecycle()
    val chat by chatModel.chat.collectAsStateWithLifecycle()
    val cachedConversation by chatModel.conversation.collectAsStateWithLifecycle()
    val draft by chatModel.draft.collectAsStateWithLifecycle()
    val sending by chatModel.sending.collectAsStateWithLifecycle()
    val shortcuts by chatModel.shortcuts.collectAsStateWithLifecycle()
    val notes by chatModel.notes.collectAsStateWithLifecycle()
    val members by chatModel.members.collectAsStateWithLifecycle()
    val voice by chatModel.sayNowVoice.collectAsStateWithLifecycle()
    val notice by chatModel.notice.collectAsStateWithLifecycle()
    // What the inbox knows about this visitor's device and country: the
    // face in the chat is the one on the row that was tapped.
    val intel by conversations.intel.collectAsStateWithLifecycle()

    // The route carries an id, not an object — which is right, because a route
    // has to survive process death and an object does not. The conversation
    // comes from the cache, by id: the inbox does not have to have loaded, or
    // even to list it, which is what lets a notification open a thread.
    val listed = (inbox as? InboxState.Loaded)?.conversations?.firstOrNull { it.id == conversationId }
    val conversation = cachedConversation ?: listed

    // A chat belongs to the workspace it was opened in. If the operator
    // switches workspace while it is on the stack, it is closed rather than
    // re-read under a workspace it is not part of.
    var openedIn by rememberSaveable(conversationId) { mutableStateOf<String?>(null) }
    LaunchedEffect(conversationId, workspace?.id) {
        val ws = workspace?.id ?: return@LaunchedEffect
        val bound = openedIn
        if (bound != null && bound != ws) {
            onBack()
            return@LaunchedEffect
        }
        openedIn = ws
        chatModel.open(conversationId, ws, listed)
    }
    // Opening a conversation answers its notification.
    val context = LocalContext.current
    LaunchedEffect(conversationId) {
        com.webyar.operator.core.push.Notifications.cancelConversation(context, conversationId)
    }
    val attachmentSource = remember(graph, workspace?.id, session) {
        val user = (session as? Session.SignedIn)?.user
        val ws = workspace?.id
        if (graph != null && user != null && ws != null) graph.attachmentSource(CacheScope(user.id, ws)) else null
    }

    val capabilities = remember(conversation) { ComposerCapabilities.resolve(conversation) }
    val aiManaged = capabilities.isAiManaged
    // No calls from the AI's inbox: the AI answers there, and a voice or
    // video call is a person on the line. An operator who wants to call takes
    // the thread over first, which puts it back in their own inbox — and the
    // calls come back with it.
    val callChannels = remember(plan, aiManaged) {
        if (aiManaged) CallChannels.NONE else CallChannels.resolve(plan.value)
    }

    var sheet by remember { mutableStateOf<ChatSheet?>(null) }
    var showShortcuts by remember { mutableStateOf(false) }

    // Reading the bytes stays here rather than in the view model: a Uri is a
    // permission grant to one Activity, and a model that outlives the screen
    // would be holding a handle it is no longer allowed to open.
    val send: (android.net.Uri) -> Unit = { uri ->
        when (val picked = readPickedFile(context, uri)) {
            is PickedFile.Ready -> chatModel.sendAttachment(
                bytes = picked.bytes, fileName = picked.fileName, mimeType = picked.mimeType,
            )
            else -> picked.problemText(language)?.let(chatModel::report)
        }
    }
    val photoPicker = rememberLauncherForActivityResult(
        ActivityResultContracts.PickVisualMedia()
    ) { uri -> uri?.let(send) }
    val filePicker = rememberLauncherForActivityResult(
        ActivityResultContracts.OpenDocument()
    ) { uri -> uri?.let(send) }

    // The recorder holds the microphone, so it is remembered against the
    // context rather than created per recomposition, and it is stopped when
    // the screen goes away — a recorder left running keeps the mic and the
    // next app to ask for it is told no.
    val recorder = remember(context) { VoiceRecorder(context) }
    var recordingSeconds by remember { mutableStateOf<Int?>(null) }
    DisposableEffect(recorder) { onDispose { recorder.cancel() } }
    // A finished recording, held until it is sent or thrown away. Its file
    // goes with the screen if neither happens — a note left in the cache is
    // a stranger's voice on the next operator's phone.
    var recorded by remember { mutableStateOf<RecordedVoice?>(null) }
    val pendingClip = rememberUpdatedState(recorded)
    DisposableEffect(Unit) { onDispose { pendingClip.value?.file?.delete() } }

    LaunchedEffect(recordingSeconds != null) {
        if (recordingSeconds == null) return@LaunchedEffect
        while (true) {
            kotlinx.coroutines.delay(1_000)
            recordingSeconds = (recordingSeconds ?: 0) + 1
        }
    }

    fun beginRecording() {
        when (recorder.start()) {
            null -> recordingSeconds = 0
            VoiceRecorder.Failure.PERMISSION_DENIED ->
                chatModel.report(Str.microphoneDenied(language))
            VoiceRecorder.Failure.UNAVAILABLE ->
                chatModel.report(Str.recordingFailed(language))
        }
    }

    // Asked at the moment the operator taps the microphone, never at launch:
    // a permission dialog on first run, before anyone has asked for anything,
    // is how an app teaches people to say no.
    val micPermission = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        if (granted) beginRecording() else chatModel.report(Str.microphoneDenied(language))
    }

    ChatScreen(
        state = chat,
        language = language,
        onSend = { if (aiManaged) chatModel.sayNow() else chatModel.send() },
        modifier = Modifier.statusBarsPadding(),
        onBack = onBack,
        conversation = conversation,
        draft = draft,
        onDraftChange = chatModel::setDraft,
        sending = sending,
        capabilities = capabilities,
        // NOT plan-gated, because there is no such entitlement: the registry
        // has no `canned_responses` key, and fail-closed on a key that
        // cannot exist hid the button on every plan there is. Whether a
        // deployment carries the table is a separate question, and the
        // server answers it with a 501 that `ChatViewModel` already turns
        // into a "not set up on this server" empty state.
        canUseShortcuts = true,
        // The AI's own voice, offered only where the plan carries the AI.
        // Choosing between "as the specialist" and "as the assistant" on a
        // workspace with no AI module is a choice with one real option.
        sayNowVoice = voice.takeIf { aiManaged && plan.value?.moduleEnabled("ai_assistant") == true },
        onSayNowVoiceChange = chatModel::setSayNowVoice,
        onAttachPhoto = {
            // Images only. `ImageAndVideo` offered a kind the server's
            // allowlist does not carry (`GLOBAL_ALLOWED_MIMES`), so every
            // video the operator picked was a wait followed by a 415.
            photoPicker.launch(
                PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)
            )
        },
        onAttachFile = { filePicker.launch(AttachmentRules.PICKABLE_MIME_TYPES) },
        onOpenShortcuts = {
            showShortcuts = true
            chatModel.loadShortcuts()
        },
        onStartRecording = {
            val already = ContextCompat.checkSelfPermission(
                context, android.Manifest.permission.RECORD_AUDIO,
            ) == PackageManager.PERMISSION_GRANTED
            if (already) beginRecording() else micPermission.launch(android.Manifest.permission.RECORD_AUDIO)
        },
        recordingSeconds = recordingSeconds,
        onDiscardRecording = {
            recorder.cancel()
            recordingSeconds = null
        },
        onFinishRecording = {
            val file = recorder.finishToFile()
            recordingSeconds = null
            if (file == null) {
                // Under a second is a mis-tap, not a message.
                chatModel.report(Str.recordingFailed(language))
            } else {
                // Held, not sent: the operator hears it first, then sends
                // it or throws it away.
                recorded = RecordedVoice(file, recorder.fileName, recorder.mimeType)
            }
        },
        recorded = recorded,
        onSendRecorded = {
            recorded?.let { clip ->
                recorded = null
                val bytes = runCatching { clip.file.readBytes() }.getOrNull()
                clip.file.delete()
                if (bytes == null) {
                    chatModel.report(Str.recordingFailed(language))
                } else {
                    chatModel.sendAttachment(bytes, clip.fileName, clip.mimeType)
                }
            }
        },
        onDiscardRecorded = {
            recorded?.file?.delete()
            recorded = null
        },
        loadAttachment = { id -> runCatching { api.attachmentData(id) }.getOrNull() },
        attachments = attachmentSource,
        onRetry = chatModel::retry,
        onDiscard = chatModel::discard,
        visitor = intel[conversationId],
        onOpenVisitor = conversation?.let { c ->
            {
                onOpenVisitor(
                    VisitorKey(
                        conversationId = c.id,
                        contactId = c.contactId,
                        name = c.contact?.name,
                        email = c.contact?.email,
                        avatarUrl = c.contact?.avatarUrl,
                        visitorCode = c.contact?.visitorCode,
                    )
                )
            }
        },
        header = {
            ConversationMenu(
                language = language,
                conversation = conversation,
                callChannels = callChannels,
                onOpenSheet = { wanted ->
                    if (wanted == ChatSheet.TRANSFER) chatModel.loadMembers()
                    sheet = wanted
                },
                onTakeOver = chatModel::takeOver,
                onVoiceCall = { onStartCall(CallChannel.AUDIO) },
                onVideoCall = { onStartCall(CallChannel.VIDEO) },
            )
        },
    )

    when (sheet) {
        ChatSheet.STATUS -> StatusSheet(
            language, conversation?.status, chatModel::setStatus,
        ) { sheet = null }

        ChatSheet.PRIORITY -> PrioritySheet(
            language, conversation?.priority, chatModel::setPriority,
        ) { sheet = null }

        ChatSheet.TRANSFER -> TransferSheet(
            language, members, conversation?.assignedTo, chatModel::assign,
        ) { sheet = null }

        ChatSheet.TAGS -> TagsSheet(
            language, conversation?.tags.orEmpty(), chatModel::setTags,
        ) { sheet = null }

        ChatSheet.NOTES -> NotesSheet(
            language, notes, chatModel::addNote, chatModel::deleteNote,
        ) { sheet = null }

        null -> Unit
    }

    if (showShortcuts) {
        CannedResponsePicker(
            language = language,
            state = shortcuts,
            onQueryChange = chatModel::loadShortcuts,
            onPick = { reply ->
                chatModel.insertShortcut(
                    reply,
                    CannedText.Context(
                        contactName = conversation?.contact?.name,
                        contactEmail = conversation?.contact?.email,
                        workspaceName = workspace?.name,
                        agentName = (appState.session.value as? Session.SignedIn)?.user?.fullName,
                        agentEmail = (appState.session.value as? Session.SignedIn)?.user?.email,
                    ),
                )
                showShortcuts = false
            },
            onDismiss = { showShortcuts = false },
        )
    }

    notice?.let { message ->
        LaunchedEffect(message) {
            // Shown once. A notice that stays on screen after the operator has
            // seen it becomes part of the furniture, and the next one does not
            // register as new.
            kotlinx.coroutines.delay(3_500)
            chatModel.dismissNotice()
        }
        // The NavHost's slot stacks its children, so this floats over the
        // transcript — but it has to be told to sit at the bottom, or it
        // lands over the conversation's own title.
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.BottomCenter) {
            Snackbar(Modifier.padding(Space.lg)) { Text(message) }
        }
    }
}

/**
 * Contacts, until the contacts screen exists.
 *
 * An honest placeholder rather than a blank: the tab is plan-gated, so an
 * operator who can see it has paid for it, and a blank screen would read as
 * the feature being broken rather than as this build not having it yet.
 */
@Composable
fun ContactsRoute(
    appState: AppState,
    contacts: ContactsViewModel,
    language: Language,
    onOpenContact: (String) -> Unit,
    bottomInset: Dp,
) {
    val workspace by appState.selectedWorkspace.collectAsStateWithLifecycle()
    val state by contacts.state.collectAsStateWithLifecycle()
    val intel by contacts.intel.collectAsStateWithLifecycle()
    val refreshing by contacts.refreshing.collectAsStateWithLifecycle()

    val search = rememberSearchState(resetOn = workspace?.id ?: "-")
    LaunchedEffect(search) {
        snapshotFlow { search.text }.collect(contacts::setQuery)
    }

    LaunchedEffect(workspace?.id) {
        workspace?.let { contacts.bind(it.id) }
    }

    ContactsScreen(
        state = state,
        language = language,
        onOpen = { onOpenContact(it.id) },
        modifier = Modifier.statusBarsPadding(),
        contentPadding = PaddingValues(bottom = bottomInset),
        intel = intel,
        refreshing = refreshing,
        search = search,
        onRefresh = contacts::refresh,
        onRetry = contacts::retry,
    )
}

/**
 * The visitor of a chat, as a contact. The address book's row when it has
 * one — it carries the phone and the first-seen date — and otherwise what the
 * chat already knew; the device and the place from whichever list knows them.
 */
@Composable
fun VisitorContactRoute(
    key: VisitorKey,
    contacts: ContactsViewModel,
    conversations: InboxViewModel,
    language: Language,
    onBack: () -> Unit,
) {
    val conversationIntel by conversations.intel.collectAsStateWithLifecycle()
    val contactIntel by contacts.intel.collectAsStateWithLifecycle()
    val contact = remember(key) {
        key.contactId?.let(contacts::contact) ?: Contact(
            id = key.contactId ?: key.conversationId,
            name = key.name,
            email = key.email,
            avatarUrl = key.avatarUrl,
            visitorCode = key.visitorCode,
        )
    }
    Scaffold(
        topBar = {
            BackBar(
                title = Format.contactName(
                    name = contact.name,
                    email = contact.email,
                    visitorCode = contact.visitorCode,
                    language = language,
                ),
                language = language,
                onBack = onBack,
            )
        },
    ) { padding ->
        ContactDetailScreen(
            contact = contact,
            language = language,
            modifier = Modifier.padding(padding),
            profile = conversationIntel[key.conversationId] ?: key.contactId?.let { contactIntel[it] },
        )
    }
}

@Composable
fun ContactDetailRoute(
    contactId: String,
    contacts: ContactsViewModel,
    language: Language,
    onBack: () -> Unit,
) {
    // Taken from the list the view model already holds rather than re-fetched.
    // The address book has no by-id endpoint, so a refetch would mean pulling
    // the whole book again to find one row of it.
    val contact = remember(contactId) { contacts.contact(contactId) }
    val intel by contacts.intel.collectAsStateWithLifecycle()

    Scaffold(
        topBar = {
            BackBar(
                title = contact?.let {
                    Format.contactName(
                        name = it.name,
                        email = it.email,
                        visitorCode = it.visitorCode,
                        language = language,
                    )
                } ?: Str.tabContacts(language),
                language = language,
                onBack = onBack,
            )
        },
    ) { padding ->
        ContactDetailScreen(
            contact = contact,
            language = language,
            modifier = Modifier.padding(padding),
            profile = intel[contactId],
        )
    }
}

@Composable
fun ColleaguesRoute(
    appState: AppState,
    colleagues: ColleaguesViewModel,
    language: Language,
    onOpenThread: (String) -> Unit,
    onBack: () -> Unit,
) {
    val workspace by appState.selectedWorkspace.collectAsStateWithLifecycle()
    val state by colleagues.state.collectAsStateWithLifecycle()
    val refreshing by colleagues.refreshing.collectAsStateWithLifecycle()

    val search = rememberSearchState(resetOn = workspace?.id ?: "-")
    LaunchedEffect(search) {
        snapshotFlow { search.text }.collect(colleagues::setQuery)
    }
    LaunchedEffect(workspace?.id) {
        workspace?.let { colleagues.bind(it.id) }
    }

    Scaffold(
        topBar = {
            SearchableBar(
                title = Str.colleagues(language),
                language = language,
                search = search,
                onBack = onBack,
            )
        },
    ) { padding ->
        ColleaguesScreen(
            state = state,
            language = language,
            onOpen = {
                // Before navigating, so the badge is gone by the time the
                // thread is on screen rather than one refresh later.
                colleagues.markRead(it.userId)
                onOpenThread(it.userId)
            },
            modifier = Modifier.padding(padding),
            refreshing = refreshing,
            search = search,
            onRefresh = colleagues::refresh,
            onRetry = colleagues::retry,
        )
    }
}

@Composable
fun TeamThreadRoute(
    peerId: String,
    appState: AppState,
    api: WebyarApi,
    colleagues: ColleaguesViewModel,
    language: Language,
    onBack: () -> Unit,
) {
    val thread: TeamThreadViewModel =
        viewModel(factory = viewModelFactory { TeamThreadViewModel(api) { language } })
    val workspace by appState.selectedWorkspace.collectAsStateWithLifecycle()
    val state by thread.state.collectAsStateWithLifecycle()
    val me by thread.me.collectAsStateWithLifecycle()
    val draft by thread.draft.collectAsStateWithLifecycle()
    val sending by thread.sending.collectAsStateWithLifecycle()
    val sendFailed by thread.sendFailed.collectAsStateWithLifecycle()
    val notice by thread.notice.collectAsStateWithLifecycle()

    val colleague = remember(peerId) { colleagues.colleague(peerId) }
    val context = LocalContext.current
    val graph = LocalAppGraph.current
    val session by appState.session.collectAsStateWithLifecycle()
    val attachmentSource = remember(graph, workspace?.id, session) {
        val user = (session as? Session.SignedIn)?.user
        val ws = workspace?.id
        if (graph != null && user != null && ws != null) graph.attachmentSource(CacheScope(user.id, ws)) else null
    }

    LaunchedEffect(workspace?.id, peerId) {
        workspace?.let { thread.open(it.id, peerId) }
    }

    // Polls only while this screen is resumed. `repeatOnLifecycle` and not a
    // bare LaunchedEffect: the latter survives the app going to the
    // background, and a thread being re-read every ten seconds from a phone in
    // a pocket is somebody's battery and somebody's data.
    val lifecycleOwner = LocalLifecycleOwner.current
    LaunchedEffect(lifecycleOwner, peerId) {
        lifecycleOwner.repeatOnLifecycle(Lifecycle.State.RESUMED) {
            thread.pollWhileVisible()
        }
    }

    val sendPicked: (android.net.Uri) -> Unit = { uri ->
        when (val picked = readPickedFile(context, uri)) {
            is PickedFile.Ready ->
                thread.sendAttachment(picked.bytes, picked.fileName, picked.mimeType)
            else -> picked.problemText(language)?.let(thread::report)
        }
    }
    val photoPicker = rememberLauncherForActivityResult(
        ActivityResultContracts.PickVisualMedia()
    ) { uri -> uri?.let(sendPicked) }
    val filePicker = rememberLauncherForActivityResult(
        ActivityResultContracts.OpenDocument()
    ) { uri -> uri?.let(sendPicked) }

    val myAvatar by appState.avatarUrl.collectAsStateWithLifecycle()

    Scaffold(
        topBar = {
            // The colleague's face beside their name, as the visitor chat's
            // bar carries the visitor's.
            DetailTopBar(
                title = colleague?.displayName ?: Str.colleagues(language),
                backLabel = StrAndroid.back(language),
                onBack = onBack,
                leading = colleague?.let { peer ->
                    { OperatorAvatar(imageUrl = peer.avatarUrl, size = 40.dp) }
                },
            )
        },
    ) { padding ->
        Box(Modifier.padding(padding)) {
            TeamThreadScreen(
                state = state,
                me = me,
                language = language,
                loadAttachment = thread::attachment,
                onRetry = thread::retry,
                attachments = attachmentSource,
                peerAvatarUrl = colleague?.avatarUrl,
                myAvatarUrl = myAvatar,
            ) {
                Composer(
                    language = language,
                    draft = draft,
                    onDraftChange = thread::setDraft,
                    capabilities = ComposerCapabilities.TEAM,
                    sending = sending,
                    onSend = thread::send,
                    onAttachPhoto = {
                        photoPicker.launch(
                            PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)
                        )
                    },
                    onAttachFile = { filePicker.launch(AttachmentRules.PICKABLE_MIME_TYPES) },
                    // An internal thread has no saved replies and no AI voice:
                    // both are things you say to a customer.
                    onOpenShortcuts = {},
                    onStartRecording = {},
                )
            }

            // One slot, two sources: the network's own sentence and
            // whatever the operator just tried that could not be done. The
            // specific one wins — it is the one they can act on.
            val problem = notice ?: Str.offlineBody(language).takeIf { sendFailed }
            if (problem != null) {
                Snackbar(
                    modifier = Modifier
                        .align(Alignment.BottomCenter)
                        .padding(Space.md),
                    action = {
                        TextButton(
                            onClick = {
                                thread.dismissNotice()
                                thread.dismissSendError()
                            },
                        ) { Text(Str.cancel(language)) }
                    },
                ) { Text(problem) }
            }
        }
    }
}

/**
 * A back arrow, a title, and a magnifier that brings the field down.
 *
 * The same bar the inbox wears, minus the queue menu — a pushed list still
 * needs a way back, which is the one thing the inbox's own bar never does.
 */
@Composable
private fun SearchableBar(
    title: String,
    language: Language,
    search: SearchState,
    onBack: () -> Unit,
    /** A second, quieter line — whose mailbox this is, when we know. */
    subtitle: String? = null,
) {
    DetailTopBar(
        title = title,
        subtitle = subtitle,
        backLabel = StrAndroid.back(language),
        onBack = onBack,
    ) {
        IconButton(onClick = { search.toggle() }) {
            Icon(Icons.Filled.Search, contentDescription = Str.search(language))
        }
    }
}

@Composable
fun EmailInboxRoute(
    appState: AppState,
    email: EmailInboxViewModel,
    language: Language,
    onOpenThread: (String) -> Unit,
    onBack: () -> Unit,
    onCompose: () -> Unit = {},
) {
    val workspace by appState.selectedWorkspace.collectAsStateWithLifecycle()
    val state by email.state.collectAsStateWithLifecycle()
    val mailbox by email.mailbox.collectAsStateWithLifecycle()
    val notConnected by email.notConnected.collectAsStateWithLifecycle()
    val refreshing by email.refreshing.collectAsStateWithLifecycle()
    val folder by email.folder.collectAsStateWithLifecycle()
    val loadingMore by email.loadingMore.collectAsStateWithLifecycle()

    val search = rememberSearchState(resetOn = workspace?.id ?: "-")
    LaunchedEffect(search) {
        snapshotFlow { search.text }.collect(email::setQuery)
    }
    LaunchedEffect(workspace?.id) {
        workspace?.let { email.bind(it.id) }
    }

    Scaffold(
        topBar = {
            SearchableBar(
                title = Str.emailInbox(language),
                // Two lines, the way a mail client names the mailbox it is
                // showing: what this screen is, and whose it is.
                subtitle = mailbox,
                language = language,
                search = search,
                onBack = onBack,
            )
        },
        floatingActionButton = {
            // A new mail, from wherever the list is — the button every mail
            // client keeps in this corner.
            if (!notConnected) {
                ExtendedFloatingActionButton(
                    onClick = onCompose,
                    icon = { Icon(Icons.Filled.Edit, contentDescription = null) },
                    text = { Text(StrEmail.compose(language)) },
                    modifier = Modifier.testTag(A11y.EMAIL_COMPOSE),
                )
            }
        },
    ) { padding ->
        EmailInboxScreen(
            state = state,
            language = language,
            onOpen = {
                email.markReadLocally(it.id)
                onOpenThread(it.id)
            },
            modifier = Modifier.padding(padding),
            mailbox = mailbox,
            notConnected = notConnected,
            refreshing = refreshing,
            search = search,
            onRefresh = email::refresh,
            onRetry = email::retry,
            folder = folder,
            onSelectFolder = email::selectFolder,
            hasMore = email.hasMore,
            loadingMore = loadingMore,
            onLoadMore = email::loadMore,
            onToggleStar = { email.toggleStar(it.id) },
            onToggleRead = { email.toggleRead(it.id) },
        )
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun EmailThreadRoute(
    threadId: String,
    appState: AppState,
    api: WebyarApi,
    email: EmailInboxViewModel,
    language: Language,
    onBack: () -> Unit,
    onReply: ((EmailReplyMode) -> Unit)? = null,
) {
    val model: EmailThreadViewModel =
        viewModel(factory = viewModelFactory { EmailThreadViewModel(api) { language } })
    val workspace by appState.selectedWorkspace.collectAsStateWithLifecycle()
    val state by model.state.collectAsStateWithLifecycle()
    val thread by model.thread.collectAsStateWithLifecycle()
    val draft by model.draft.collectAsStateWithLifecycle()
    val sending by model.sending.collectAsStateWithLifecycle()
    val sendFailed by model.sendFailed.collectAsStateWithLifecycle()
    val mailbox by email.mailbox.collectAsStateWithLifecycle()
    var menuOpen by remember { mutableStateOf(false) }

    LaunchedEffect(workspace?.id, threadId) {
        workspace?.let { model.open(it.id, threadId, email.thread(threadId)) }
    }
    // Back from the composer: the reply just sent belongs in the trail.
    LifecycleResumeEffect(threadId) {
        model.reloadQuietly()
        onPauseOrDispose { }
    }

    val context = LocalContext.current
    val graph = LocalAppGraph.current
    val session by appState.session.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()
    var notice by remember { mutableStateOf<String?>(null) }
    // A mail's file, fetched into this account's own cache folder (cleared
    // at sign-out with the rest of it) and handed to whatever opens it.
    val openAttachment: (EmailAttachmentView) -> Unit = open@{ attachment ->
        val ws = workspace?.id ?: return@open
        val user = (session as? Session.SignedIn)?.user ?: return@open
        val media = graph?.media ?: return@open
        scope.launch {
            val file = runCatching {
                withContext(Dispatchers.IO) {
                    val folder = java.io.File(media.directory(CacheScope(user.id, ws)), "email").apply { mkdirs() }
                    val name = (attachment.filename ?: attachment.id).replace(Regex("[^A-Za-z0-9._-]"), "_").takeLast(80)
                    val target = java.io.File(folder, "${attachment.id.take(12)}-$name")
                    if (!target.exists() || target.length() == 0L) {
                        target.writeBytes(api.emailAttachmentData(ws, attachment.id))
                    }
                    target
                }
            }.getOrNull()
            notice = when {
                file == null -> StrEmail.downloadFailed(language)
                !AttachmentFiles.openFile(context, file, attachment.contentType) -> StrEmail.openFailed(language)
                else -> null
            }
        }
    }

    Scaffold(
        topBar = {
            DetailTopBar(
                title = Str.emailInbox(language),
                backLabel = StrAndroid.back(language),
                onBack = onBack,
                actions = {
                    // The star where it is seen, in the bar, rather than in a
                    // menu: it is the one thing done to nearly every mail.
                    val starred = thread?.isStarred == true
                    IconButton(onClick = {
                        model.toggleStar()
                        email.setStarredLocally(threadId, !starred)
                    }) {
                        Icon(
                            if (starred) Icons.Filled.Star else Glyph.StarOutline,
                            contentDescription = if (starred) StrEmail.unstar(language) else StrEmail.star(language),
                            tint = if (starred) WebyarTheme.colors.warning else LocalContentColor.current,
                        )
                    }
                    Box {
                        IconButton(
                            onClick = { menuOpen = true },
                            modifier = Modifier.testTag(A11y.EMAIL_MENU),
                        ) {
                            Icon(
                                Icons.Filled.MoreVert,
                                contentDescription = StrAndroid.moreOptions(language),
                            )
                        }
                        DropdownMenu(
                            menuOpen,
                            onDismissRequest = { menuOpen = false },
                            shape = RoundedCornerShape(Radius.lg),
                        ) {
                            DropdownMenuItem(
                                text = { Text(Str.emailMarkUnread(language)) },
                                leadingIcon = {
                                    Icon(Icons.Filled.Email, contentDescription = null)
                                },
                                onClick = {
                                    menuOpen = false
                                    model.markUnread()
                                    email.markUnreadLocally(threadId)
                                    // And back out, because the thread you
                                    // just marked unread is one you are done
                                    // with — staying on it would mark it read
                                    // again the moment anything reloaded.
                                    onBack()
                                },
                            )
                        }
                    }
                },
            )
        },
    ) { padding ->
        Box(Modifier.padding(padding)) {
            EmailThreadScreen(
                state = state,
                thread = thread,
                language = language,
                mailbox = mailbox,
                onRetry = model::retry,
                onOpenAttachment = openAttachment,
                onReply = onReply,
            )

            notice?.let { text ->
                Snackbar(
                    modifier = Modifier.align(Alignment.BottomCenter).padding(Space.md),
                    action = { TextButton(onClick = { notice = null }) { Text(Str.cancel(language)) } },
                ) { Text(text) }
            }

            if (sendFailed) {
                Snackbar(
                    modifier = Modifier.align(Alignment.BottomCenter).padding(Space.md),
                    action = {
                        TextButton(onClick = model::dismissSendError) {
                            Text(Str.cancel(language))
                        }
                    },
                ) { Text(Str.emailSendFailed(language)) }
            }
        }
    }
}

/**
 * Writing a mail — new, or answering a thread — with Send in the bar and
 * the paperclip beside it. Leaving with words written asks first.
 */
@Composable
fun EmailComposeRoute(
    sourceThreadId: String?,
    mode: EmailReplyMode?,
    appState: AppState,
    api: WebyarApi,
    email: EmailInboxViewModel,
    language: Language,
    onClose: () -> Unit,
) {
    val model: EmailComposeViewModel =
        viewModel(factory = viewModelFactory { EmailComposeViewModel(api) { language } })
    val workspace by appState.selectedWorkspace.collectAsStateWithLifecycle()
    val mailbox by email.mailbox.collectAsStateWithLifecycle()
    val form by model.form.collectAsStateWithLifecycle()
    val context = LocalContext.current
    var confirmDiscard by remember { mutableStateOf(false) }

    LaunchedEffect(workspace?.id) {
        workspace?.let { model.start(it.id, sourceThreadId, mode, mailbox) }
    }
    LaunchedEffect(form.sent) {
        if (form.sent) {
            android.widget.Toast.makeText(context, StrEmail.sent(language), android.widget.Toast.LENGTH_SHORT).show()
            email.refresh()
            onClose()
        }
    }

    val filePicker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        uri ?: return@rememberLauncherForActivityResult
        when (val picked = readPickedFile(context, uri)) {
            is PickedFile.Ready -> model.attach(picked.bytes, picked.fileName, picked.mimeType)
            else -> picked.problemText(language)?.let(model::report)
        }
    }
    val close = { if (form.touched && !form.sent) confirmDiscard = true else onClose() }
    BackHandler(enabled = form.touched && !form.sent) { confirmDiscard = true }

    Scaffold(
        topBar = {
            DetailTopBar(
                title = when (mode) {
                    EmailReplyMode.REPLY -> StrEmail.reply(language)
                    EmailReplyMode.REPLY_ALL -> StrEmail.replyAll(language)
                    EmailReplyMode.FORWARD -> StrEmail.forward(language)
                    null -> StrEmail.newMessage(language)
                },
                subtitle = mailbox,
                backLabel = StrAndroid.back(language),
                onBack = close,
                actions = {
                    IconButton(onClick = { filePicker.launch(AttachmentRules.PICKABLE_MIME_TYPES) }, enabled = !form.sending) {
                        Icon(Glyph.Paperclip, contentDescription = StrEmail.addAttachment(language))
                    }
                    IconButton(
                        onClick = model::send,
                        enabled = !form.sending && form.ready,
                        modifier = Modifier.testTag(A11y.EMAIL_COMPOSE_SEND),
                    ) {
                        if (form.sending) {
                            CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
                        } else {
                            Icon(
                                Icons.AutoMirrored.Filled.Send,
                                contentDescription = Str.emailSend(language),
                                tint = MaterialTheme.colorScheme.primary,
                            )
                        }
                    }
                },
            )
        },
    ) { padding ->
        Box(Modifier.padding(padding)) {
            EmailComposeScreen(
                form = form,
                language = language,
                onToChange = model::setTo,
                onCcChange = model::setCc,
                onBccChange = model::setBcc,
                onShowCopies = model::showCopies,
                onSubjectChange = model::setSubject,
                onBodyChange = model::setBody,
                onRemoveAttachment = model::removeAttachment,
            )
            form.error?.let { text ->
                Snackbar(
                    modifier = Modifier.align(Alignment.BottomCenter).padding(Space.md),
                    action = { TextButton(onClick = model::dismissError) { Text(Str.cancel(language)) } },
                ) { Text(text) }
            }
        }
    }

    if (confirmDiscard) {
        AlertDialog(
            onDismissRequest = { confirmDiscard = false },
            title = { Text(StrEmail.discardDraft(language)) },
            confirmButton = {
                TextButton(onClick = { confirmDiscard = false; onClose() }) {
                    Text(StrEmail.discard(language), color = MaterialTheme.colorScheme.error)
                }
            },
            dismissButton = {
                TextButton(onClick = { confirmDiscard = false }) { Text(StrEmail.keepEditing(language)) }
            },
        )
    }
}

/**
 * A call, from the invitation going out.
 *
 * The invitation is created HERE rather than in the chat, so that a route
 * which survives process death can recreate the call rather than resume a
 * half-built one — and so the chat never holds a call's state.
 */
@Composable
fun CallRoute(
    conversationId: String,
    channel: CallChannel,
    appState: AppState,
    api: WebyarApi,
    conversations: InboxViewModel,
    language: Language,
    onDone: () -> Unit,
) {
    val context = LocalContext.current
    val session: CallSession = viewModel(
        // The room is built INSIDE the factory, so it is created exactly once
        // with the session and turning the phone does not build a second one
        // beside the one that is actually connected.
        factory = viewModelFactory {
            CallSession(api, LiveKitRoom(context.applicationContext))
        },
    )
    val room = session.room as LiveKitRoom

    val phase by session.phase.collectAsStateWithLifecycle()
    val connectedAt by session.connectedAt.collectAsStateWithLifecycle()
    val muted by session.muted.collectAsStateWithLifecycle()
    val cameraOn by session.cameraOn.collectAsStateWithLifecycle()
    val speakerOn by session.speakerOn.collectAsStateWithLifecycle()
    val relayWarning by session.relayWarning.collectAsStateWithLifecycle()
    val degraded by session.degraded.collectAsStateWithLifecycle()
    val remoteVideo by room.remoteVideo.collectAsStateWithLifecycle()
    val localVideo by room.localVideo.collectAsStateWithLifecycle()

    val workspace by appState.selectedWorkspace.collectAsStateWithLifecycle()

    // Who we are calling: the cache's row for this conversation, else the
    // inbox's. A call that could not find its name is still a call.
    val inbox by conversations.state.collectAsStateWithLifecycle()
    val intel by conversations.intel.collectAsStateWithLifecycle()
    val graph = LocalAppGraph.current
    val signedIn by appState.session.collectAsStateWithLifecycle()
    val cachedFlow = remember(graph, workspace?.id, signedIn, conversationId) {
        val user = (signedIn as? Session.SignedIn)?.user
        val ws = workspace?.id
        if (graph != null && user != null && ws != null) {
            graph.sync.conversations.observeConversation(CacheScope(user.id, ws), conversationId)
        } else {
            kotlinx.coroutines.flow.flowOf(null)
        }
    }
    val cached by cachedFlow.collectAsStateWithLifecycle(initialValue = null)
    val conversation = cached ?: remember(inbox, conversationId) {
        (inbox as? InboxState.Loaded)?.conversations?.firstOrNull { it.id == conversationId }
    }

    // The permissions are asked for at the moment the call starts, not at
    // launch. A refusal is not fatal: the session degrades and says which
    // half of the call the operator is missing.
    val wanted = remember(channel) {
        if (channel == CallChannel.VIDEO) {
            arrayOf(android.Manifest.permission.RECORD_AUDIO, android.Manifest.permission.CAMERA)
        } else {
            arrayOf(android.Manifest.permission.RECORD_AUDIO)
        }
    }
    var permissionsAsked by remember { mutableStateOf(false) }
    val permissions = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { permissionsAsked = true }

    LaunchedEffect(wanted) {
        val missing = wanted.any {
            ContextCompat.checkSelfPermission(context, it) != PackageManager.PERMISSION_GRANTED
        }
        if (missing) permissions.launch(wanted) else permissionsAsked = true
    }

    // Asks the session to call; it does not do the calling. The request
    // belongs to something that outlives a recomposition, and this effect is
    // not that: it is keyed on `permissionsAsked`, which its own body sets,
    // so its first run was always cancelled mid-flight. `start` is
    // idempotent, so however often this runs again, one call is one
    // invitation.
    LaunchedEffect(workspace?.id, permissionsAsked) {
        if (!permissionsAsked) return@LaunchedEffect
        val id = workspace?.id ?: return@LaunchedEffect
        session.start(
            workspaceId = id,
            conversationId = conversationId,
            channel = channel,
            language = language,
        )
    }

    // Read as the inbox resolves rather than frozen when the call started:
    // the list can still be loading at the moment an operator dials, and a
    // screen that captured the name then would say "visitor" for the whole
    // call about somebody the app knows perfectly well.
    val contactName = Format.contactName(
        name = conversation?.contact?.name,
        email = conversation?.contact?.email,
        visitorCode = conversation?.contact?.visitorCode,
        language = language,
    ).ifEmpty { Str.unknownVisitor(language) }

    CallScreen(
        phase = phase,
        channel = channel,
        contactName = contactName,
        language = language,
        contactAvatarUrl = conversation?.contact?.avatarUrl,
        visitor = intel[conversationId],
        connectedAt = connectedAt,
        muted = muted,
        cameraOn = cameraOn,
        speakerOn = speakerOn,
        relayWarning = relayWarning,
        degraded = degraded,
        remoteVideo = remoteVideo,
        localVideo = localVideo,
        room = room,
        onToggleMute = session::toggleMute,
        onToggleCamera = session::toggleCamera,
        onToggleSpeaker = session::toggleSpeaker,
        onHangUp = session::hangUp,
        onDone = onDone,
    )
}

@Composable
fun SettingsRoute(
    appState: AppState,
    api: WebyarApi,
    language: Language,
    onOpenProfile: () -> Unit,
    onOpenSecurity: () -> Unit,
    onOpenNotifications: () -> Unit,
    bottomInset: Dp,
) {
    val settings: SettingsViewModel = viewModel(factory = viewModelFactory { SettingsViewModel(api) })
    val appearance by appState.appearance.collectAsStateWithLifecycle()
    val workspaces by appState.workspaces.collectAsStateWithLifecycle()
    val selected by appState.selectedWorkspace.collectAsStateWithLifecycle()
    val plan by appState.entitlements.collectAsStateWithLifecycle()
    val availability by settings.availability.collectAsStateWithLifecycle()
    val saveFailed by settings.saveFailed.collectAsStateWithLifecycle()
    val session by appState.session.collectAsStateWithLifecycle()
    val user = (session as? Session.SignedIn)?.user
    val avatarUrl by appState.avatarUrl.collectAsStateWithLifecycle()
    val dynamicColor by appState.dynamicColor.collectAsStateWithLifecycle()
    // Super Admin → Mobile App → Android decides which sections are here.
    val config by appState.appConfig.collectAsStateWithLifecycle()

    // Measured each time the screen is shown; a size is only interesting
    // when somebody is looking at it — and not at all while it is hidden.
    val graph = LocalAppGraph.current
    val context = LocalContext.current
    var storage by remember { mutableStateOf<com.webyar.operator.StorageUsage?>(null) }
    LaunchedEffect(graph, config.showStorage) {
        if (config.showStorage) storage = graph?.storageUsage()
    }

    SettingsScreen(
        language = language,
        appearance = appearance,
        account = AccountHeader(
            name = user?.displayName.orEmpty(),
            email = user?.email,
            avatarUrl = avatarUrl,
        ),
        workspaces = workspaces,
        selectedWorkspace = selected,
        planName = plan.value?.plan?.name,
        availability = availability,
        availabilitySaveFailed = saveFailed,
        appVersion = BuildConfig.VERSION_NAME,
        onOpenProfile = onOpenProfile,
        onOpenSecurity = onOpenSecurity,
        onOpenNotifications = onOpenNotifications,
        onSelectWorkspace = appState::selectWorkspace,
        onSelectLanguage = appState::setLanguage,
        onSelectAppearance = appState::setAppearance,
        onSetForceOffline = settings::setForceOffline,
        onSetAvailableWhenUsingApp = settings::setAvailableWhenUsingApp,
        onSetScheduleEnabled = settings::setScheduleEnabled,
        onSignOut = appState::logOut,
        contentPadding = PaddingValues(bottom = bottomInset),
        // Wallpaper colours exist from Android 12; before that there is
        // nothing to offer and the row is left out.
        // Nor where Super Admin has kept everyone on the brand colours.
        dynamicColor = dynamicColor.takeIf {
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && config.allowWallpaperColors
        },
        onSetDynamicColor = appState::setDynamicColor,
        showNotifications = config.showNotificationSettings,
        showSecurity = config.showSecurity,
        storage = storage,
        // Null leaves the whole Storage section out; the cache keeps working.
        onClearCache = graph?.takeIf { config.showStorage }?.let { g ->
            {
                storage = null
                // On the app's scope, not this screen's: a clear that is
                // half done because the operator tapped Back is worse than
                // one that finishes.
                // The application context, not the screen's: this can finish
                // after the screen is gone and must not hold its Activity.
                val appContext = context.applicationContext
                g.appScope.launch {
                    g.clearCache()
                    storage = g.storageUsage()
                    android.widget.Toast.makeText(appContext, StrAndroid.cacheCleared(language), android.widget.Toast.LENGTH_SHORT).show()
                }
            }
        },
    )
}

/**
 * A one-off view-model factory.
 *
 * Duplicated from MainActivity deliberately rather than shared: a view model
 * that takes its dependencies in its constructor needs one of these, and a
 * single shared helper would have to live somewhere that both the activity and
 * the navigation graph import — which is a module boundary this app does not
 * have yet and does not need for six lines.
 */
inline fun <reified T : ViewModel> viewModelFactory(crossinline create: () -> T) =
    object : ViewModelProvider.Factory {
        @Suppress("UNCHECKED_CAST")
        override fun <V : ViewModel> create(modelClass: Class<V>): V = create() as V
    }

@Composable
fun ProfileRoute(
    api: WebyarApi,
    language: Language,
    onBack: () -> Unit,
    /** Super Admin's switches: which of these the operator may change here. */
    config: MobileAppConfig = MobileAppConfig.DEFAULT,
) {
    val model: AccountViewModel =
        viewModel(factory = viewModelFactory { AccountViewModel(api) { language } })
    val form by model.profile.collectAsStateWithLifecycle()
    val context = LocalContext.current

    // The system Photo Picker on Android 13+, and the documents UI below it —
    // `PickVisualMedia` chooses for us. Neither needs READ_MEDIA_IMAGES: the
    // whole point of the picker is that the operator grants one photograph
    // rather than the app asking to read the gallery.
    val picker = rememberLauncherForActivityResult(
        ActivityResultContracts.PickVisualMedia()
    ) { uri ->
        if (uri == null) return@rememberLauncherForActivityResult
        val resolver = context.contentResolver
        val type = resolver.getType(uri) ?: "image/jpeg"
        val bytes = runCatching {
            resolver.openInputStream(uri)?.use { it.readBytes() }
        }.getOrNull()
        if (bytes != null) model.uploadAvatar(bytes, type, null)
    }

    Scaffold(
        // The settings page's tone, so its cards read as they do there.
        containerColor = settingsPageColor(),
        topBar = { BackBar(Str.profile(language), language, onBack, settingsPageColor()) },
    ) { padding ->
        ProfileScreen(
            language = language,
            firstName = form.firstName,
            lastName = form.lastName,
            email = form.email,
            phone = form.phone,
            avatarUrl = form.avatarUrl,
            busy = form.busy,
            error = form.error,
            onFirstNameChange = model::setFirstName,
            onLastNameChange = model::setLastName,
            onPhoneChange = model::setPhone,
            onPickAvatar = {
                picker.launch(
                    PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)
                )
            },
            onRemoveAvatar = model::removeAvatar,
            onSave = {
                model.saveProfile(
                    nameEditable = config.profileNameEditable,
                    phoneEditable = config.profilePhoneEditable,
                )
            },
            modifier = Modifier.padding(padding),
            nameEditable = config.profileNameEditable,
            phoneEditable = config.profilePhoneEditable,
            photoEditable = config.profilePhotoEditable,
        )
    }
}

/**
 * How this operator wants to be told that something happened.
 *
 * The permission is read fresh on every resume rather than remembered: the
 * operator can leave for the system settings, change it, and come back, and
 * a banner still claiming they are blocked would be the app arguing with
 * the phone.
 */
@Composable
fun NotificationsRoute(
    api: WebyarApi,
    language: Language,
    onBack: () -> Unit,
) {
    val model: NotificationsViewModel =
        viewModel(factory = viewModelFactory { NotificationsViewModel(api) { language } })
    val state by model.state.collectAsStateWithLifecycle()
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current

    var granted by remember { mutableStateOf(notificationsAllowed(context)) }
    var refused by remember { mutableStateOf(false) }

    LaunchedEffect(lifecycleOwner) {
        lifecycleOwner.repeatOnLifecycle(Lifecycle.State.RESUMED) {
            granted = notificationsAllowed(context)
        }
    }

    val graph = LocalAppGraph.current
    val ask = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { allowed ->
        granted = allowed
        // The server should know at once: registered when allowed,
        // unregistered when not — not at the next return to the foreground.
        graph?.let { g -> g.appScope.launch { g.push.sync("permission ${if (allowed) "granted" else "denied"}") } }
        // Android shows the dialog once. A no here means the only way back
        // is the system settings page, and the banner has to say so.
        refused = !allowed
    }

    Scaffold(
        // The settings page's tone, so its cards read as they do there.
        containerColor = settingsPageColor(),
        topBar = { BackBar(Str.notifications(language), language, onBack, settingsPageColor()) },
    ) { padding ->
        NotificationsScreen(
            language = language,
            state = state,
            systemPermission = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                SystemNotificationPermission(
                    granted = granted,
                    canAsk = !refused,
                    onAsk = { ask.launch(android.Manifest.permission.POST_NOTIFICATIONS) },
                    onOpenSettings = { openAppNotificationSettings(context) },
                )
            } else {
                // Below API 33 a notification needs no permission, so there
                // is nothing here that could be wrong — and a banner that
                // can never be dismissed is worse than no banner.
                null
            },
            onSet = model::set,
            onRetry = model::load,
            modifier = Modifier.padding(padding),
        )
    }
}

/**
 * Whether this phone will deliver a notification at all.
 *
 * `areNotificationsEnabled` rather than a permission check, because they are
 * different questions: the permission covers API 33 and up, but a person on
 * any version can turn the app's notifications off in system settings, and
 * an app that only asks about the permission would call that "allowed".
 */
private fun notificationsAllowed(context: android.content.Context): Boolean =
    NotificationManagerCompat.from(context).areNotificationsEnabled()

/** The system's own page for this app's notifications. */
private fun openAppNotificationSettings(context: android.content.Context) {
    val intent = android.content.Intent(android.provider.Settings.ACTION_APP_NOTIFICATION_SETTINGS)
        .putExtra(android.provider.Settings.EXTRA_APP_PACKAGE, context.packageName)
        .addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)
    runCatching { context.startActivity(intent) }
}

@Composable
fun SecurityRoute(
    api: WebyarApi,
    language: Language,
    onBack: () -> Unit,
) {
    val model: AccountViewModel =
        viewModel(factory = viewModelFactory { AccountViewModel(api) { language } })
    val form by model.security.collectAsStateWithLifecycle()

    Scaffold(
        // The settings page's tone, so its cards read as they do there.
        containerColor = settingsPageColor(),
        topBar = { BackBar(Str.security(language), language, onBack, settingsPageColor()) },
    ) { padding ->
        SecurityScreen(
            language = language,
            currentPassword = form.currentPassword,
            newPassword = form.newPassword,
            sessions = form.sessions,
            currentSessionId = form.currentSessionId,
            busy = form.busy,
            message = form.message,
            isError = form.isError,
            onCurrentPasswordChange = model::setCurrentPassword,
            onNewPasswordChange = model::setNewPassword,
            onChangePassword = model::changePassword,
            onRevoke = model::revoke,
            onRevokeOthers = model::revokeOthers,
            modifier = Modifier.padding(padding),
        )
    }
}

/** The bar every pushed screen wears: a title and a way back. */
@Composable
private fun BackBar(
    title: String,
    language: Language,
    onBack: () -> Unit,
    containerColor: Color = MaterialTheme.colorScheme.surface,
) {
    DetailTopBar(
        title = title,
        backLabel = StrAndroid.back(language),
        onBack = onBack,
        containerColor = containerColor,
    )
}

/**
 * What came back from a picker, or why nothing will be sent.
 *
 * A sealed answer rather than a nullable triple because the three ways this
 * fails are three different sentences to the operator, and a null could only
 * ever produce one of them.
 */
internal sealed interface PickedFile {
    data class Ready(val bytes: ByteArray, val fileName: String, val mimeType: String) : PickedFile

    /** Larger than the server's `HARD_MAX_BYTES`. */
    data object TooLarge : PickedFile

    /** A type the server's allowlist does not carry. */
    data object NotAllowed : PickedFile

    /** The provider would not open it — an offline cloud document, usually. */
    data object Unreadable : PickedFile
}

/**
 * The bytes behind a picked file, with a name and a type for them.
 *
 * Read here and now rather than handed on as a URI: the permission a picker
 * grants is scoped to this callback, so a coroutine that opened the stream
 * later would be holding a handle it is no longer allowed to open.
 *
 * The size and the type are checked here too, against the same numbers the
 * server enforces. Sending a 40 MB video and letting the upload come back 400
 * costs the operator the wait and tells them nothing they can act on; iOS has
 * refused both before the upload since it shipped (`Composer.swift`).
 */
internal fun readPickedFile(
    context: android.content.Context,
    uri: android.net.Uri,
): PickedFile {
    val resolver = context.contentResolver
    val mime = AttachmentRules.canonicalMime(resolver.getType(uri)) ?: return PickedFile.NotAllowed

    // Asked before the read, so an oversized file is refused without pulling
    // it through memory first.
    val declared = runCatching {
        resolver.openAssetFileDescriptor(uri, "r")?.use { it.length }
    }.getOrNull()
    if (declared != null && declared > AttachmentRules.MAX_BYTES) return PickedFile.TooLarge

    val bytes = runCatching { resolver.openInputStream(uri)?.use { it.readBytes() } }
        .getOrNull() ?: return PickedFile.Unreadable
    if (bytes.size > AttachmentRules.MAX_BYTES) return PickedFile.TooLarge

    return PickedFile.Ready(
        bytes = bytes,
        fileName = AttachmentRules.sendableFileName(displayName(resolver, uri), mime, "photo"),
        mimeType = mime,
    )
}

/**
 * The name the operator knows the file by.
 *
 * `Uri.lastPathSegment` is not it and never was: a document from the
 * Storage Access Framework answers `primary:Download/report.pdf` and a photo
 * from the system picker answers `1000000034`, so the attachment arrived in
 * the thread called "1000000034" with no extension on it. `DISPLAY_NAME` is
 * the column every `OpenableColumns` provider is required to answer.
 */
private fun displayName(
    resolver: android.content.ContentResolver,
    uri: android.net.Uri,
): String? = runCatching {
    resolver.query(uri, arrayOf(android.provider.OpenableColumns.DISPLAY_NAME), null, null, null)
        ?.use { cursor ->
            if (!cursor.moveToFirst()) return@use null
            cursor.getString(0)?.takeIf { it.isNotBlank() }
        }
}.getOrNull()

/** What to tell the operator about a file that will not be sent. */
internal fun PickedFile.problemText(language: Language): String? = when (this) {
    is PickedFile.Ready -> null
    PickedFile.TooLarge -> Str.fileTooLarge(language)
    PickedFile.NotAllowed -> Str.fileTypeNotAllowed(language)
    PickedFile.Unreadable -> Str.attachmentFailed(language)
}
