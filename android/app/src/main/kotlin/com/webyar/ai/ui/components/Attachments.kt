package com.webyar.ai.ui.components

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.media.ExifInterface
import java.io.ByteArrayInputStream
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.drag
import androidx.compose.foundation.gestures.detectTransformGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.webyar.ai.core.media.AttachmentDiskCache
import com.webyar.ai.core.media.AttachmentSource
import com.webyar.ai.core.media.LoaderAttachmentSource
import com.webyar.ai.core.model.MessageAttachment
import com.webyar.ai.core.runCatchingUnlessCancelled
import com.webyar.ai.i18n.StrAndroid
import androidx.compose.ui.platform.LocalDensity
import com.webyar.ai.i18n.Format
import com.webyar.ai.i18n.Language
import com.webyar.ai.i18n.Str
import com.webyar.ai.i18n.StrManual
import com.webyar.ai.ui.A11y
import com.webyar.ai.ui.design.Radius
import com.webyar.ai.ui.design.Space
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * What a message carries besides its words.
 *
 * Port of `ios/WebyarNative/Sources/Features/Chat/Attachments.swift`. Four
 * shapes for four kinds, because a voice note drawn as a file card is a
 * feature the operator cannot use: the bytes are there, the transport is not,
 * and the only way to hear it is to leave the app.
 *
 * Every one of them fetches by hand rather than by URL. The stream endpoint
 * authorizes on the operator's bearer token and neither an image loader nor
 * `MediaPlayer` can carry a header, so the caller hands in an
 * [AttachmentSource] that already knows how — memory, then the scoped disk
 * cache, then the network — and fetches each file once however many views
 * ask.
 *
 * **On demand.** A photo is drawn when its bubble is (it IS the message),
 * except under Data Saver, where it waits for a tap. A voice note, a video
 * and a document are fetched when tapped and never before: a transcript of
 * forty voice notes costs nothing until one is played.
 */
@Composable
fun AttachmentView(
    attachment: MessageAttachment,
    language: Language,
    load: (suspend (String) -> ByteArray?)?,
) {
    val context = androidx.compose.ui.platform.LocalContext.current
    val source = remember(load, context) {
        load?.let {
            LoaderAttachmentSource(it, java.io.File(context.cacheDir, "${AttachmentDiskCache.DIRECTORY}/transient"))
        }
    }
    AttachmentView(attachment = attachment, language = language, source = source)
}

@Composable
fun AttachmentView(
    attachment: MessageAttachment,
    language: Language,
    source: AttachmentSource?,
) {
    if (source == null) {
        FileCard(attachment, language)
        return
    }
    when (attachment.resolvedKind) {
        MessageAttachment.Kind.IMAGE -> ImageAttachment(attachment, language, source)
        MessageAttachment.Kind.AUDIO -> VoiceNote(attachment, language, source)
        // A video has no inline player here on purpose: `media3` is another
        // three megabytes in the APK for a kind the server does not even
        // accept on upload, so a video that arrives from a channel is handed
        // to whatever app on the phone already plays video — streamed to a
        // file first, never held whole in memory.
        MessageAttachment.Kind.VIDEO, MessageAttachment.Kind.FILE ->
            OpenableFile(attachment, language, source)
    }
}

// MARK: - Image

