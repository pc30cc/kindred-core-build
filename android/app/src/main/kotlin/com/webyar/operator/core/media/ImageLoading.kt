package com.webyar.operator.core.media

import android.content.Context
import coil3.ImageLoader
import coil3.PlatformContext
import coil3.SingletonImageLoader
import coil3.disk.DiskCache
import coil3.memory.MemoryCache
import okio.Path.Companion.toPath
import java.io.File

/**
 * The one image loader, configured for this app rather than left at Coil's
 * defaults.
 *
 * What Coil loads here is small and public: avatars and workspace logos,
 * served from the platform's CDN by derived, stable URLs
 * (`server/services/storage/urlResolver.ts` — built from the storage key,
 * not signed, so the URL itself is a good cache key and no custom key is
 * needed). Attachments never come through Coil: their endpoint needs the
 * operator's token, and they have their own memory and disk caches.
 *
 *  - **Memory: 15% of the app's heap**, not Coil's 25%. The attachment cache
 *    already holds 24 MB of the same heap, and a 2 GB phone on API 24 is
 *    the floor this app promised to run on.
 *  - **Disk: 64 MB** in `cacheDir/image_cache`. Faces and logos are a few
 *    KB each; Coil's default (2% of the disk, up to 250 MB) is sized for a
 *    photo app.
 *  - **Sized requests.** Nothing here sets a size, and that is the point:
 *    Coil's Compose images resolve the request size from the layout's
 *    constraints, so a 2000px upload drawn in a 40dp avatar is decoded at
 *    40dp, not at 2000px.
 *  - **HTTP**: Coil's disk cache stores what it fetched and serves it
 *    without revalidating. For these URLs that is right — a changed avatar
 *    is a new key, therefore a new URL.
 */
object ImageLoading {

    private const val DISK_BYTES = 64L * 1024 * 1024
    private const val MEMORY_PERCENT = 0.15
    const val DIRECTORY = "image_cache"

    fun create(context: PlatformContext): ImageLoader =
        ImageLoader.Builder(context)
            .memoryCache {
                MemoryCache.Builder()
                    .maxSizePercent(context, MEMORY_PERCENT)
                    .build()
            }
            .diskCache {
                DiskCache.Builder()
                    .directory(File(context.cacheDir, DIRECTORY).absolutePath.toPath())
                    .maxSizeBytes(DISK_BYTES)
                    .build()
            }
            .build()

    /** What the Storage screen shows for pictures. */
    fun diskBytes(context: Context): Long =
        runCatching { SingletonImageLoader.get(context).diskCache?.size ?: 0L }.getOrDefault(0L)

    /** Clear Cache and sign-out. Nothing here is the operator's data, but none of it needs to outlive them. */
    fun clear(context: Context) {
        runCatching {
            val loader = SingletonImageLoader.get(context)
            loader.memoryCache?.clear()
            loader.diskCache?.clear()
        }
    }
}
