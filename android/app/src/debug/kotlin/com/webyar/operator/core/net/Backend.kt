package com.webyar.operator.core.net

import android.content.Context
import com.webyar.operator.core.storage.SecureStore

/**
 * Chooses the backend for this launch. **Debug build.**
 *
 * The app talks to the real server. The in-memory sample backend exists only
 * to lay out and screenshot screens that otherwise need a live account, and to
 * let the UI tests run with no account, no network and no credentials — and it
 * is fenced off twice over.
 *
 * It is compiled only into Debug, because both it and this file live in
 * `src/debug`: a release build has a different [Backend] (in `src/release`)
 * that cannot name `SampleApi` because `SampleApi` is not on its classpath.
 * That is stronger than the `#if DEBUG` the Swift original uses — there is no
 * flag to set wrongly.
 *
 * And even in Debug it requires an explicit launch argument. There is no
 * setting, no gesture and no server response that can reach it.
 */
object Backend {
    /**
     * Set by the instrumentation runner or `adb shell am instrument -e`, which
     * is how an Android test says what `-WebyarSampleData` says on iOS.
     */
    private const val SAMPLE_FLAG = "webyar.sample"

    val isSample: Boolean by lazy {
        System.getProperty(SAMPLE_FLAG) == "true" || System.getenv("WEBYAR_SAMPLE") == "1"
    }

    fun create(context: Context): WebyarApi =
        if (isSample) SampleApi() else ApiClient(SecureStore(context.applicationContext))
}