/** A photo at its own proportions, opening full screen on a tap. */
@Composable
private fun ImageAttachment(
    attachment: MessageAttachment,
    language: Language,
    source: AttachmentSource,
) {
    var tapped by remember(attachment.id) { mutableStateOf(false) }
    // Asked once per bubble, not on every recomposition: it is a system call.
    val autoLoad = remember(source) { source.autoLoadImages }
    val bytes = rememberImageBytes(attachment, source, allowNetwork = autoLoad || tapped)
    val density = LocalDensity.current
    // Decoded for the bubble, not for the photo: the box is at most
    // 240x260dp, and a 4000px camera frame decoded whole for it is 64 MB of
    // heap for a thumbnail. The full-screen viewer decodes its own copy.
    val bubbleEdge = with(density) { maxOf(IMAGE_MAX_WIDTH, IMAGE_MAX_HEIGHT).roundToPx() }
    val photo = rememberDecodedImage(attachment.id, (bytes as? AttachmentBytes.Ready)?.value, bubbleEdge, atLeast = true)
    var open by remember(attachment.id) { mutableStateOf(false) }

    when {
        photo != null -> {
            Box(Modifier.padding(vertical = Space.xxs)) {
                Image(
                    bitmap = photo,
                    contentDescription = attachment.displayName ?: Str.photo(language),
                    contentScale = ContentScale.Fit,
                    modifier = Modifier
                        // The box iOS draws a photo in — at most 240dp
                        // across, at most 260dp down, and the picture's own
                        // proportions in between.
                        //
                        // The ratio is stated rather than left to the
                        // painter. Measured on device, a 480x320 photo came
                        // out 420x154 and then 420x84 after a scroll: the
                        // same picture, two heights, because a painter's
                        // intrinsic size is not a layout constraint and the
                        // row collapsed towards its minimum whenever it was
                        // re-measured. `aspectRatio` derives the height from
                        // the width it is given, which is a number the
                        // layout can actually use.
                        .widthIn(max = IMAGE_MAX_WIDTH)
                        .heightIn(max = IMAGE_MAX_HEIGHT)
                        .aspectRatio(photo.width.toFloat() / photo.height.toFloat())
                        // The bubble's own corner: a photo is drawn without
                        // a bubble around it, so it takes the bubble's shape.
                        .clip(RoundedCornerShape(Radius.lgIncreased))
                        .clickable { open = true }
                        .testTag(A11y.attachmentImage(attachment.id)),
                )
            }
            if (open) {
                val full = rememberDecodedImage(
                    "${attachment.id}#full",
                    (bytes as? AttachmentBytes.Ready)?.value,
                    MAX_DECODED_EDGE,
                    atLeast = false,
                )
                ImageViewer(full ?: photo, language) { open = false }
            }
        }
        // Both the failure and the not-yet keep the card, so nothing jumps
        // when the bytes land.
        bytes is AttachmentBytes.Failed ->
            FileCard(attachment, language, Str.attachmentFailed(language))
        bytes is AttachmentBytes.Ready ->
            // Bytes that are not a picture this phone can decode.
            FileCard(attachment, language, Str.attachmentFailed(language))
        bytes is AttachmentBytes.Waiting ->
            // Data Saver: a photo is fetched when asked for, like the rest.
            PhotoPlaceholder(StrAndroid.tapToLoad(language)) { tapped = true }
        // A box roughly the size the photo will be, so the bubble does not
        // jump when the bytes land — iOS draws the same placeholder for the
        // same reason. The transcript re-pins itself either way
        // ([StickToNewest]); this is what keeps it from being visible.
        else -> PhotoPlaceholder(Str.receivingFile(language))
    }
}

/**
 * The bitmap behind an attachment, decoded once and bounded.
 *
 * Bounded because a photo from a modern camera is 4000px on its long edge
 * and roughly 64 MB as ARGB_8888 — several of those in one transcript is an
 * `OutOfMemoryError` on exactly the phones this app promised to run well on.
 * [maxEdge] is what the caller will actually draw it at.
 */
@Composable
private fun rememberDecodedImage(key: String, bytes: ByteArray?, edge: Int, atLeast: Boolean): ImageBitmap? {
    var image by remember(key) { mutableStateOf<ImageBitmap?>(null) }
    LaunchedEffect(key, bytes, edge) {
        if (bytes == null) {
            image = null
            return@LaunchedEffect
        }
        image = withContext(Dispatchers.Default) { decodeBounded(bytes, edge, atLeast) }
    }
    return image
}

/**
 * Decodes with a power-of-two reduction — what `inSampleSize` can do
 * without a second full-size allocation to scale from. A bubble asks for at
 * least its own size (sharp on screen, a fraction of the photo in memory);
 * the viewer asks for at most its ceiling.
 */
internal fun decodeBounded(bytes: ByteArray, edge: Int, atLeast: Boolean = false): ImageBitmap? {
    // Bounds first: this reads the header only and allocates nothing.
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
    val longest = maxOf(bounds.outWidth, bounds.outHeight)
    if (longest <= 0) return null

    val options = BitmapFactory.Options().apply { inSampleSize = sampleSize(longest, edge, atLeast) }
    val decoded = runCatching { BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options) }
        .getOrNull() ?: return null
    return upright(decoded, exifOrientation(bytes)).asImageBitmap()
}

