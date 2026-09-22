package com.webyar.operator.ui.components

import android.graphics.BitmapFactory
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.drag
import androidx.compose.foundation.gestures.detectTransformGestures
import androidx.compose.foundation.layout.Arrangement
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
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
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
import com.webyar.operator.core.model.MessageAttachment
import com.webyar.operator.i18n.Format
import com.webyar.operator.i18n.Language
import com.webyar.operator.i18n.Str
import com.webyar.operator.ui.A11y
import com.webyar.operator.ui.design.Space
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
 * `MediaPlayer` can carry a header, so the caller hands in a [load] that
 * already knows how — and [AttachmentBytes] makes sure it runs once per file
 * however many views ask.
 */
@Composable
fun AttachmentView(
    attachment: MessageAttachment,
    language: Language,
    load: (suspend (String) -> ByteArray?)?,
) {
    if (load == null) {
        FileCard(attachment, language)
        return
    }
    when (attachment.resolvedKind) {
        MessageAttachment.Kind.IMAGE -> ImageAttachment(attachment, language, load)
        MessageAttachment.Kind.AUDIO -> VoiceNote(attachment, language, load)
        // A video has no inline player here on purpose: `media3` is another
        // three megabytes in the APK for a kind the server does not even
        // accept on upload, so a video that arrives from a channel is handed
        // to whatever app on the phone already plays video.
        MessageAttachment.Kind.VIDEO, MessageAttachment.Kind.FILE ->
            OpenableFile(attachment, language, load)
    }
}

// MARK: - Image

/** A photo at its own proportions, opening full screen on a tap. */
@Composable
private fun ImageAttachment(
    attachment: MessageAttachment,
    language: Language,
    load: suspend (String) -> ByteArray?,
) {
    val bytes = rememberAttachmentBytes(attachment.id, load)
    val photo = rememberDecodedImage(attachment.id, (bytes as? AttachmentBytes.Ready)?.value)
    var open by remember(attachment.id) { mutableStateOf(false) }

    when {
        photo != null -> {
            Image(
                bitmap = photo,
                contentDescription = attachment.displayName ?: Str.photo(language),
                contentScale = ContentScale.Fit,
                modifier = Modifier
                    // The box iOS draws a photo in. `heightIn` is what keeps
                    // a portrait shot from filling the screen, and the
                    // aspect ratio comes from the bitmap itself — which is
                    // why the bytes are decoded here rather than handed to
                    // an async loader that has no size until it has finished.
                    .widthIn(max = IMAGE_MAX_WIDTH)
                    .heightIn(max = IMAGE_MAX_HEIGHT)
                    .padding(vertical = Space.xxs)
                    .clip(RoundedCornerShape(Space.md))
                    .clickable { open = true }
                    .testTag(A11y.attachmentImage(attachment.id)),
            )
            if (open) ImageViewer(photo, language) { open = false }
        }
        // Both the failure and the not-yet keep the card, so nothing jumps
        // when the bytes land.
        bytes is AttachmentBytes.Failed ->
            FileCard(attachment, language, Str.attachmentFailed(language))
        bytes is AttachmentBytes.Ready ->
            // Bytes that are not a picture this phone can decode.
            FileCard(attachment, language, Str.attachmentFailed(language))
        else -> FileCard(attachment, language, Str.receivingFile(language))
    }
}

/**
 * The bitmap behind an attachment, decoded once and bounded.
 *
 * Bounded because a photo from a modern camera is 4000px on its long edge
 * and roughly 64 MB as ARGB_8888 — several of those in one transcript is an
 * `OutOfMemoryError` on exactly the phones this app promised to run well on.
 * [MAX_DECODED_EDGE] is generous enough for the full-screen viewer on a
 * high-density display and small enough that a thread of photos fits.
 */
@Composable
private fun rememberDecodedImage(id: String, bytes: ByteArray?): ImageBitmap? {
    var image by remember(id) { mutableStateOf<ImageBitmap?>(null) }
    LaunchedEffect(id, bytes) {
        if (bytes == null) {
            image = null
            return@LaunchedEffect
        }
        image = withContext(Dispatchers.Default) { decodeBounded(bytes) }
    }
    return image
}

private fun decodeBounded(bytes: ByteArray): ImageBitmap? {
    // Bounds first: this reads the header only and allocates nothing.
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
    val longest = maxOf(bounds.outWidth, bounds.outHeight)
    if (longest <= 0) return null

    var sample = 1
    while (longest / sample > MAX_DECODED_EDGE) sample *= 2

    val options = BitmapFactory.Options().apply { inSampleSize = sample }
    return runCatching { BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options) }
        .getOrNull()?.asImageBitmap()
}

