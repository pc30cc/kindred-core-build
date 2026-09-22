package com.webyar.operator.feature.call

import android.content.Context
import com.twilio.audioswitch.AudioDevice
import com.webyar.operator.core.model.CallToken
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
import io.livekit.android.room.track.VideoTrack
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
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
    private val scope = CoroutineScope(SupervisorJob())
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
        } catch (e: Throwable) {
            return CallRoom.Result.Failed(e.message ?: e::class.simpleName.orEmpty())
        }

        // Best-effort, each on its own: a refused camera must not take the
        // microphone down with it.
        val micOk = runCatching { room.localParticipant.setMicrophoneEnabled(true) }
            .getOrDefault(false)
        val cameraOk = wantsVideo &&
            runCatching { room.localParticipant.setCameraEnabled(true) }.getOrDefault(false)

        refreshTracks(room)
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

        // Relay-only when the server says so. A workspace behind a strict NAT
        // connects through TURN or not at all, and offering host candidates
        // first only makes it slower to fail.
        val rtcConfig = if (credentials.icePolicy == "relay") {
            PeerConnection.RTCConfiguration(iceServers.orEmpty()).apply {
                iceTransportsType = PeerConnection.IceTransportsType.RELAY
            }
        } else {
            null
        }

        return ConnectOptions(iceServers = iceServers, rtcConfig = rtcConfig)
    }

    private suspend fun listen(room: Room) {
        room.events.collect { event ->
            when (event) {
                is RoomEvent.TrackSubscribed,
                is RoomEvent.TrackUnsubscribed,
                is RoomEvent.TrackPublished,
                is RoomEvent.TrackUnpublished,
                is RoomEvent.LocalTrackPublished,
                is RoomEvent.LocalTrackUnpublished,
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

                is RoomEvent.Disconnected -> _events.tryEmit(CallRoom.Event.Disconnected)

                else -> Unit
            }
        }
    }

    private fun refreshTracks(room: Room) {
        _remoteVideo.value = room.remoteParticipants.values
            .asSequence()
            .flatMap { it.videoTrackPublications.asSequence() }
            .mapNotNull { it.second as? VideoTrack }
            .firstOrNull()

        _localVideo.value = room.localParticipant
            .getTrackPublication(Track.Source.CAMERA)
            ?.track as? VideoTrack
    }

    override suspend fun setMicrophone(enabled: Boolean) {
        runCatching { room?.localParticipant?.setMicrophoneEnabled(enabled) }
    }

    override suspend fun setCamera(enabled: Boolean) {
        runCatching { room?.localParticipant?.setCameraEnabled(enabled) }
        room?.let { refreshTracks(it) }
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
    }

    override fun release() {
        listening?.cancel()
        listening = null
        _remoteVideo.value = null
        _localVideo.value = null
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