/**
 * The orientation a JPEG's EXIF asks for, or `ORIENTATION_NORMAL` when there
 * is none — a PNG, a WebP, a photo a messenger already re-encoded.
 *
 * `BitmapFactory` ignores the tag, and a phone camera leans on it: Samsung's,
 * among others, saves a portrait shot as landscape pixels with "turn a
 * quarter" written beside them. Browsers, iOS and the console all honour the
 * tag, so without this the photo an operator had just sent from their own
 * gallery lay on its side in their own transcript while the visitor saw it
 * upright. The platform reader has taken a stream since API 24, this app's
 * floor, and a JPEG's tag sits in its header.
 */
private fun exifOrientation(bytes: ByteArray): Int = runCatching {
    ExifInterface(ByteArrayInputStream(bytes))
        .getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)
}.getOrDefault(ExifInterface.ORIENTATION_NORMAL)

/**
 * [bitmap] turned the way [orientation] says, or [bitmap] itself when it is
 * already upright — or when there is no memory for the turned copy, where a
 * sideways photo beats no photo.
 */
private fun upright(bitmap: Bitmap, orientation: Int): Bitmap {
    val matrix = Matrix()
    when (orientation) {
        ExifInterface.ORIENTATION_ROTATE_90 -> matrix.setRotate(90f)
        ExifInterface.ORIENTATION_ROTATE_180 -> matrix.setRotate(180f)
        ExifInterface.ORIENTATION_ROTATE_270 -> matrix.setRotate(-90f)
        ExifInterface.ORIENTATION_FLIP_HORIZONTAL -> matrix.setScale(-1f, 1f)
        ExifInterface.ORIENTATION_FLIP_VERTICAL -> matrix.setScale(1f, -1f)
        // The two mirrored quarter turns — a front camera's.
        ExifInterface.ORIENTATION_TRANSPOSE -> matrix.apply { setRotate(90f); postScale(-1f, 1f) }
        ExifInterface.ORIENTATION_TRANSVERSE -> matrix.apply { setRotate(-90f); postScale(-1f, 1f) }
        else -> return bitmap
    }
    val turned = runCatching {
        Bitmap.createBitmap(bitmap, 0, 0, bitmap.width, bitmap.height, matrix, true)
    }.getOrNull() ?: return bitmap
    if (turned !== bitmap) bitmap.recycle()
    return turned
}

/**
 * The `inSampleSize` for a picture [longest] pixels on its long side.
 * [atLeast]: the largest reduction that still leaves [edge] pixels. Otherwise
 * the smallest that brings it down to [edge] or under.
 */
internal fun sampleSize(longest: Int, edge: Int, atLeast: Boolean): Int {
    val target = edge.coerceAtLeast(1)
    var sample = 1
    if (atLeast) {
        while (longest / (sample * 2) >= target) sample *= 2
    } else {
        while (longest / sample > target) sample *= 2
    }
    return sample
}

/** The footprint a photo will take, while its bytes are on the way — or, under Data Saver, until asked. */
@Composable
private fun PhotoPlaceholder(caption: String, onClick: (() -> Unit)? = null) {
    val tint = LocalContentColor.current
    Box(
        Modifier
            .padding(vertical = Space.xxs)
            .size(width = PHOTO_PLACEHOLDER_WIDTH, height = PHOTO_PLACEHOLDER_HEIGHT)
            .clip(RoundedCornerShape(Radius.lgIncreased))
            .background(MaterialTheme.colorScheme.surfaceContainerHigh)
            .then(if (onClick != null) Modifier.clickable(onClick = onClick) else Modifier),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            caption,
            style = MaterialTheme.typography.labelSmall,
            color = tint.copy(alpha = 0.7f),
        )
    }
}

