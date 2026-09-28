package com.webyar.ai.feature.settings

import android.content.ContentResolver
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.net.Uri
import android.media.ExifInterface
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.ByteArrayOutputStream

/** A picture ready to upload as the operator's avatar. */
class AvatarUpload(val bytes: ByteArray, val contentType: String)

/**
 * Turns a photo from the picker into an avatar: read, turned upright, shrunk
 * to [MAX_SIDE] and written as a JPEG — off the main thread.
 *
 * A phone camera's photo is a 4–12 MB HEIC or JPEG. The server refuses HEIC,
 * and sending twelve megabytes to show a 40-pixel circle is a minute on a
 * phone connection; read on the main thread it also froze the screen while
 * it decoded.
 */
object AvatarPhoto {
    const val MAX_SIDE = 512

    suspend fun prepare(resolver: ContentResolver, uri: Uri): AvatarUpload? = withContext(Dispatchers.IO) {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        resolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, bounds) } ?: return@withContext null
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return@withContext null

        var sample = 1
        while (maxOf(bounds.outWidth, bounds.outHeight) / (sample * 2) >= MAX_SIDE) sample *= 2
        val decoded = resolver.openInputStream(uri)?.use {
            BitmapFactory.decodeStream(it, null, BitmapFactory.Options().apply { inSampleSize = sample })
        } ?: return@withContext null

        val rotation = runCatching {
            val orientation = resolver.openInputStream(uri)?.use {
                ExifInterface(it).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)
            }
            when (orientation) {
                ExifInterface.ORIENTATION_ROTATE_90 -> 90
                ExifInterface.ORIENTATION_ROTATE_180 -> 180
                ExifInterface.ORIENTATION_ROTATE_270 -> 270
                else -> 0
            }
        }.getOrDefault(0)

        val scale = MAX_SIDE.toFloat() / maxOf(decoded.width, decoded.height)
        val matrix = Matrix().apply {
            if (scale < 1f) postScale(scale, scale)
            if (rotation != 0) postRotate(rotation.toFloat())
        }
        val upright = if (matrix.isIdentity) decoded
        else Bitmap.createBitmap(decoded, 0, 0, decoded.width, decoded.height, matrix, true)

        val out = ByteArrayOutputStream()
        upright.compress(Bitmap.CompressFormat.JPEG, 88, out)
        if (upright !== decoded) upright.recycle()
        decoded.recycle()
        AvatarUpload(out.toByteArray(), "image/jpeg")
    }
}
