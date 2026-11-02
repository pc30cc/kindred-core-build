package com.platform.app.feature.call

import android.media.AudioManager
import android.media.ToneGenerator

/**
 * The tone a caller hears while the other phone rings — the "brr… brr…"
 * every phone plays, so a call that is ringing sounds like one and is not
 * mistaken for a call that hung.
 *
 * Behind an interface for the same reason [CallRoom] is: the session that
 * decides when it plays is tested on a JVM, where there is no tone to play.
 */
interface Ringback {
    /** Plays until [stop]. Twice is once. */
    fun start()

    /** Silence, and the tone's resources handed back. Safe when not playing. */
    fun stop()
}

/**
 * The platform's own ringback ([ToneGenerator.TONE_SUP_RINGTONE], the
 * call-progress tone a dialler plays), on the stream the call itself will
 * use: the voice-call stream for a voice call, which starts on the earpiece,
 * and the media stream for a video call, which is held in front of the face
 * on the loudspeaker.
 *
 * A generator is made per ring and released at [stop]: the system has few,
 * and one held for a whole call is one another app cannot have. One that
 * cannot be made — the audio service refusing, which happens — leaves the
 * ring silent rather than the call failed.
 */
class ToneRingback(private val video: Boolean) : Ringback {
    private var tone: ToneGenerator? = null

    override fun start() {
        if (tone != null) return
        tone = runCatching {
            ToneGenerator(if (video) AudioManager.STREAM_MUSIC else AudioManager.STREAM_VOICE_CALL, VOLUME)
                .also { it.startTone(ToneGenerator.TONE_SUP_RINGTONE) }
        }.getOrNull()
    }

    override fun stop() {
        val playing = tone ?: return
        tone = null
        runCatching {
            playing.stopTone()
            playing.release()
        }
    }

    private companion object {
        /** Of ToneGenerator's 0–100: present, not startling. */
        const val VOLUME = 70
    }
}
