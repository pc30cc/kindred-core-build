package com.webyar.operator.core.push

import android.content.Context
import com.google.android.gms.tasks.Task
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.webyar.operator.BuildConfig
import com.webyar.operator.core.Diag
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/**
 * Firebase, configured from the build rather than from a committed file.
 *
 * The usual route is `google-services.json` plus the Google Services Gradle
 * plugin, which bakes the project's identifiers into resources. Here the four
 * values arrive as build properties (`WEBYAR_FIREBASE_*`, see
 * `app/build.gradle.kts`) the same way the signing key does — so no project's
 * identifiers live in the repository, every fork and every CI run without
 * them builds an app that simply has no push, and a release pipeline that
 * has them builds one that does. None of the four is a secret in the
 * credential sense (all four ship inside every APK); keeping them out of the
 * repository is about which Firebase project a build registers devices
 * against, not about hiding them.
 *
 * The server's FCM credentials (a service account) are a different matter
 * and never touch this app: `server/services/push/fcm.ts`.
 */
object PushConfig {

    val isConfigured: Boolean
        get() = BuildConfig.FIREBASE_APP_ID.isNotBlank() &&
            BuildConfig.FIREBASE_API_KEY.isNotBlank() &&
            BuildConfig.FIREBASE_PROJECT_ID.isNotBlank() &&
            BuildConfig.FIREBASE_SENDER_ID.isNotBlank()

    /**
     * Starts the default Firebase app, once. False — and push stays off for
     * this build — when the build carries no configuration. Cheap: no
     * network, no token; the token is asked for only once somebody signs in.
     */
    fun initialize(context: Context, diag: Diag = Diag.Android): Boolean {
        if (!isConfigured) return false
        return runCatching {
            if (FirebaseApp.getApps(context).isEmpty()) {
                FirebaseApp.initializeApp(
                    context,
                    FirebaseOptions.Builder()
                        .setApplicationId(BuildConfig.FIREBASE_APP_ID)
                        .setApiKey(BuildConfig.FIREBASE_API_KEY)
                        .setProjectId(BuildConfig.FIREBASE_PROJECT_ID)
                        .setGcmSenderId(BuildConfig.FIREBASE_SENDER_ID)
                        .build(),
                )
            }
            true
        }.getOrElse {
            diag.warn("Push", "Firebase could not start: ${it.javaClass.simpleName}")
            false
        }
    }
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
