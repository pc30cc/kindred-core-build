package com.webyar.operator.feature.call

import com.webyar.operator.core.model.CallToken
import kotlinx.coroutines.flow.Flow

/**
 * The media half of a call, behind a door.
 *
 * WebRTC's native libraries cannot load on a JVM, so a session that named
 * LiveKit types directly would be a session no unit test could construct. The
 * parts of a call most worth testing — the waiting, the outcomes, what
 * happens when a microphone refuses to start — are not about media at all,
 * and this is what keeps them reachable.
 *
 * It is also the whole of the surface the rest of the app has on WebRTC. When
 * the SDK's API changes, it changes here.
 */
interface CallRoom {

    /** What happened when we tried to get in. */
    sealed interface Result {
        /**
         * In. [microphone] and [camera] say what actually started — both are
         * best-effort, and a call with neither is still a call the visitor
         * answered.
         */
        data class Joined(val microphone: Boolean, val camera: Boolean) : Result
        data class Failed(val reason: String) : Result
    }

    sealed interface Event {
        /** The visitor arrived in, or left, the room. */
        data class VisitorPresenceChanged(val present: Boolean) : Event
        /** We lost the room ourselves. */
        data object Disconnected : Event
    }

    val events: Flow<Event>

    suspend fun connect(url: String, credentials: CallToken, wantsVideo: Boolean): Result
    suspend fun setMicrophone(enabled: Boolean)
    suspend fun setCamera(enabled: Boolean)

    /** Earpiece or loudspeaker. Not suspending: the route changes at once. */
    fun setSpeaker(on: Boolean)

    suspend fun disconnect()

    /** Hands the microphone and camera back. Safe to call twice. */
    fun release()
}