/** Full screen, pinchable, closed by the button or a double tap. */
@Composable
private fun ImageViewer(photo: ImageBitmap, language: Language, onClose: () -> Unit) {
    Dialog(onDismissRequest = onClose, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        var zoom by remember { mutableFloatStateOf(1f) }
        // Where the enlarged picture has been dragged to. Without it a zoom
        // could only ever show the middle of the photo — the corner of a
        // screenshot or the total at the foot of a receipt, the reason to
        // zoom at all, stayed off screen.
        var pan by remember { mutableStateOf(Offset.Zero) }
        Box(
            Modifier
                .fillMaxSize()
                .background(Color.Black)
                .pointerInput(Unit) {
                    detectTransformGestures { _, move, gestureZoom, _ ->
                        zoom = (zoom * gestureZoom).coerceIn(1f, 6f)
                        // As far as the enlarged picture reaches past the
                        // screen on each side, and no further; none at all
                        // at 1x.
                        val reachX = size.width * (zoom - 1f) / 2f
                        val reachY = size.height * (zoom - 1f) / 2f
                        pan = Offset(
                            (pan.x + move.x).coerceIn(-reachX, reachX),
                            (pan.y + move.y).coerceIn(-reachY, reachY),
                        )
                    }
                }
                .pointerInput(Unit) {
                    detectTapGestures(onDoubleTap = {
                        zoom = if (zoom > 1f) 1f else 2.5f
                        pan = Offset.Zero
                    })
                },
            contentAlignment = Alignment.Center,
        ) {
            Image(
                bitmap = photo,
                contentDescription = null,
                contentScale = ContentScale.Fit,
                modifier = Modifier
                    .fillMaxSize()
                    .graphicsLayer(
                        scaleX = zoom,
                        scaleY = zoom,
                        translationX = pan.x,
                        translationY = pan.y,
                    ),
            )
            IconButton(
                onClick = onClose,
                modifier = Modifier
                    .align(Alignment.TopEnd)
                    .padding(Space.lg)
                    .testTag(A11y.ATTACHMENT_VIEWER_CLOSE),
            ) {
                Icon(
                    Icons.Filled.Close,
                    contentDescription = Str.close(language),
                    tint = Color.White,
                )
            }
        }
    }
}

// MARK: - Voice note

/**
 * A recording, with the transport every phone has taught people to expect.
 *
 * The transport is forced left-to-right. A timeline reads left→right in every
 * locale — play on the left, progress filling rightwards — and the console
 * and iOS both do the same thing for the same reason. The caption *under* it
 * is ordinary prose and is not forced: in Persian it belongs on the right,
 * like every other piece of text in the app.
 */
@Composable
private fun VoiceNote(
    attachment: MessageAttachment,
    language: Language,
    source: AttachmentSource,
) {
    val rtl = LocalLayoutDirection.current == LayoutDirection.Rtl
    val fetch = rememberVoiceFile(attachment, source)
    val file = (fetch.state as? VoiceFile.Ready)?.file
    val slot = rememberVoiceNoteSlot(attachmentId = attachment.id, file = file)
    val player = slot.player
    // The first tap fetched the file; the player that arrives with it starts
    // playing, because that tap was a request to hear it.
    LaunchedEffect(player) {
        if (player != null && fetch.playWhenReady && !player.isPlaying) {
            fetch.playWhenReady = false
            player.toggle()
        }
    }
    val busy = fetch.state is VoiceFile.Fetching
    // The file arrived and opening it has finished without a player: the
    // file is fine, this phone has no codec for it. NOT merely "a file and
    // no player yet" — that is also every note in the moment it is being
    // opened, and it flashed the verdict under each one that scrolled in.
    val undecodable = player == null && slot.isSettledFor(file)

    // Pinned around the row rather than inside it: the direction has to be
    // settled before the layout runs, and `rtl` is read above so the caption
    // can still be put on the side the language wants.
    CompositionLocalProvider(LocalLayoutDirection provides LayoutDirection.Ltr) {
        // Still tappable while the player opens: the tap asks for playback
        // ([VoiceFetch.request]) and the player starts it when it arrives.
        val playable = !busy && !undecodable
        val caption = when {
            player != null -> Format.voiceTime(player.displayedSeconds, language)
            fetch.state is VoiceFile.Failed -> Str.attachmentFailed(language)
            undecodable -> Str.playbackUnsupported(language)
            busy -> Str.receivingFile(language)
            // Not fetched, and not going to be until it is played: what it
            // costs to hear is what there is to say. Also the moment a
            // fetched file is being opened, which ends in its length.
            else -> attachment.sizeBytes?.let { Format.fileSize(it.toLong(), language) }.orEmpty()
        }
        VoiceTransport(
            seed = attachment.id,
            playing = player?.isPlaying == true,
            playable = playable,
            progress = player?.progress ?: 0f,
            caption = caption,
            playLabel = StrManual.play(language),
            pauseLabel = StrManual.pause(language),
            onToggle = { if (player != null) player.toggle() else fetch.request() },
            onSeek = { player?.seekTo(it) },
            playTag = A11y.attachmentVoicePlay(attachment.id),
            // The row is pinned left to right, so which end the caption
            // sits under is decided physically: a Persian caption goes to
            // the right.
            captionAtEnd = rtl,
            modifier = Modifier
                .width(VOICE_NOTE_WIDTH)
                .padding(vertical = Space.xxs)
                .testTag(A11y.attachmentVoiceNote(attachment.id)),
        )
    }
}

