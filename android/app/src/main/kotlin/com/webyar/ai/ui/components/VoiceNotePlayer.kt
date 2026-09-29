package com.webyar.ai.ui.components

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.MediaPlayer
import android.os.Build
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableDoubleStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import androidx.core.content.ContextCompat
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import java.io.File

/**
 * Owns one [MediaPlayer] and the tick that moves the progress bar.
 *
 * Port of iOS's `AudioNotePlayer`. The shape is the same on purpose: a play
 * flag, an elapsed time, a derived progress, and a number under the bar that
 * counts up while playing and shows the length while stopped — which is what
 * every voice note anyone has used does.
 *
 * `MediaPlayer` reads from a file, not from memory, so the bytes are written
 * to the cache directory first. The one source it must never be given is the
 * server's URL: that request would arrive without the operator's token.
 */
class VoiceNotePlayer private constructor(
    private val player: MediaPlayer,
    private val audio: AudioManager?,
) {
    var isPlaying by mutableStateOf(false)
        private set

    // A primitive state rather than a boxed one: this is written twelve
    // times a second while a note plays, and each write to a `mutableStateOf`
    // allocates a `java.lang.Double`.
    var elapsedSeconds by mutableDoubleStateOf(0.0)
        private set

    private var focus: AudioFocusRequest? = null

    /**
     * Set once the codec has gone back. Every call into a released
     * `MediaPlayer` — `isPlaying`, `currentPosition`, `duration` — throws
     * `IllegalStateException`, and a tap or a tick can still arrive in the
     * frame between `onDispose` releasing this and the recomposition that
     * drops the last reference to it. Those calls are made into no-ops here
     * rather than trusted never to happen.
     */
    private var released = false

    /**
     * Read once, while the player is known to be prepared: [of] refuses a
     * file with no length, and the length of a file does not change. Asked
     * of the `MediaPlayer` on every read, it was a native call twelve times a
     * second — and one that throws once the player has been released.
     */
    val durationSeconds: Double = player.duration.takeIf { it > 0 }?.let { it / 1000.0 } ?: 0.0

    /**
     * The number under the bar: how far in while playing, how long in total
     * while stopped.
     */
    val displayedSeconds: Double
        get() = if (isPlaying || elapsedSeconds > 0) elapsedSeconds else durationSeconds

    val progress: Float
        get() = if (durationSeconds > 0) (elapsedSeconds / durationSeconds).toFloat() else 0f

    fun toggle() {
        if (released) return
        if (player.isPlaying) {
            pause()
            return
        }
        // Replaying after it finished starts from the top, not from the end.
        if (player.currentPosition >= player.duration - 50) {
            player.seekTo(0)
            elapsedSeconds = 0.0
        }
        // One voice at a time. Two notes talking over each other — a second
        // tapped while the first still plays, or a thread's note under the
        // recording being reviewed in the composer — is noise nobody can
        // follow; the one already playing stops where it is, as it does in
        // every messenger.
        current?.takeIf { it !== this }?.pause()
        requestFocus()
        runCatching { player.start() }.onFailure {
            abandonFocus()
            return
        }
        isPlaying = true
        current = this
    }

    /** Stops where it is, keeping the place — the Pause button, or another note starting. */
    private fun pause() {
        if (released) return
        runCatching { if (player.isPlaying) player.pause() }
        isPlaying = false
        abandonFocus()
        if (current === this) current = null
    }

    fun seekTo(ratio: Float) {
        if (released) return
        val clamped = ratio.coerceIn(0f, 1f)
        val target = (clamped * player.duration).toInt()
        runCatching { player.seekTo(target) }
        elapsedSeconds = target / 1000.0
    }

    /** Called from the composition's tick while playing. */
    internal fun sample() {
        if (released) return
        elapsedSeconds = player.currentPosition / 1000.0
        if (!player.isPlaying) {
            isPlaying = false
            abandonFocus()
            if (current === this) current = null
            // Finished rather than paused: park the bar at the end so it does
            // not look like it stopped halfway.
            if (player.currentPosition >= player.duration - 50) {
                elapsedSeconds = durationSeconds
            }
        }
    }

    fun release() {
        if (released) return
        released = true
        runCatching { player.stop() }
        player.release()
        isPlaying = false
        abandonFocus()
        if (current === this) current = null
    }

    /**
     * Asks for the speaker rather than taking it.
     *
     * A voice note that plays over a call, or that leaves music playing
     * underneath it, is the kind of thing an operator notices once and never
     * forgives. `AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK` is the same intent as
     * iOS's `.duckOthers`.
     */
    private fun requestFocus() {
        val manager = audio ?: return
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val request = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK)
                .setAudioAttributes(SPEECH)
                .build()
            focus = request
            manager.requestAudioFocus(request)
        } else {
            @Suppress("DEPRECATION")
            manager.requestAudioFocus(
                null,
                AudioManager.STREAM_MUSIC,
                AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK,
            )
        }
    }

    private fun abandonFocus() {
        val manager = audio ?: return
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            focus?.let { manager.abandonAudioFocusRequest(it) }
            focus = null
        } else {
            @Suppress("DEPRECATION")
            manager.abandonAudioFocus(null)
        }
    }

    companion object {
        /**
         * `SPEECH` rather than `MUSIC`: it tells the system this is a voice,
         * which is what routes it to the earpiece on a phone held to the ear
         * and what keeps it out of the way of a ringtone.
         */
        private val SPEECH: AudioAttributes = AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_MEDIA)
            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
            .build()

        /**
         * The note that is playing, if one is — so the next one to start can
         * stop it. Touched only from the main thread: every caller is a tap
         * or the composition's tick.
         */
        private var current: VoiceNotePlayer? = null

        /**
         * Null when this phone has no decoder for the format — an Opus note
         * from Telegram on an older Android, say. The file is not broken and
         * the operator is told which of the two it is.
         */
        fun of(context: Context, file: File): VoiceNotePlayer? {
            val player = MediaPlayer()
            return runCatching {
                player.setAudioAttributes(SPEECH)
                player.setDataSource(file.absolutePath)
                player.prepare()
                // A file that decodes but reports no length is a file that
                // cannot be scrubbed, and a transport with no timeline is
                // worse than saying so.
                check(player.duration > 0)
                VoiceNotePlayer(player, ContextCompat.getSystemService(context, AudioManager::class.java))
            }.getOrElse {
                player.release()
                null
            }
        }
    }
}

