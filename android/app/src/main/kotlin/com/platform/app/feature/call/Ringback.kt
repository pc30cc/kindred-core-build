package com.platform.app.feature.call

import android.media.AudioManager
import android.media.ToneGenerator

/**
 * The tone a caller hears while the other phone rings — the "brr… brr…"
 * every phone plays, so a call that is ringing sounds like one and is not
 * mistaken for a call that hung.
 *
 * Behind an interface for the same reason [CallRoom] is: the session that
 * decides when it plays, and where, is tested on a JVM, where there is no
 * tone to play.
 */
interface Ringback {
    /** Plays until [stop], on the output last given to [route]. Twice is once. */
    fun start()

    /** Silence, and the tone's resources handed back. Safe when not playing. */
    fun stop()

    /**
     * Where the tone plays: said before it starts, and again whenever that
     * changes while it plays (the phone raised to the ear or taken from it,
     * Speaker pressed), which moves the tone at once.
     */
    fun route(output: RingbackOutput) {}
}

/** Where a ringback plays. */
enum class RingbackOutput {
    /** The earpiece: the phone is at the ear, on a voice call. */
    EARPIECE,

    /** The loudspeaker (or whatever plays media: a headset, a car). */
    LOUDSPEAKER;

    companion object {
        /**
         * Where the tone goes. A voice call held to the ear hears it on the
         * earpiece, as a phone call does; anywhere else — the phone in front
         * of the face, which is how a call is placed, Speaker on, or a video
         * call — on the loudspeaker. Played on the earpiece in front of the
         * face, the caller hears nothing and takes the call for one that
         * hung (2026-11-05).
         */
        fun of(video: Boolean, speakerOn: Boolean, atEar: Boolean): RingbackOutput =
            if (!video && !speakerOn && atEar) EARPIECE else LOUDSPEAKER

        /**
         * The stream each output plays on. Before the call's room exists the
         * phone is in its normal audio mode, where the voice-call stream is
         * the earpiece and the media stream the loudspeaker (or a headset,
         * which then carries the tone either way).
         */
        fun stream(output: RingbackOutput): Int = when (output) {
            EARPIECE -> AudioManager.STREAM_VOICE_CALL
            LOUDSPEAKER -> AudioManager.STREAM_MUSIC
        }

        /**
         * Of ToneGenerator's 0–100, a share of the stream's own volume: the
         * earpiece is quiet and wants more of its stream; the loudspeaker is
         * present without startling.
         */
        fun volume(output: RingbackOutput): Int = when (output) {
            EARPIECE -> 90
            LOUDSPEAKER -> 75
        }
    }
}

/**
 * The platform's own ringback ([ToneGenerator.TONE_SUP_RINGTONE], the
 * call-progress tone a dialler plays: two soft notes together, on and off),
 * on the stream [RingbackOutput.stream] picks for where it plays.
 *
 * A generator is made per ring — and per move, since a generator's stream is
 * fixed — and released at [stop]: the system has few, and one held for a
 * whole call is one another app cannot have. One that cannot be made — the
 * audio service refusing, which happens — leaves the ring silent rather
 * than the call failed.
 */
class ToneRingback : Ringback {
    private var tone: ToneGenerator? = null
    private var output = RingbackOutput.LOUDSPEAKER

    override fun start() {
        if (tone != null) return
        tone = play(output)
    }

    override fun stop() {
        val playing = tone ?: return
        tone = null
        release(playing)
    }

    override fun route(output: RingbackOutput) {
        if (output == this.output) return
        this.output = output
        val playing = tone ?: return
        // The tone starts again where it is now heard: the old generator
        // goes first, so the two never sound together.
        release(playing)
        tone = play(output)
    }

    private fun play(output: RingbackOutput): ToneGenerator? = runCatching {
        ToneGenerator(RingbackOutput.stream(output), RingbackOutput.volume(output))
            .also { it.startTone(ToneGenerator.TONE_SUP_RINGTONE) }
    }.getOrNull()

    private fun release(generator: ToneGenerator) {
        runCatching {
            generator.stopTone()
            generator.release()
        }
    }
}
