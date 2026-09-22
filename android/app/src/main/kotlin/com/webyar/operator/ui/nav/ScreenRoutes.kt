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
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import com.webyar.operator.core.model.CallChannels
import com.webyar.operator.core.model.CannedText
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
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.TextButton
import com.webyar.operator.ui.design.Space
import android.content.pm.PackageManager
import androidx.compose.runtime.DisposableEffect
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
    bottomInset: Dp,
) {
    val workspace by appState.selectedWorkspace.collectAsStateWithLifecycle()
    val plan by appState.entitlements.collectAsStateWithLifecycle()
    val inbox by conversations.state.collectAsStateWithLifecycle()
    val filter by conversations.filter.collectAsStateWithLifecycle()
    val counts by conversations.counts.collectAsStateWithLifecycle()
    val channels by conversations.channels.collectAsStateWithLifecycle()
    val channel by conversations.channel.collectAsStateWithLifecycle()
    val intel by conversations.intel.collectAsStateWithLifecycle()
    val refreshing by conversations.refreshing.collectAsStateWithLifecycle()

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

    InboxScreen(
        state = inbox,
        language = language,
        onOpen = { onOpenConversation(it.id) },
        modifier = Modifier.statusBarsPadding(),
        contentPadding = PaddingValues(bottom = bottomInset),
        filter = filter,
        allFilters = conversations.filters(plan.value),
        chipFilters = conversations.chips(plan.value),
        counts = counts,
        channels = channels,
        selectedChannel = channel,
        intel = intel,
        refreshing = refreshing,
        search = search,
        onSelectFilter = conversations::select,
        onSelectChannel = conversations::selectChannel,
        onRefresh = conversations::refresh,
        // Gated on the plan's module, like the Contacts tab: a row that leads
        // to a screen the server will refuse is worse than no row.
        onOpenColleagues = onOpenColleagues
            .takeIf { plan.value?.moduleInPlan("team_chat") == true },
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
) {
    val chatModel: ChatViewModel =
        viewModel(factory = viewModelFactory { ChatViewModel(api) { language } })
    val workspace by appState.selectedWorkspace.collectAsStateWithLifecycle()
    val plan by appState.entitlements.collectAsStateWithLifecycle()
    val inbox by conversations.state.collectAsStateWithLifecycle()
    val chat by chatModel.chat.collectAsStateWithLifecycle()
    val draft by chatModel.draft.collectAsStateWithLifecycle()
    val sending by chatModel.sending.collectAsStateWithLifecycle()
    val shortcuts by chatModel.shortcuts.collectAsStateWithLifecycle()
    val notes by chatModel.notes.collectAsStateWithLifecycle()
    val members by chatModel.members.collectAsStateWithLifecycle()
    val voice by chatModel.sayNowVoice.collectAsStateWithLifecycle()
    val notice by chatModel.notice.collectAsStateWithLifecycle()

    // The route carries an id, not an object — which is right, because a route
    // has to survive process death and an object does not. The conversation is
    // looked up from the list that is already loaded; if the process WAS
    // restarted, the list reloads first and this resolves on the next frame.
    val conversation = (inbox as? InboxState.Loaded)
        ?.conversations
        ?.firstOrNull { it.id == conversationId }

    LaunchedEffect(conversationId, conversation?.id, workspace?.id) {
        val open = conversation ?: return@LaunchedEffect
        val ws = workspace?.id ?: return@LaunchedEffect
        chatModel.open(open, ws)
    }

    val capabilities = remember(conversation, plan) {
        ComposerCapabilities.resolve(conversation, plan.value)
    }
    val callChannels = remember(plan) { CallChannels.resolve(plan.value) }
    val aiManaged = capabilities.isAiManaged

    var sheet by remember { mutableStateOf<ChatSheet?>(null) }
    var showShortcuts by remember { mutableStateOf(false) }

    // Reading the bytes stays here rather than in the view model: a Uri is a
    // permission grant to one Activity, and a model that outlives the screen
    // would be holding a handle it is no longer allowed to open.
    val context = LocalContext.current
    val send: (android.net.Uri) -> Unit = { uri ->
        readPickedFile(context, uri)?.let { (bytes, name, mime) ->
            chatModel.sendAttachment(bytes = bytes, fileName = name, mimeType = mime)
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
        canUseShortcuts = plan.value?.featureEnabled("canned_responses") == true,
        sayNowVoice = if (aiManaged) voice else null,
        onSayNowVoiceChange = chatModel::setSayNowVoice,
        onAttachPhoto = {
            photoPicker.launch(
                PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageAndVideo)
            )
        },
        onAttachFile = { filePicker.launch(arrayOf("*/*")) },
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
            val bytes = recorder.finish()
            recordingSeconds = null
            if (bytes == null) {
                // Under a second is a mis-tap, not a message.
                chatModel.report(Str.recordingFailed(language))
            } else {
                chatModel.sendAttachment(bytes, recorder.fileName, recorder.mimeType)
            }
        },
        loadAttachment = { id -> runCatching { api.attachmentData(id) }.getOrNull() },
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
                onVoiceCall = { /* calls arrive with their own step */ },
                onVideoCall = { },
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
    val plan by appState.entitlements.collectAsStateWithLifecycle()
    val state by thread.state.collectAsStateWithLifecycle()
    val me by thread.me.collectAsStateWithLifecycle()
    val draft by thread.draft.collectAsStateWithLifecycle()
    val sending by thread.sending.collectAsStateWithLifecycle()
    val sendFailed by thread.sendFailed.collectAsStateWithLifecycle()

    val colleague = remember(peerId) { colleagues.colleague(peerId) }
    val context = LocalContext.current

    LaunchedEffect(workspace?.id, peerId) {
        workspace?.let { thread.open(it.id, peerId) }
    }

    val photoPicker = rememberLauncherForActivityResult(
        ActivityResultContracts.PickVisualMedia()
    ) { uri ->
        uri ?: return@rememberLauncherForActivityResult
        readPickedFile(context, uri)?.let { (bytes, name, mime) ->
            thread.sendAttachment(bytes, name, mime)
        }
    }
    val filePicker = rememberLauncherForActivityResult(
        ActivityResultContracts.OpenDocument()
    ) { uri ->
        uri ?: return@rememberLauncherForActivityResult
        readPickedFile(context, uri)?.let { (bytes, name, mime) ->
            thread.sendAttachment(bytes, name, mime)
        }
    }

    Scaffold(
        topBar = {
            BackBar(
                title = colleague?.displayName ?: Str.colleagues(language),
                language = language,
                onBack = onBack,
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
            ) {
                Composer(
                    language = language,
                    draft = draft,
                    onDraftChange = thread::setDraft,
                    capabilities = ComposerCapabilities.team(plan.value),
                    sending = sending,
                    onSend = thread::send,
                    onAttachPhoto = {
                        photoPicker.launch(
                            PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)
                        )
                    },
                    onAttachFile = { filePicker.launch(arrayOf("*/*")) },
                    // An internal thread has no saved replies and no AI voice:
                    // both are things you say to a customer.
                    onOpenShortcuts = {},
                    onStartRecording = {},
                )
            }

            if (sendFailed) {
                Snackbar(
                    modifier = Modifier
                        .align(Alignment.BottomCenter)
                        .padding(Space.md),
                    action = {
                        TextButton(onClick = thread::dismissSendError) {
                            Text(Str.cancel(language))
                        }
                    },
                ) { Text(Str.offlineBody(language)) }
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
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun SearchableBar(
    title: String,
    language: Language,
    search: SearchState,
    onBack: () -> Unit,
) {
    TopAppBar(
        title = { Text(title, maxLines = 1, overflow = TextOverflow.Ellipsis) },
        navigationIcon = {
            IconButton(onClick = onBack) {
                Icon(
                    Icons.AutoMirrored.Filled.ArrowBack,
                    contentDescription = StrAndroid.back(language),
                )
            }
        },
        actions = {
            IconButton(onClick = { search.toggle() }) {
                Icon(Icons.Filled.Search, contentDescription = Str.search(language))
            }
        },
    )
}

@Composable
fun SettingsRoute(
    appState: AppState,
    api: WebyarApi,
    language: Language,
    onOpenProfile: () -> Unit,
    onOpenSecurity: () -> Unit,
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

    SettingsScreen(
        language = language,
        appearance = appearance,
        account = AccountHeader(
            name = user?.displayName.orEmpty(),
            email = user?.email,
            avatarUrl = null,
        ),
        workspaces = workspaces,
        selectedWorkspace = selected,
        planName = plan.value?.plan?.name,
        availability = availability,
        availabilitySaveFailed = saveFailed,
        appVersion = BuildConfig.VERSION_NAME,
        onOpenProfile = onOpenProfile,
        onOpenSecurity = onOpenSecurity,
        onSelectWorkspace = appState::selectWorkspace,
        onSelectLanguage = appState::setLanguage,
        onSelectAppearance = appState::setAppearance,
        onSetForceOffline = settings::setForceOffline,
        onSetAvailableWhenUsingApp = settings::setAvailableWhenUsingApp,
        onSetScheduleEnabled = settings::setScheduleEnabled,
        onSignOut = appState::logOut,
        modifier = Modifier.statusBarsPadding(),
        contentPadding = PaddingValues(bottom = bottomInset),
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
        topBar = { BackBar(Str.profile(language), language, onBack) },
    ) { padding ->
        ProfileScreen(
            language = language,
            name = form.name,
            email = form.email,
            avatarUrl = form.avatarUrl,
            busy = form.busy,
            error = form.error,
            onNameChange = model::setName,
            onPickAvatar = {
                picker.launch(
                    PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)
                )
            },
            onRemoveAvatar = model::removeAvatar,
            onSave = { model.saveProfile() },
            modifier = Modifier.padding(padding),
        )
    }
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
        topBar = { BackBar(Str.security(language), language, onBack) },
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
            modifier = Modifier.padding(padding),
        )
    }
}

/** The bar every pushed screen wears: a title and a way back. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun BackBar(title: String, language: Language, onBack: () -> Unit) {
    TopAppBar(
        title = {
            Text(
                title,
                // A contact's name is whatever they typed, and
                // "Alexander Konstantinopoulos" is two words wider than the
                // bar. One line, ellipsised, and its reading order from the
                // name rather than from the layout.
                style = MaterialTheme.typography.titleLarge.bidiContent(),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        },
        navigationIcon = {
            IconButton(onClick = onBack) {
                Icon(
                    // AutoMirrored: a back arrow points the way you came, and
                    // in Persian that is the other way.
                    Icons.AutoMirrored.Filled.ArrowBack,
                    contentDescription = StrAndroid.back(language),
                )
            }
        },
    )
}

/**
 * The bytes behind a picked file, with a name and a type for them.
 *
 * Read here and now rather than handed on as a URI: the permission a picker
 * grants is scoped to this callback, so a coroutine that opened the stream
 * later would be holding a handle it is no longer allowed to open.
 *
 * Null when the read fails, which is the ordinary outcome for a file on a
 * provider that has gone away — a cloud document the user is offline from,
 * say. The caller sends nothing rather than sending an empty file.
 */
private fun readPickedFile(
    context: android.content.Context,
    uri: android.net.Uri,
): Triple<ByteArray, String, String>? {
    val resolver = context.contentResolver
    val bytes = runCatching { resolver.openInputStream(uri)?.use { it.readBytes() } }
        .getOrNull() ?: return null
    return Triple(
        bytes,
        uri.lastPathSegment?.substringAfterLast('/') ?: "file",
        resolver.getType(uri) ?: "application/octet-stream",
    )
}
