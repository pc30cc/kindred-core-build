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
import androidx.compose.ui.unit.Dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.webyar.operator.feature.chat.ChatScreen
import com.webyar.operator.feature.inbox.InboxScreen
import com.webyar.operator.feature.inbox.InboxState
import com.webyar.operator.i18n.Language
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
import com.webyar.operator.ui.design.Space
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
import com.webyar.operator.ui.ConversationViewModel
import com.webyar.operator.ui.components.EmptyState

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
    conversations: ConversationViewModel,
    language: Language,
    onOpenConversation: (String) -> Unit,
    bottomInset: Dp,
) {
    val workspace by appState.selectedWorkspace.collectAsStateWithLifecycle()
    val inbox by conversations.inbox.collectAsStateWithLifecycle()

    LaunchedEffect(workspace?.id) {
        workspace?.let { conversations.loadInbox(it.id) }
    }

    InboxScreen(
        state = inbox,
        language = language,
        onOpen = { onOpenConversation(it.id) },
        modifier = Modifier.statusBarsPadding(),
        contentPadding = PaddingValues(bottom = bottomInset),
    )
}

@Composable
fun ChatRoute(
    conversationId: String,
    appState: AppState,
    api: WebyarApi,
    conversations: ConversationViewModel,
    language: Language,
    onBack: () -> Unit,
) {
    val chatModel: ChatViewModel =
        viewModel(factory = viewModelFactory { ChatViewModel(api) { language } })
    val workspace by appState.selectedWorkspace.collectAsStateWithLifecycle()
    val plan by appState.entitlements.collectAsStateWithLifecycle()
    val inbox by conversations.inbox.collectAsStateWithLifecycle()
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
        val resolver = context.contentResolver
        val bytes = runCatching { resolver.openInputStream(uri)?.use { it.readBytes() } }.getOrNull()
        if (bytes != null) {
            chatModel.sendAttachment(
                bytes = bytes,
                fileName = uri.lastPathSegment?.substringAfterLast('/') ?: "file",
                mimeType = resolver.getType(uri) ?: "application/octet-stream",
            )
        }
    }
    val photoPicker = rememberLauncherForActivityResult(
        ActivityResultContracts.PickVisualMedia()
    ) { uri -> uri?.let(send) }
    val filePicker = rememberLauncherForActivityResult(
        ActivityResultContracts.OpenDocument()
    ) { uri -> uri?.let(send) }

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
        onStartRecording = { /* the recorder arrives with the next step */ },
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
    language: Language,
    bottomInset: Dp,
) {
    EmptyState(
        icon = Icons.Filled.Person,
        title = Str.tabContacts(language),
        body = null,
        modifier = Modifier.statusBarsPadding(),
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
        title = { Text(title) },
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
