package com.webyar.ai.feature.call

import android.content.Context
import com.twilio.audioswitch.AudioDevice
import com.webyar.ai.core.model.CallToken
import com.webyar.ai.core.runCatchingUnlessCancelled
import io.livekit.android.ConnectOptions
import io.livekit.android.LiveKit
import io.livekit.android.AudioOptions
import io.livekit.android.LiveKitOverrides
import io.livekit.android.RoomOptions
import io.livekit.android.audio.AudioSwitchHandler
import io.livekit.android.events.RoomEvent
import io.livekit.android.events.collect
import io.livekit.android.renderer.TextureViewRenderer
import io.livekit.android.room.Room
import io.livekit.android.room.track.CameraPosition
import io.livekit.android.room.track.LocalVideoTrackOptions
import io.livekit.android.room.track.Track
import io.livekit.android.room.track.TrackPublication
import io.livekit.android.room.track.VideoTrack
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import livekit.org.webrtc.PeerConnection

/**
 * The real room.
 *
 * Everything in this app that knows what WebRTC is lives in this file.
 */
class LiveKitRoom(private val context: Context) : CallRoom {

    private val _events = MutableSharedFlow<CallRoom.Event>(extraBufferCapacity = 8)
    override val events: Flow<CallRoom.Event> = _events.asSharedFlow()

    /**
     * The two pictures, held here rather than read out of the room whenever a
     * view happens to redraw.
     *
     * `Room` is not a Compose state holder. A composable that reached into
     * `room.remoteParticipants` would only ever see what was true the last
     * time something ELSE invalidated it — so a visitor who switched their
     * camera on a moment after answering would stay invisible until, by luck,
     * some unrelated state changed. Keeping the tracks in flows and updating
     * them from the room's own events is what makes the picture arrive when
     * it actually arrives.
     */
    private val _remoteVideo = MutableStateFlow<VideoTrack?>(null)
    val remoteVideo: StateFlow<VideoTrack?> = _remoteVideo.asStateFlow()

    private val _localVideo = MutableStateFlow<VideoTrack?>(null)
    val localVideo: StateFlow<VideoTrack?> = _localVideo.asStateFlow()

    private var room: Room? = null
    private var listening: Job? = null

    /**
     * On the main thread, like every other caller of [refreshTracks].
     *
     * [connect] and [setCamera] refresh the same two flows from the main
     * thread; with the room's events collected on a pool thread, whichever
     * wrote last would win — sometimes with the older answer. One thread
     * makes "last" mean "latest".
     */
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val audio = AudioSwitchHandler(context.applicationContext)

    /**
     * Hands a renderer the room's EGL context.
     *
     * Through the room rather than a context fetched separately: a renderer
     * initialised against a different EGL context draws nothing and says
     * nothing about why.
     */
    fun initRenderer(view: TextureViewRenderer) {
        room?.initVideoRenderer(view)
    }

    override suspend fun connect(
        url: String,
        credentials: CallToken,
        wantsVideo: Boolean,
    ): CallRoom.Result {
        val room = LiveKit.create(
            appContext = context.applicationContext,
            options = RoomOptions(
                adaptiveStream = true,
                dynacast = true,
                videoTrackCaptureDefaults = LocalVideoTrackOptions(
                    position = CameraPosition.FRONT,
                ),
            ),
            overrides = LiveKitOverrides(audioOptions = AudioOptions(audioHandler = audio)),
        )
        this.room = room
        audio.preferredDeviceList = SPEAKER_FIRST
        listening = scope.launch { listen(room) }

        try {
            room.connect(url = url, token = credentials.token, options = connectOptions(credentials))
        } catch (e: CancellationException) {
            // The operator hung up while this was connecting. That is not a
            // failure, and reporting it as one would rewrite "call ended"
            // into "could not connect" on the screen of somebody who has just
            // pressed the red button.
            throw e
        } catch (e: Throwable) {
            return CallRoom.Result.Failed(e.message ?: e::class.simpleName.orEmpty())
        }
        // A join can finish without ever looking at cancellation. Checked
        // before anything is published, so a call hung up mid-connect never
        // switches the microphone on for a moment afterwards.
        currentCoroutineContext().ensureActive()

        // Best-effort, each on its own: a refused camera must not take the
        // microphone down with it.
        val micOk = runCatchingUnlessCancelled { room.localParticipant.setMicrophoneEnabled(true) }
            .getOrDefault(false)
        val cameraOk = wantsVideo &&
            runCatchingUnlessCancelled { room.localParticipant.setCameraEnabled(true) }.getOrDefault(false)

        withContext(Dispatchers.Main.immediate) { refreshTracks(room) }
        return CallRoom.Result.Joined(microphone = micOk, camera = cameraOk)
    }

