package com.platform.app.core.push

import com.platform.app.core.Diag
import com.platform.app.core.net.ApiError
import com.platform.app.core.runCatchingUnlessCancelled
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * Tells the server this phone is ringing for a colleague call
 * (`POST /api/team-calls/:id/rang`), so the caller's screen moves from
 * "Calling…" to "Ringing…" only once a phone actually rings
 * (docs/operations/TEAM_CALLS.md, "Ring and its stop").
 *
 * Once per call per phone: the full-screen ring posted for a
 * `team_call_incoming` and the in-app ring screen opening for the same call
 * both ask, and only the first sends. A failure is tried twice more, a few
 * seconds apart, then dropped: the caller then simply stays on "Calling…".
 * `409 not_ringing` is too late, and a `404`/`405` from a server without the
 * route yet is ignored, silently.
 */
class TeamCallRangReporter(
    private val send: suspend (callId: String, deviceId: String?) -> Unit,
    private val deviceId: suspend () -> String?,
    private val scope: CoroutineScope,
    private val retryDelayMs: Long = RETRY_DELAY_MS,
    private val diag: Diag = Diag.Android,
) {
    private val reported = LinkedHashSet<String>()

    /** Whether [callId] was already reported (or is being) from this process. */
    fun hasReported(callId: String): Boolean = synchronized(reported) { callId in reported }

    fun report(callId: String) {
        val first = synchronized(reported) {
            val added = reported.add(callId)
            // A bounded memory: one entry per ring is all it ever holds.
            while (reported.size > MAX_REMEMBERED) reported.remove(reported.first())
            added
        }
        if (!first) return
        scope.launch {
            val device = runCatchingUnlessCancelled { deviceId() }.getOrNull()
            repeat(ATTEMPTS) { attempt ->
                val result = runCatchingUnlessCancelled { send(callId, device) }
                if (result.isSuccess) return@launch
                val status = (result.exceptionOrNull() as? ApiError.Server)?.status
                if (status in FINAL_STATUSES) return@launch
                if (attempt < ATTEMPTS - 1) delay(retryDelayMs)
            }
            diag.warn(AREA, "rang not sent for ${Diag.id(callId)}")
        }
    }

    internal companion object {
        /** The first try and two retries. */
        const val ATTEMPTS = 3
        const val RETRY_DELAY_MS = 3_000L
        const val MAX_REMEMBERED = 64

        /** Not worth another try: too late (409), or a server without the route (404, 405). */
        val FINAL_STATUSES = setOf(404, 405, 409)

        const val AREA = "Call"
    }
}
