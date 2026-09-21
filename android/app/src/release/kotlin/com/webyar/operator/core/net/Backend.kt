package com.webyar.operator.core.net

import android.content.Context
import com.webyar.operator.core.storage.SecureStore

/**
 * Chooses the backend for this launch. **Release build.**
 *
 * There is no choice to make. `SampleApi` lives in `src/debug` and is not on
 * this build's classpath at all, so a shipped app cannot reach it however
 * hard anything tries — no flag, no setting, no server response.
 *
 * Keeping the two files in step is the price of that guarantee: a method added
 * to the debug [Backend] has to be added here too, and the build says so
 * immediately rather than at runtime.
 */
object Backend {
    const val isSample: Boolean = false

    fun create(context: Context): WebyarApi =
        ApiClient(SecureStore(context.applicationContext))
}