    private fun connectOptions(credentials: CallToken): ConnectOptions {
        val iceServers = credentials.turn
            ?.urls
            ?.takeIf { it.isNotEmpty() }
            ?.let { urls ->
                listOf(
                    PeerConnection.IceServer.builder(urls)
                        .setUsername(credentials.turn?.username.orEmpty())
                        .setPassword(credentials.turn?.credential.orEmpty())
                        .createIceServer()
                )
            }

        // Always a configuration of our own, never null. The SDK reads
        // `ConnectOptions.iceServers` only while merging them into an
        // `rtcConfig` it is given; with none, it builds its own from the
        // server's list alone and the workspace's TURN is silently dropped —
        // every call not marked relay-only would go out without it.
        //
        // With no TURN of our own the list is empty, and the SDK then uses
        // only the servers LiveKit sent.
        val rtcConfig = PeerConnection.RTCConfiguration(iceServers.orEmpty()).apply {
            // Relay-only when the server says so. A workspace behind a strict
            // NAT connects through TURN or not at all, and offering host
            // candidates first only makes it slower to fail.
            if (credentials.relayOnly) {
                iceTransportsType = PeerConnection.IceTransportsType.RELAY
            }
        }

        return ConnectOptions(iceServers = iceServers, rtcConfig = rtcConfig)
    }

    private suspend fun listen(room: Room) {
        room.events.collect { event ->
            when (event) {
                // `TrackPublished` and `TrackUnpublished` carry a plain
                // `Participant`, so they cover our own tracks as well as the
                // visitor's; there is no separate local pair to listen for.
                is RoomEvent.TrackSubscribed,
                is RoomEvent.TrackUnsubscribed,
                is RoomEvent.TrackPublished,
                is RoomEvent.TrackUnpublished,
                is RoomEvent.LocalTrackSubscribed,
                is RoomEvent.TrackMuted,
                is RoomEvent.TrackUnmuted,
                -> refreshTracks(room)

                is RoomEvent.ParticipantConnected -> {
                    refreshTracks(room)
                    _events.tryEmit(CallRoom.Event.VisitorPresenceChanged(present = true))
                }

                is RoomEvent.ParticipantDisconnected -> {
                    refreshTracks(room)
                    _events.tryEmit(
                        CallRoom.Event.VisitorPresenceChanged(
                            present = room.remoteParticipants.isNotEmpty(),
                        )
                    )
                }

                is RoomEvent.Disconnected -> {
                    clearTracks()
                    _events.tryEmit(CallRoom.Event.Disconnected)
                }

                else -> Unit
            }
        }
    }

    /**
     * Reads the pictures out of the room as they stand at this moment.
     *
     * From `trackPublications`, not `videoTrackPublications`. The second is
     * derived from the first on the SDK's own dispatcher, so at the moment a
     * `TrackSubscribed` arrives it can still describe the room from before —
     * and the refresh that event asks for would read "no picture" about a
     * visitor whose picture has just arrived. The first is the map itself.
     *
     * Main thread only; see [scope].
     */
    private fun refreshTracks(room: Room) {
        _remoteVideo.value = room.remoteParticipants.values
            .asSequence()
            .flatMap { it.trackPublications.values.asSequence() }
            .firstNotNullOfOrNull { it.liveVideo() }

        _localVideo.value = room.localParticipant
            .getTrackPublication(Track.Source.CAMERA)
            ?.liveVideo()
    }

    /**
     * The picture a publication is actually sending: video, subscribed, and
     * not muted. A muted camera keeps its track, and drawing it would show
     * the visitor frozen on the last frame before they switched it off.
     */
    private fun TrackPublication.liveVideo(): VideoTrack? =
        if (kind == Track.Kind.VIDEO && !muted) track as? VideoTrack else null

    /**
     * Nothing to draw once the room is gone. A track outlives its room as an
     * object, not as a picture: drawing it afterwards asks a disposed native
     * track for frames.
     */
    private fun clearTracks() {
        _remoteVideo.value = null
        _localVideo.value = null
    }

    override suspend fun setMicrophone(enabled: Boolean): Boolean {
        val room = room ?: return false
        return runCatchingUnlessCancelled { room.localParticipant.setMicrophoneEnabled(enabled) }
            .getOrDefault(false)
    }

    override suspend fun setCamera(enabled: Boolean): Boolean {
        val room = room ?: return false
        val ok = runCatchingUnlessCancelled { room.localParticipant.setCameraEnabled(enabled) }
            .getOrDefault(false)
        withContext(Dispatchers.Main.immediate) { refreshTracks(room) }
        return ok
    }

    /**
     * Earpiece or loudspeaker, expressed as a preference order.
     *
     * Through the SDK's own audio handler rather than AudioManager directly:
     * the handler owns the audio focus and the mode, and changing the route
     * behind its back is what makes an audio engine tear itself down and
     * rebuild in the middle of a call.
     *
     * A headset wins either way, and that is not a compromise — somebody who
     * has plugged one in has said where they want the sound.
     */
    override fun setSpeaker(on: Boolean) {
        audio.preferredDeviceList = if (on) SPEAKER_FIRST else EARPIECE_FIRST
    }

    override suspend fun disconnect() {
        room?.disconnect()
        clearTracks()
    }

    override fun release() {
        listening?.cancel()
        listening = null
        clearTracks()
        room?.release()
        room = null
        scope.cancel()
    }

    private companion object {
        val SPEAKER_FIRST = listOf(
            AudioDevice.BluetoothHeadset::class.java,
            AudioDevice.WiredHeadset::class.java,
            AudioDevice.Speakerphone::class.java,
            AudioDevice.Earpiece::class.java,
        )
        val EARPIECE_FIRST = listOf(
            AudioDevice.BluetoothHeadset::class.java,
            AudioDevice.WiredHeadset::class.java,
            AudioDevice.Earpiece::class.java,
            AudioDevice.Speakerphone::class.java,
        )
    }
}
