package com.webyar.operator

import android.app.Application
import coil3.ImageLoader
import coil3.PlatformContext
import coil3.SingletonImageLoader
import androidx.work.Configuration
import com.webyar.operator.core.media.ImageLoading
import com.webyar.operator.core.push.Notifications
import com.webyar.operator.core.push.PushConfig
import com.webyar.operator.i18n.Language

/**
 * The process.
 *
 * [onCreate] does only what must exist before anything else can run — the
 * Firebase app a push is delivered through, and the notification channel a
 * background push is drawn in — and nothing that costs a cold start: the
 * graph (database, network, sync) is built the first time something asks.
 *
 * It is also where two libraries are configured rather than left at their
 * defaults: Coil gets [ImageLoading]'s loader, and WorkManager is started on
 * demand from [workManagerConfiguration] instead of by its content provider
 * at every launch (see the manifest).
 */
class WebyarApp : Application(), SingletonImageLoader.Factory, Configuration.Provider {

    val graph: AppGraph by lazy { AppGraph(this) }

    override fun onCreate() {
        super.onCreate()
        PushConfig.initialize(this)
        // Exists before the first push can arrive, in English until the
        // operator's language is read and it is renamed.
        Notifications.ensureChannels(this, Language.DEFAULT, rename = false)
    }

    override fun newImageLoader(context: PlatformContext): ImageLoader = ImageLoading.create(context)

    override val workManagerConfiguration: Configuration
        get() = Configuration.Builder()
            .setMinimumLoggingLevel(android.util.Log.WARN)
            .build()
}