/** Where a voice note's file is. */
private sealed interface VoiceFile {
    data object Idle : VoiceFile
    data object Fetching : VoiceFile
    data object Failed : VoiceFile
    class Ready(val file: java.io.File) : VoiceFile
}

private class VoiceFetch {
    var state by mutableStateOf<VoiceFile>(VoiceFile.Idle)
    var requested by mutableIntStateOf(0)
    var playWhenReady = false

    fun request() {
        playWhenReady = true
        requested++
    }
}

/**
 * The file behind a voice note: from disk at once if it was ever played on
 * this phone (so it shows its length without a request), otherwise nothing
 * until [VoiceFetch.request] — the Play tap.
 */
@Composable
private fun rememberVoiceFile(attachment: MessageAttachment, source: AttachmentSource): VoiceFetch {
    val fetch = remember(attachment.id) { VoiceFetch() }
    LaunchedEffect(attachment.id) {
        source.cachedFile(attachment)?.let { fetch.state = VoiceFile.Ready(it) }
    }
    LaunchedEffect(attachment.id, fetch.requested) {
        if (fetch.requested == 0 || fetch.state is VoiceFile.Ready) return@LaunchedEffect
        fetch.state = VoiceFile.Fetching
        // Not `runCatching`: it swallows cancellation too, and a bubble that
        // scrolled away mid-download would come back reading "failed".
        val file = runCatchingUnlessCancelled { source.file(attachment) }.getOrNull()
        fetch.state = if (file != null) VoiceFile.Ready(file) else VoiceFile.Failed
    }
    return fetch
}

// MARK: - File

/**
 * A document: what it is, how big, and — on a tap — what is in it.
 *
 * A card the operator cannot open is half a feature. There is no Quick Look
 * on Android, so the bytes go to a file the system's own viewers can read and
 * the chooser decides which app opens it.
 */
@Composable
private fun OpenableFile(
    attachment: MessageAttachment,
    language: Language,
    source: AttachmentSource,
) {
    val context = androidx.compose.ui.platform.LocalContext.current
    var opening by remember(attachment.id) { mutableStateOf(false) }
    var failed by remember(attachment.id) { mutableStateOf(false) }
    var wanted by remember(attachment.id) { mutableStateOf(false) }

    LaunchedEffect(wanted) {
        if (!wanted) return@LaunchedEffect
        opening = true
        failed = false
        // Disk first; otherwise streamed straight to disk — a video is never
        // held whole in memory on its way to the app that plays it. Not
        // `runCatching`: it swallows cancellation too, so an operator who
        // scrolled away mid-download came back to "could not be opened"
        // about a file nothing had gone wrong with.
        val file = runCatchingUnlessCancelled { source.file(attachment) }.getOrNull()
        // The other app reads it after this returns, and says nothing when
        // it is done: the file is kept out of eviction for a while instead.
        file?.let { source.lease(it, OPEN_LEASE_MS) }
        failed = file == null || !AttachmentFiles.open(context, attachment, file)
        opening = false
        wanted = false
    }

    val subtitle = when {
        failed -> Str.attachmentFailed(language)
        opening -> Str.receivingFile(language)
        else -> attachment.sizeBytes?.let { Format.fileSize(it.toLong(), language) }
    }
    FileCard(attachment, language, subtitle, onClick = { if (!opening) wanted = true })
}

