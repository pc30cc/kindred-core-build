package com.webyar.ai.core.push

import android.content.Context
import com.google.android.gms.tasks.Task
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.webyar.ai.BuildConfig
import com.webyar.ai.core.Diag
import com.webyar.ai.core.model.FirebaseClientConfig
import com.webyar.ai.core.model.MobileAppConfig
import kotlinx.serialization.json.Json
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/**
 * Firebase, configured from Super Admin or from the build rather than from a
 * committed file.
 *
 * The usual route is `google-services.json` plus the Google Services Gradle
 * plugin, which bakes the project's identifiers into resources. Here the four
 * values come from one of two places:
 *
 *  - **Super Admin** → Mobile App → Android → Identity, which the app reads
 *    from `GET /api/mobile-app/config` ([MobileAppConfig.firebase]) and
 *    keeps ([adopt]). The ordinary case: the published APK carries no
 *    project, and a phone that has once been told the project starts
 *    Firebase with it at every launch after — including the cold start a
 *    push itself causes, before anyone has signed in to ask.
 *  - **The build** (`WEBYAR_FIREBASE_*`, see `app/build.gradle.kts`), which
 *    wins when present: a developer's build against their own project stays
 *    on it whatever the server says.
 *
 * None of the four is a secret in the credential sense (all four ship inside
 * every APK made with them). The server's FCM credentials — the service
 * account that actually sends — are a different matter and never touch this
 * app: `server/services/push/fcm.ts`.
 */
object PushConfig {

    /** The build's own project, when it was built with one. */
    val fromBuild: FirebaseClientConfig?
        get() = FirebaseClientConfig(
            appId = BuildConfig.FIREBASE_APP_ID,
            apiKey = BuildConfig.FIREBASE_API_KEY,
            projectId = BuildConfig.FIREBASE_PROJECT_ID,
            senderId = BuildConfig.FIREBASE_SENDER_ID,
        ).takeIf { it.isComplete }

    /**
     * Started. A build whose Firebase could not start must not reach
     * `FirebaseMessaging.getInstance()`, which would throw on every sync and
     * queue retries for nothing.
     */
    fun isReady(context: Context): Boolean =
        runCatching { FirebaseApp.getApps(context).isNotEmpty() }.getOrDefault(false)

    /**
     * Starts the default Firebase app with the build's project, else the one
     * Super Admin last sent; false — and push stays off until one arrives —
     * when there is neither. Cheap: no network, no token; the token is asked
     * for only once somebody signs in.
     */
    fun initialize(context: Context, diag: Diag = Diag.Android): Boolean {
        val config = choose(fromBuild, stored(context)) ?: return false
        return start(context, config, diag)
    }

    /**
     * Super Admin's project, as the app's config just gave it. Kept for every
     * launch after; true when it has just started Firebase — nothing was
     * running before — so the caller registers this phone for push now
     * rather than at the next launch.
     *
     * Nothing, or a partial set, leaves what is kept: a phone registered
     * with a project goes on receiving through it until another one is set,
     * and the server stops sending by losing its own service account, not by
     * a field emptied here. A different project replaces the kept one but
     * takes effect at the next launch — Firebase cannot be restarted with
     * other options in a running process.
     */
    fun adopt(context: Context, incoming: FirebaseClientConfig?, diag: Diag = Diag.Android): Boolean {
        if (fromBuild != null) return false
        val config = incoming?.takeIf { it.isComplete } ?: return false
        if (config != stored(context)) {
            save(context, config)
            diag.info(AREA, "Firebase project set from Super Admin")
        }
        if (isReady(context)) {
            val running = runCatching { FirebaseApp.getInstance().options.projectId }.getOrNull()
            if (running != config.projectId) diag.info(AREA, "Firebase project changed; used from the next launch")
            return false
        }
        return start(context, config, diag)
    }

    /** The build's project wins; else the one kept from Super Admin, if it is whole. */
    fun choose(build: FirebaseClientConfig?, stored: FirebaseClientConfig?): FirebaseClientConfig? =
        build?.takeIf { it.isComplete } ?: stored?.takeIf { it.isComplete }

    private fun start(context: Context, config: FirebaseClientConfig, diag: Diag): Boolean = runCatching {
        if (FirebaseApp.getApps(context).isEmpty()) {
            FirebaseApp.initializeApp(
                context,
                FirebaseOptions.Builder()
                    .setApplicationId(config.appId)
                    .setApiKey(config.apiKey)
                    .setProjectId(config.projectId)
                    .setGcmSenderId(config.senderId)
                    .build(),
            )
        }
        true
    }.getOrElse {
        diag.warn(AREA, "Firebase could not start: ${it.javaClass.simpleName}")
        false
    }

    // Ordinary preferences, read synchronously: Application.onCreate needs
    // them before a push that woke the process is handed over. Not backed up
    // (the manifest's allowBackup is false), and not the operator's data, so
    // they outlive a sign-out.
    private fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun stored(context: Context): FirebaseClientConfig? = runCatching {
        prefs(context).getString(KEY, null)?.let { json.decodeFromString(FirebaseClientConfig.serializer(), it) }
    }.getOrNull()

    private fun save(context: Context, config: FirebaseClientConfig) {
        prefs(context).edit().putString(KEY, json.encodeToString(FirebaseClientConfig.serializer(), config)).apply()
    }

    private val json = Json { ignoreUnknownKeys = true }
    private const val PREFS = "webyar.firebase"
    private const val KEY = "client"
    private const val AREA = "Push"
}

/** A Play-services task, awaited without the `kotlinx-coroutines-play-services` artifact for one call. */
internal suspend fun <T> Task<T>.awaitResult(): T = suspendCancellableCoroutine { continuation ->
    addOnCompleteListener { task ->
        if (task.isSuccessful) {
            @Suppress("UNCHECKED_CAST")
            continuation.resume(task.result as T)
        } else {
            continuation.resumeWithException(task.exception ?: IllegalStateException("task failed"))
        }
    }
}
