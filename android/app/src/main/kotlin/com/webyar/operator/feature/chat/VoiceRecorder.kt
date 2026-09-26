package com.webyar.operator.feature.chat

import android.content.Context
import android.media.MediaRecorder
import android.os.Build
import java.io.File

/**
 * Records a voice note the operator can send.
 *
 * Deliberately AAC in an MP4 container: `audio/mp4` is on the server's allowed
 * list (`server/routes/conversationAttachments.ts`), it is what the browser's
 * `MediaRecorder` produces so the console already sends the same thing, and
 * every platform that might play it back has a decoder. The formats Android
 * records most readily — 3GPP, AMR — are on nobody's allowed list, and AMR in
 * particular is a narrowband codec that makes a colleague's voice sound like a
 * 1998 phone call.
 *
 * This is a plain class rather than a `ViewModel` because it holds an OS
 * resource that must be released on a schedule the composition does not
 * control: a recorder left running when the screen goes away keeps the
 * microphone, and the next app to ask for it is told no.
 */
class VoiceRecorder(private val context: Context) {

    enum class Failure {
        /** The operator said no to the microphone, or it is off in Settings. */
        PERMISSION_DENIED,

        /** Recording would not start at all. */
        UNAVAILABLE,
    }

    var isRecording: Boolean = false
        private set

    private var recorder: MediaRecorder? = null
    private var output: File? = null

    val mimeType: String get() = "audio/mp4"
    val fileName: String get() = "voice-note.m4a"

    /**
     * Starts, or says why it could not.
     *
     * The permission itself is the caller's to request — a recorder that
     * launched a permission dialog would be a model reaching into the UI — so
     * arriving here without it is [Failure.PERMISSION_DENIED] rather than an
     * exception.
     */
    fun start(): Failure? {
        if (isRecording) return null
        val file = File(context.cacheDir, "voice-${System.currentTimeMillis()}.m4a")

        val instance = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            MediaRecorder(context)
        } else {
            // The no-argument constructor is deprecated from API 31 and the
            // only one that exists below it.
            @Suppress("DEPRECATION")
            MediaRecorder()
        }

        return try {
            instance.apply {
                setAudioSource(MediaRecorder.AudioSource.MIC)
                setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
                setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
                // 44.1kHz mono at 96kbps: speech, not music. A voice note at
                // stereo 256k is four times the upload for no audible gain on
                // the phone speaker it will be played back on.
                setAudioSamplingRate(44_100)
                setAudioChannels(1)
                setAudioEncodingBitRate(96_000)
                setMaxDuration(MAX_SECONDS * 1000)
                setOutputFile(file.absolutePath)
                prepare()
                start()
            }
            recorder = instance
            output = file
            isRecording = true
            null
        } catch (e: SecurityException) {
            instance.release()
            file.delete()
            Failure.PERMISSION_DENIED
        } catch (e: Exception) {
            instance.release()
            file.delete()
            Failure.UNAVAILABLE
        }
    }

    /**
     * Stops and hands back the bytes, or null if there is nothing worth
     * sending.
     *
     * A recording under a second is a mis-tap, not a message. Sending one
     * puts a silent note in front of the visitor that the operator has to
     * apologise for.
     */
    fun finish(): ByteArray? {
        val file = stopAndRelease() ?: return null
        val bytes = runCatching { file.readBytes() }.getOrNull()
        file.delete()
        return bytes?.takeIf { it.size > MINIMUM_BYTES }
    }

    /**
     * Stops and keeps the recording as a file, to be listened to before it
     * is sent. Null for a tap too short to be a message, as [finish].
     *
     * The file is the caller's from here: it deletes it once the note is
     * sent or thrown away.
     */
    fun finishToFile(): File? {
        val file = stopAndRelease() ?: return null
        if (file.length() <= MINIMUM_BYTES) {
            file.delete()
            return null
        }
        return file
    }

    /** Stops and throws the recording away. */
    fun cancel() {
        stopAndRelease()?.delete()
    }

    private fun stopAndRelease(): File? {
        val instance = recorder ?: return null
        val file = output
        recorder = null
        output = null
        isRecording = false
        // stop() throws when nothing was ever captured — a tap so short the
        // encoder never got a frame. The file is still deleted either way,
        // which is the whole reason this is one funnel rather than two.
        runCatching { instance.stop() }
        runCatching { instance.release() }
        return file
    }

    private companion object {
        /**
         * Five minutes, matching the console's recorder. A voice note longer
         * than that is a phone call somebody should have made instead.
         */
        const val MAX_SECONDS = 300

        /** Roughly a second of 96kbps AAC, plus the container's own header. */
        const val MINIMUM_BYTES = 12_000
    }
}

/**
 * A finished recording waiting in the composer: heard, then sent or thrown
 * away. The file lives in the cache directory until one of the two.
 */
class RecordedVoice(val file: File, val fileName: String, val mimeType: String)
