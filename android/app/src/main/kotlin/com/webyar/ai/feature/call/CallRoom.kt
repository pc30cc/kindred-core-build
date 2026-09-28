package com.webyar.ai.feature.call

import com.webyar.ai.core.model.CallToken
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

    /**
     * Joins the room. Cancelling the caller cancels the join, and is never
     * reported as a [Result.Failed]: a call the operator hung up while it
     * connected ended because they hung up, not because it failed.
     */
    suspend fun connect(url: String, credentials: CallToken, wantsVideo: Boolean): Result

    /**
     * Whether the change actually happened. A microphone another app has
     * taken, or a camera that will not start, says no — and a button that
     * went on claiming otherwise would be lying about the call.
     */
    suspend fun setMicrophone(enabled: Boolean): Boolean
    suspend fun setCamera(enabled: Boolean): Boolean

    /** Earpiece or loudspeaker. Not suspending: the route changes at once. */
    fun setSpeaker(on: Boolean)

    /** Leaves the room. Not suspending in practice, and safe to call twice. */
    suspend fun disconnect()

    /** Hands the microphone and camera back. Safe to call twice. */
    fun release()
}