/** The shared shape for anything that is not drawn as media. */
@Composable
private fun FileCard(
    attachment: MessageAttachment,
    language: Language,
    subtitle: String? = attachment.sizeBytes?.let { Format.fileSize(it.toLong(), language) },
    onClick: (() -> Unit)? = null,
) {
    Row(
        Modifier
            .widthIn(max = FILE_CARD_MAX_WIDTH)
            .then(if (onClick != null) Modifier.clickable(onClick = onClick) else Modifier)
            .padding(vertical = Space.xs)
            .testTag(A11y.attachmentFile(attachment.id)),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        val tint = LocalContentColor.current
        Box(
            Modifier
                .size(TRANSPORT_SIZE)
                .clip(CircleShape)
                .background(tint.copy(alpha = 0.14f)),
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                Glyph.Document,
                contentDescription = null,
                tint = tint,
                modifier = Modifier.size(18.dp),
            )
        }
        Column(Modifier.padding(start = Space.md)) {
            Text(
                attachment.displayName ?: Str.file(language),
                style = MaterialTheme.typography.bodyMedium,
                maxLines = 1,
                overflow = TextOverflow.MiddleEllipsis,
            )
            subtitle?.let {
                Text(
                    it,
                    style = MaterialTheme.typography.labelSmall,
                    color = tint.copy(alpha = 0.7f),
                    maxLines = 1,
                )
            }
        }
    }
}

// MARK: - Bytes

/** What a single photo view knows about its bytes. */
private sealed interface AttachmentBytes {
    data object Loading : AttachmentBytes
    /** Not on this phone, and the network may not be used until a tap. */
    data object Waiting : AttachmentBytes
    data object Failed : AttachmentBytes
    class Ready(val value: ByteArray) : AttachmentBytes
}

@Composable
private fun rememberImageBytes(
    attachment: MessageAttachment,
    source: AttachmentSource,
    allowNetwork: Boolean,
): AttachmentBytes {
    var state by remember(attachment.id) { mutableStateOf<AttachmentBytes>(AttachmentBytes.Loading) }
    LaunchedEffect(attachment.id, allowNetwork) {
        if (state is AttachmentBytes.Ready) return@LaunchedEffect
        if (!allowNetwork) {
            val local = runCatchingUnlessCancelled { source.cachedBytes(attachment) }.getOrNull()
            state = if (local != null) AttachmentBytes.Ready(local) else AttachmentBytes.Waiting
            return@LaunchedEffect
        }
        state = AttachmentBytes.Loading
        val bytes = runCatchingUnlessCancelled { source.bytes(attachment) }.getOrNull()
        state = if (bytes == null) AttachmentBytes.Failed else AttachmentBytes.Ready(bytes)
    }
    return state
}

// MARK: - Layout constants

/**
 * The same widths iOS uses, so a thread looks the same on both phones: 236pt
 * for a voice note and a file card, 220pt for a photo — a little wider here
 * because an Android bubble has no beak inset eating the edge.
 */
private val VOICE_NOTE_WIDTH = 236.dp
private val FILE_CARD_MAX_WIDTH = 236.dp
private val IMAGE_MAX_WIDTH = 240.dp

/** iOS's 260pt cap, so a portrait shot is a photo and not a wall. */
private val IMAGE_MAX_HEIGHT = 260.dp

/** iOS's 180x132 placeholder, for the same reason it has one. */
private val PHOTO_PLACEHOLDER_WIDTH = 180.dp
private val PHOTO_PLACEHOLDER_HEIGHT = 132.dp

/** The longest edge the full-screen viewer decodes a photo to. */
private const val MAX_DECODED_EDGE = 2048

/** How long a file handed to another app is kept out of eviction. */
private const val OPEN_LEASE_MS = 10 * 60 * 1000L

/** The play/pause circle, and the badge on a file card. Both 32pt on iOS. */
private val TRANSPORT_SIZE = 32.dp
