package com.platform.app.core.push

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapShader
import android.graphics.Canvas
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.Shader
import androidx.compose.ui.graphics.asAndroidPath
import androidx.compose.ui.graphics.vector.PathParser
import androidx.core.graphics.createBitmap
import coil3.SingletonImageLoader
import coil3.request.ImageRequest
import coil3.request.SuccessResult
import coil3.request.allowHardware
import coil3.toBitmap
import com.platform.app.core.runCatchingUnlessCancelled
import com.platform.app.ui.components.AvatarGlyphPaths
import kotlinx.coroutines.withTimeoutOrNull

/**
 * A colleague's face for the notifications of a call: their photo in a
 * circle, or — without one, or with one that will not load in time — the
 * platform's person silhouette on a quiet circle.
 *
 * Never left to the system. A `Person` with no icon is drawn by Android's call
 * notification as a letter on a coloured disc (`CallLayout`'s avatar symbol),
 * and a teammate is never a letter (owner, 2026-10-24): the silhouette is
 * the same [AvatarGlyphPaths.PERSON] every avatar in the app falls back to.
 */
internal object CallerFace {

    /**
     * The photo, fetched through the app's own image loader — its memory and
     * disk caches first, where a colleague's face usually already is — within
     * [timeoutMillis]: a ring is a moment, and it does not wait for a slow
     * network to show a picture. Null when there is none to have.
     */
    suspend fun photo(context: Context, url: String?, timeoutMillis: Long = PHOTO_TIMEOUT_MS): Bitmap? {
        if (url == null) return null
        return withTimeoutOrNull(timeoutMillis) {
            runCatchingUnlessCancelled {
                val request = ImageRequest.Builder(context)
                    .data(url)
                    .size(FACE_PX)
                    // A notification is drawn by another process, which a
                    // hardware bitmap cannot be handed to.
                    .allowHardware(false)
                    .build()
                (SingletonImageLoader.get(context).execute(request) as? SuccessResult)?.image?.toBitmap()
            }.getOrNull()
        }
    }

    /** The face itself: [photo] cropped to a circle, or the silhouette. */
    fun face(photo: Bitmap?): Bitmap {
        val face = createBitmap(FACE_PX, FACE_PX)
        val canvas = Canvas(face)
        val radius = FACE_PX / 2f
        if (photo != null && photo.width > 0 && photo.height > 0) {
            // Centre-cropped, as the avatars in the app are.
            val scale = maxOf(FACE_PX.toFloat() / photo.width, FACE_PX.toFloat() / photo.height)
            val matrix = Matrix().apply {
                setScale(scale, scale)
                postTranslate((FACE_PX - photo.width * scale) / 2f, (FACE_PX - photo.height * scale) / 2f)
            }
            val paint = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG).apply {
                shader = BitmapShader(photo, Shader.TileMode.CLAMP, Shader.TileMode.CLAMP).apply { setLocalMatrix(matrix) }
            }
            canvas.drawCircle(radius, radius, radius, paint)
            return face
        }
        canvas.drawCircle(radius, radius, radius, Paint(Paint.ANTI_ALIAS_FLAG).apply { color = QUIET_FILL })
        // The glyph's 24-unit box at the share of the circle every avatar
        // gives it (`personBox`), centred.
        val box = FACE_PX * PERSON_BOX
        val glyph = PathParser().parsePathString(AvatarGlyphPaths.PERSON).toPath().asAndroidPath()
        glyph.transform(
            Matrix().apply {
                setScale(box / GRID, box / GRID)
                postTranslate((FACE_PX - box) / 2f, (FACE_PX - box) / 2f)
            },
        )
        canvas.drawPath(glyph, Paint(Paint.ANTI_ALIAS_FLAG).apply { color = QUIET_GLYPH })
        return face
    }

    /** Large enough for the full-screen ring, small enough to travel to the system in a notification. */
    private const val FACE_PX = 192

    private const val PHOTO_TIMEOUT_MS = 2_000L

    /** The glyphs' grid ([AvatarGlyphPaths]). */
    private const val GRID = 24f

    /** `personBox` for an avatar larger than a chip. */
    private const val PERSON_BOX = 0.62f

    /**
     * The quiet circle's two greys, fixed: the system draws a call's
     * notification in its own light or dark, which this cannot read, and a
     * mid grey under a lighter figure reads on both.
     */
    private const val QUIET_FILL = 0xFF8E939C.toInt()
    private const val QUIET_GLYPH = 0xFFE8EAEE.toInt()
}