/**
 * A player for this file, alive exactly as long as the bubble is.
 *
 * Null until there is a file — which for a voice note nobody has played yet
 * is never, because the file is fetched only when Play is tapped — and null
 * for good if nothing on this phone can decode it. A caller that has to tell
 * "still opening" from "cannot be played" asks [rememberVoiceNoteSlot].
 */
@Composable
internal fun rememberVoiceNotePlayer(
    attachmentId: String,
    file: File?,
): VoiceNotePlayer? = rememberVoiceNoteSlot(attachmentId, file).player

/**
 * The player for a file, and whether opening that file has finished.
 *
 * Opening is not instant — `MediaPlayer.prepare` reads the file's header on
 * the IO pool — and until it finishes there is no player and no verdict.
 * Reading the missing player as the verdict flashed "this phone cannot play
 * it" under every note that had been played before, each time its bubble
 * came into view, for as long as the prepare took.
 */
@Stable
internal class VoiceNoteSlot {
    var player by mutableStateOf<VoiceNotePlayer?>(null)
        internal set

    /** The file the last finished attempt was for, whatever it produced. */
    internal var openedFor by mutableStateOf<File?>(null)

    /** True once [file] has been tried: a null [player] is then the answer. */
    fun isSettledFor(file: File?): Boolean = file != null && openedFor == file
}

@Composable
internal fun rememberVoiceNoteSlot(
    attachmentId: String,
    file: File?,
): VoiceNoteSlot {
    val context = LocalContext.current
    val slot = remember(attachmentId) { VoiceNoteSlot() }

    DisposableEffect(attachmentId, file) {
        onDispose {
            // The bubble scrolled away, or the screen did. Either way the
            // codec goes back — a `MediaPlayer` left alive holds a hardware
            // decoder, and a phone has a small number of them.
            slot.player?.release()
            slot.player = null
            slot.openedFor = null
        }
    }

    LaunchedEffect(attachmentId, file) {
        if (file == null) return@LaunchedEffect
        // `MediaPlayer` reads from the file itself — never from the server's
        // URL, which would arrive without the operator's token.
        //
        // Held outside `withContext` so a bubble that goes away WHILE the
        // file is being prepared still gives the codec back: `prepare` does
        // not stop for a cancellation, and the player it made would otherwise
        // be dropped with the discarded result, alive and holding a decoder.
        var made: VoiceNotePlayer? = null
        try {
            withContext(Dispatchers.IO) { made = VoiceNotePlayer.of(context, file) }
        } catch (cancelled: CancellationException) {
            made?.release()
            throw cancelled
        }
        slot.player = made
        slot.openedFor = file
    }

    // The tick. 80ms is iOS's interval and is the slowest rate at which a
    // 4dp bar still looks like it is moving rather than stepping.
    val active = slot.player
    LaunchedEffect(active, active?.isPlaying) {
        if (active == null || !active.isPlaying) return@LaunchedEffect
        while (true) {
            delay(80)
            active.sample()
            if (!active.isPlaying) return@LaunchedEffect
        }
    }

    return slot
}
