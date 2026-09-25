package com.webyar.operator

import android.app.Application
import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import androidx.core.content.ContextCompat
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import com.webyar.operator.core.Diag
import com.webyar.operator.core.cache.CacheDatabaseHolder
import com.webyar.operator.core.cache.CacheMaintenanceWorker
import com.webyar.operator.core.cache.CacheRetention
import com.webyar.operator.core.cache.CacheScope
import com.webyar.operator.core.cache.CacheStore
import com.webyar.operator.core.cache.MemoryCacheStore
import com.webyar.operator.core.cache.RoomCacheStore
import com.webyar.operator.core.media.AttachmentDiskCache
import com.webyar.operator.core.media.AttachmentSource
import com.webyar.operator.core.media.ImageLoading
import com.webyar.operator.core.media.NetworkPolicy
import com.webyar.operator.core.media.ScopedAttachmentSource
import com.webyar.operator.core.model.User
import com.webyar.operator.core.model.Workspace
import com.webyar.operator.core.net.Backend
import com.webyar.operator.core.net.WebyarApi
import com.webyar.operator.core.push.FirebasePushTokens
import com.webyar.operator.core.push.Notifications
import com.webyar.operator.core.push.PushConfig
import com.webyar.operator.core.push.PushContext
import com.webyar.operator.core.push.PushDevice
import com.webyar.operator.core.push.PushRegistrar
import com.webyar.operator.core.push.PushRegistrationWorker
import com.webyar.operator.core.push.PushRouter
import com.webyar.operator.core.push.PushSession
import com.webyar.operator.core.push.StoredPushState
import com.webyar.operator.core.realtime.KtorRealtimeTransport
import com.webyar.operator.core.realtime.RealtimeClient
import com.webyar.operator.core.realtime.RealtimeCoordinator
import com.webyar.operator.core.storage.Preferences
import com.webyar.operator.core.storage.SecureStore
import com.webyar.operator.core.storage.SessionCache
import com.webyar.operator.core.sync.ConversationRepository
import com.webyar.operator.core.sync.MessageRepository
import com.webyar.operator.core.sync.OutgoingSender
import com.webyar.operator.core.sync.SyncCoordinator
import com.webyar.operator.core.sync.SyncGraph
import com.webyar.operator.i18n.Language
import com.webyar.operator.ui.SessionHooks
import com.webyar.operator.ui.components.AttachmentCache
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File

/**
 * Everything the app holds once, for the life of the process.
 *
 * The API client, the cache, the sync layer, the realtime socket and the
 * push registration are app-wide by nature — a push can arrive with no
 * activity alive, a socket belongs to the app being in front rather than to
 * a screen — so they live here and not in a view model. Screens get them
 * through [syncGraph] and [attachmentSource].
 *
 * Built lazily (see [WebyarApp.graph]) so that a process started only to
 * run a background job, or a Robolectric test that never opens the app, pays
 * for none of it.
 */
class AppGraph(private val app: Application) {

    val diag: Diag = Diag.Android
    val appScope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

    val secureStore = SecureStore(app)
    val api: WebyarApi = Backend.create(app)
    val sessionCache = SessionCache(secureStore)
    val preferences = Preferences(secureStore)

    // MARK: - Cache and sync

    private val database = CacheDatabaseHolder(app)

    /** The sample backend's data is in memory; so is its cache. */
    val cache: CacheStore = if (Backend.isSample) MemoryCacheStore() else RoomCacheStore(app, database)

    val sync = SyncCoordinator(
        conversations = ConversationRepository(api, cache, diag = diag),
        messages = MessageRepository(api, cache, diag = diag),
        appScope = appScope,
        diag = diag,
    )

    private val retention = CacheRetention(cache, diag = diag)

    val media = AttachmentDiskCache(
        root = File(app.cacheDir, AttachmentDiskCache.DIRECTORY),
        budget = { AttachmentDiskCache.budgetFor(app, File(app.cacheDir, AttachmentDiskCache.DIRECTORY)) },
        diag = diag,
    )

    // MARK: - Session

    /** Who is signed in, where, and what is on screen — as the background parts of the app need to know it. */
    private class Session {
        @Volatile var user: User? = null
        @Volatile var avatarUrl: String? = null
        @Volatile var workspaceIds: Set<String> = emptySet()
        @Volatile var language: Language = Language.DEFAULT
        @Volatile var foreground: Boolean = false
    }

    private val session = Session()

    fun syncGraph(): SyncGraph = SyncGraph(
        coordinator = sync,
        account = { session.user?.id },
        sender = { session.user?.let { OutgoingSender(it.id, it.fullName ?: it.email, session.avatarUrl) } },
    )

    fun attachmentSource(scope: CacheScope): AttachmentSource =
        ScopedAttachmentSource(api, media, scope, dataSaver = { NetworkPolicy.isDataSaverOn(app) }, diag = diag)

    // MARK: - Realtime and push

    private val realtime = RealtimeCoordinator(
        clientFactory = { sink ->
            RealtimeClient(api, KtorRealtimeTransport(), sink, diag = diag, appVersion = BuildConfig.VERSION_NAME)
        },
        sync = sync,
        appScope = appScope,
        diag = diag,
    )

    val push = PushRegistrar(
        api = api,
        tokens = FirebasePushTokens { PushConfig.isConfigured && !Backend.isSample },
        state = StoredPushState(secureStore),
        permission = { PushDevice.permissionOf(app) },
        device = PushDevice.info(BuildConfig.VERSION_NAME, BuildConfig.VERSION_CODE),
        diag = diag,
        scheduleRetry = { PushRegistrationWorker.enqueue(app, "retry", replace = false) },
    )

