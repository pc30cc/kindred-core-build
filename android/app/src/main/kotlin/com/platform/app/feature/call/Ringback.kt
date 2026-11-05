package com.platform.app.feature.call

import android.annotation.SuppressLint
import android.content.Context
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.media.ToneGenerator
import android.os.Handler
import android.os.Looper

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
         * The stream and the level (ToneGenerator's 0–100, a share of the
         * stream's own volume) a tone plays at. Before the call's room exists
         * the phone is in its normal audio mode, where the voice-call stream
         * is the earpiece and the media stream the loudspeaker. Nothing here
         * forces a route: no speakerphone, no communication device, no audio
         * mode, so nothing is left to undo when the call ends.
         *
         * [external]: a headset, Bluetooth (A2DP, SCO, LE), USB audio or a
         * car is connected. The tone then always takes the media stream,
         * which the system sends there, at the quiet level — it is at the
         * ear — and never the loudspeaker over it. Otherwise the earpiece is
         * the old ringback's level and the loudspeaker clearly louder.
         */
        fun sound(output: RingbackOutput, external: Boolean): Sound = when {
            external -> Sound(AudioManager.STREAM_MUSIC, QUIET)
            output == EARPIECE -> Sound(AudioManager.STREAM_VOICE_CALL, QUIET)
            else -> Sound(AudioManager.STREAM_MUSIC, LOUD)
        }

        /** At the ear: the level the ringback always had. */
        const val QUIET = 70

        /** In front of the face: heard across a desk, not startling. */
        const val LOUD = 90

        /**
         * Whether an output device is a headset, Bluetooth (A2DP, SCO, LE),
         * USB audio or a hearing aid — what [sound] calls external; a car
         * (Android Auto) connects as one of these. A list of what counts,
         * not of what does not: some phones list built-in outputs of other
         * types at all times, which must not keep the tone off the
         * loudspeaker.
         */
        fun isExternal(type: Int): Boolean = type in EXTERNAL

        // Constants newer than an old phone are only numbers there, which
        // its devices never report.
        @SuppressLint("InlinedApi")
        private val EXTERNAL = setOf(
            AudioDeviceInfo.TYPE_WIRED_HEADSET,
            AudioDeviceInfo.TYPE_WIRED_HEADPHONES,
            AudioDeviceInfo.TYPE_LINE_ANALOG,
            AudioDeviceInfo.TYPE_BLUETOOTH_SCO,
            AudioDeviceInfo.TYPE_BLUETOOTH_A2DP,
            AudioDeviceInfo.TYPE_USB_DEVICE,
            AudioDeviceInfo.TYPE_USB_ACCESSORY,
            AudioDeviceInfo.TYPE_USB_HEADSET,
            AudioDeviceInfo.TYPE_HEARING_AID,
            AudioDeviceInfo.TYPE_BLE_HEADSET,
            AudioDeviceInfo.TYPE_BLE_SPEAKER,
            AudioDeviceInfo.TYPE_BLE_BROADCAST,
        )
    }

    /** What a tone is played as. */
    data class Sound(val stream: Int, val volume: Int)
}

/**
 * The platform's own ringback ([ToneGenerator.TONE_SUP_RINGTONE], the
 * call-progress tone a dialler plays: two soft notes together, on and off),
 * on the stream and at the level [RingbackOutput.sound] picks for where it
 * plays and what is connected.
 *
 * A generator is made per ring — and per move, since a generator's stream is
 * fixed — and released at [stop]: the system has few, and one held for a
 * whole call is one another app cannot have. One that cannot be made — the
 * audio service refusing, which happens — leaves the ring silent rather
 * than the call failed.
 */
class ToneRingback(context: Context) : Ringback {
    private val audio = context.getSystemService(AudioManager::class.java)
    private var tone: ToneGenerator? = null
    private var playing: RingbackOutput.Sound? = null
    private var output = RingbackOutput.LOUDSPEAKER

    /** A headset or a car connected or gone while it plays: the tone moves with it. */
    private val devices = object : AudioDeviceCallback() {
        override fun onAudioDevicesAdded(added: Array<out AudioDeviceInfo>?) = replay()
        override fun onAudioDevicesRemoved(removed: Array<out AudioDeviceInfo>?) = replay()
    }

    override fun start() {
        if (tone != null) return
        runCatching { audio?.registerAudioDeviceCallback(devices, Handler(Looper.getMainLooper())) }
        play()
    }

    override fun stop() {
        runCatching { audio?.unregisterAudioDeviceCallback(devices) }
        val generator = tone ?: return
        tone = null
        playing = null
        release(generator)
    }

    override fun route(output: RingbackOutput) {
        if (output == this.output) return
        this.output = output
        replay()
    }

    /**
     * The tone starts again where, and as loud as, it is now heard — only
     * when that changed. The old generator goes first, so two never sound
     * together.
     */
    private fun replay() {
        val generator = tone ?: return
        if (sound() == playing) return
        tone = null
        release(generator)
        play()
    }

    private fun sound(): RingbackOutput.Sound = RingbackOutput.sound(output, external = externalConnected())

    private fun externalConnected(): Boolean = runCatching {
        audio?.getDevices(AudioManager.GET_DEVICES_OUTPUTS)?.any { RingbackOutput.isExternal(it.type) } == true
    }.getOrDefault(false)

    private fun play() {
        val sound = sound()
        tone = runCatching {
            ToneGenerator(sound.stream, sound.volume).also { it.startTone(ToneGenerator.TONE_SUP_RINGTONE) }
        }.getOrNull()
        playing = sound.takeIf { tone != null }
    }

    private fun release(generator: ToneGenerator) {
        runCatching {
            generator.stopTone()
            generator.release()
        }
    }
}