/** Full screen, pinchable, closed by the button or a double tap. */
@Composable
private fun ImageViewer(photo: ImageBitmap, language: Language, onClose: () -> Unit) {
    Dialog(onDismissRequest = onClose, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        var zoom by remember { mutableFloatStateOf(1f) }
        Box(
            Modifier
                .fillMaxSize()
                .background(Color.Black)
                .pointerInput(Unit) {
                    detectTransformGestures { _, _, gestureZoom, _ ->
                        zoom = (zoom * gestureZoom).coerceIn(1f, 6f)
                    }
                }
                .pointerInput(Unit) {
                    detectTapGestures(onDoubleTap = { zoom = if (zoom > 1f) 1f else 2.5f })
                },
            contentAlignment = Alignment.Center,
        ) {
            Image(
                bitmap = photo,
                contentDescription = null,
                contentScale = ContentScale.Fit,
                modifier = Modifier
                    .fillMaxSize()
                    .graphicsLayer(scaleX = zoom, scaleY = zoom),
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
    load: suspend (String) -> ByteArray?,
) {
    val rtl = LocalLayoutDirection.current == LayoutDirection.Rtl
    val bytes = rememberAttachmentBytes(attachment.id, load)
    val player = rememberVoiceNotePlayer(
        attachmentId = attachment.id,
        fileName = attachment.fileName,
        mimeType = attachment.mimeType,
        bytes = (bytes as? AttachmentBytes.Ready)?.value,
    )
    val tint = LocalContentColor.current

    // Pinned around the row rather than inside it: the direction has to be
    // settled before the layout runs, and `rtl` is read above so the caption
    // can still be put on the side the language wants.
    CompositionLocalProvider(LocalLayoutDirection provides LayoutDirection.Ltr) {
        Row(
            Modifier
                .width(VOICE_NOTE_WIDTH)
                .padding(vertical = Space.xxs)
                .testTag(A11y.attachmentVoiceNote(attachment.id)),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(Space.md),
        ) {
            if (player != null) {
                Box(
                    Modifier
                        .size(TRANSPORT_SIZE)
                        .clip(CircleShape)
                        .background(tint.copy(alpha = 0.14f))
                        .clickable(onClick = player::toggle)
                        .semantics {
                            contentDescription =
                                if (player.isPlaying) Str.pause(language) else Str.play(language)
                        }
                        .testTag(A11y.attachmentVoicePlay(attachment.id)),
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(
                        if (player.isPlaying) Glyph.Pause else Icons.Filled.PlayArrow,
                        contentDescription = null,
                        tint = tint,
                        modifier = Modifier.size(18.dp),
                    )
                }
            } else {
                // Not a disabled play button: nothing has been offered yet,
                // and a control that looks pressable and is not is worse
                // than one that plainly is not there.
                Box(
                    Modifier
                        .size(TRANSPORT_SIZE)
                        .clip(CircleShape)
                        .background(tint.copy(alpha = 0.08f)),
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(
                        Glyph.Mic,
                        contentDescription = null,
                        tint = tint.copy(alpha = 0.5f),
                        modifier = Modifier.size(18.dp),
                    )
                }
            }

            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(5.dp)) {
                VoiceTrack(
                    progress = player?.progress ?: 0f,
                    tint = tint,
                    onSeek = { player?.seekTo(it) },
                )
                val caption = when {
                    player != null -> Format.voiceTime(player.displayedSeconds, language)
                    bytes is AttachmentBytes.Failed -> Str.attachmentFailed(language)
                    // The bytes arrived and still would not decode: the file
                    // is fine, this phone has no codec for it.
                    bytes is AttachmentBytes.Ready -> Str.playbackUnsupported(language)
                    else -> Str.receivingFile(language)
                }
                Text(
                    caption,
                    style = MaterialTheme.typography.labelSmall,
                    color = tint.copy(alpha = 0.7f),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    // Which end of the bar this sits under is decided
                    // physically, not by an alignment constant: the row is
                    // pinned left-to-right, so `Start` means "left" here
                    // whatever the language, and a Persian caption has to be
                    // told to go to the other end.
                    textAlign = if (rtl) TextAlign.End else TextAlign.Start,
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        }
    }
}

/** The bar: a track, a fill, and a drag that scrubs. */
@Composable
private fun VoiceTrack(progress: Float, tint: Color, onSeek: (Float) -> Unit) {
    Box(
        Modifier
            .fillMaxWidth()
            .height(4.dp)
            .clip(CircleShape)
            .background(tint.copy(alpha = 0.18f))
            // One gesture for both, because a press and a drag on a scrubber
            // are the same intent: the press jumps, the drag follows. Two
            // separate detectors would race for the pointer and the bar would
            // sometimes ignore a tap.
            .pointerInput(Unit) {
                awaitEachGesture {
                    val down = awaitFirstDown(requireUnconsumed = false)
                    if (size.width > 0) onSeek(down.position.x / size.width)
                    drag(down.id) { change ->
                        if (size.width > 0) onSeek(change.position.x / size.width)
                        change.consume()
                    }
                }
            },
    ) {
        Box(
            Modifier
                .fillMaxWidth(progress.coerceIn(0f, 1f))
                .height(4.dp)
                .clip(CircleShape)
                .background(tint.copy(alpha = 0.85f)),
        )
    }
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
    load: suspend (String) -> ByteArray?,
) {
    val context = androidx.compose.ui.platform.LocalContext.current
    var opening by remember(attachment.id) { mutableStateOf(false) }
    var failed by remember(attachment.id) { mutableStateOf(false) }
    var wanted by remember(attachment.id) { mutableStateOf(false) }

    LaunchedEffect(wanted) {
        if (!wanted) return@LaunchedEffect
        opening = true
        failed = false
        val bytes = runCatching { AttachmentCache.bytes(attachment.id, load) }.getOrNull()
        val file = bytes?.let {
            withContext(Dispatchers.IO) { AttachmentFiles.cache(context, attachment, it) }
        }
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

/** What a single attachment view knows about its bytes. */
private sealed interface AttachmentBytes {
    data object Loading : AttachmentBytes
    data object Failed : AttachmentBytes
    class Ready(val value: ByteArray) : AttachmentBytes
}

@Composable
private fun rememberAttachmentBytes(
    id: String,
    load: suspend (String) -> ByteArray?,
): AttachmentBytes {
    var state by remember(id) { mutableStateOf<AttachmentBytes>(AttachmentBytes.Loading) }
    LaunchedEffect(id) {
        val bytes = runCatching { AttachmentCache.bytes(id, load) }.getOrNull()
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

/** The longest edge a transcript photo is decoded to. */
private const val MAX_DECODED_EDGE = 2048

/** The play/pause circle, and the badge on a file card. Both 32pt on iOS. */
private val TRANSPORT_SIZE = 32.dp