    val pushRouter = PushRouter(
        sync = sync,
        context = {
            session.user?.let { user ->
                PushContext(
                    accountId = user.id,
                    workspaceIds = session.workspaceIds,
                    language = session.language,
                    foreground = session.foreground,
                    openConversationIds = sync.openThreadIds(),
                )
            }
        },
        show = { payload, title, body, language -> Notifications.showMessage(app, payload, title, body, language) },
        diag = diag,
    )

    val hooks: SessionHooks = object : SessionHooks {
        override fun signedIn(user: User) {
            session.user = user
        }

        override fun workspaceSelected(user: User, workspace: Workspace, all: List<Workspace>) {
            session.user = user
            session.workspaceIds = all.map { it.id }.toSet()
            realtime.setWorkspace(workspace.id)
            appScope.launch { push.bind(PushSession(user.id, workspace.id), reason = "workspace") }
        }

        override fun languageChanged(language: Language) {
            session.language = language
            Notifications.ensureChannels(app, language)
        }

        override suspend fun beforeSignOut(user: User) {
            push.beforeSignOut()
        }

        override suspend fun signedOut(accountId: String?) {
            realtime.setWorkspace(null)
            sync.clear()
            session.user = null
            session.avatarUrl = null
            session.workspaceIds = emptySet()
            PushRegistrationWorker.cancel(app)
            Notifications.cancelAll(app)
            AttachmentCache.clear()
            ImageLoading.clear(app)
            withContext(Dispatchers.IO) {
                File(app.cacheDir, "${AttachmentDiskCache.DIRECTORY}/transient").deleteRecursively()
            }
            if (accountId != null) {
                runCatching { media.purgeAccount(accountId) }
                runCatching { cache.purgeAccount(accountId) }
            }
            push.afterSignOut()
            diag.info("Session", "signed out: realtime off, push revoked, caches purged")
        }
    }

    fun setAvatar(url: String?) {
        session.avatarUrl = url
    }

    // MARK: - Lifecycle

    private var started = false

    /**
     * Ties realtime and sync to the PROCESS being in front, not to any one
     * screen: `ProcessLifecycleOwner` reports STARTED while any activity is
     * visible and STOPPED a moment after the last one goes, which is exactly
     * "the app is being used". Idempotent; the first activity calls it.
     */
    fun start() {
        if (started) return
        started = true
        ProcessLifecycleOwner.get().lifecycle.addObserver(object : DefaultLifecycleObserver {
            override fun onStart(owner: LifecycleOwner) = setForeground(true)
            override fun onStop(owner: LifecycleOwner) = setForeground(false)
        })
        watchNetwork()
        CacheMaintenanceWorker.schedule(app)
    }

    private fun setForeground(value: Boolean) {
        session.foreground = value
        sync.setForeground(value)
        realtime.setForeground(value)
        // Back in front: the permission may have changed in system settings,
        // or the token may have rotated while the app was closed.
        if (value && session.user != null) appScope.launch { push.sync("foreground") }
    }

    /**
     * A hint, not a truth: the network coming back is a reason to retry the
     * socket now rather than at the end of its backoff. Whether a request
     * works is still decided by the request.
     */
    private fun watchNetwork() {
        val connectivity = ContextCompat.getSystemService(app, ConnectivityManager::class.java) ?: return
        runCatching {
            connectivity.registerDefaultNetworkCallback(object : ConnectivityManager.NetworkCallback() {
                override fun onAvailable(network: Network) {
                    appScope.launch { realtime.onNetworkAvailable() }
                }
            })
        }
    }

    // MARK: - Storage

    /** The daily housekeeping (`CacheMaintenanceWorker`). */
    suspend fun maintenance() {
        runCatching { retention.run() }
        runCatching { media.trim() }
    }

    suspend fun storageUsage(): StorageUsage {
        val stats = runCatching { cache.stats() }.getOrNull()
        return StorageUsage(
            conversationsBytes = stats?.bytes ?: 0L,
            messageCount = stats?.messages ?: 0,
            imagesBytes = withContext(Dispatchers.IO) { ImageLoading.diskBytes(app) },
            mediaBytes = runCatching { media.sizeBytes() }.getOrDefault(0L),
        )
    }

    /**
     * Clear Cache. The cached rows, the cursors (so the next read is whole),
     * the attachment files and both memory caches, and the pictures. Not the
     * session, not the settings, not the outbox, not anything on the server.
     * A file open in a player or another app right now is stepped round and
     * goes at the next trim.
     */
    suspend fun clearCache() {
        runCatching { cache.clear() }
        runCatching { media.clear() }
        AttachmentCache.clear()
        ImageLoading.clear(app)
        diag.info("Cache", "cleared by the operator")
        // Rebuild what is on screen now rather than leave it empty.
        appScope.launch { sync.reconcile("cache cleared") }
    }
}

/** What the Storage section shows. */
data class StorageUsage(
    val conversationsBytes: Long,
    val messageCount: Int,
    val imagesBytes: Long,
    val mediaBytes: Long,
) {
    val totalBytes: Long get() = conversationsBytes + imagesBytes + mediaBytes
}

/** The graph, from any context in this app. */
val Context.appGraph: AppGraph get() = (applicationContext as WebyarApp).graph
