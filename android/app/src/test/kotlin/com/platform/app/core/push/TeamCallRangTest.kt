package com.platform.app.core.push

import com.platform.app.core.Diag
import com.platform.app.core.net.ApiError
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** `POST /api/team-calls/:id/rang`: once per call per phone, two retries, quiet on a server without it. */
class TeamCallRangTest {

    private class Sent(val callId: String, val deviceId: String?)

    @Test
    fun `a ring is reported once, however often it is asked`() = runTest {
        val sent = mutableListOf<Sent>()
        val reporter = TeamCallRangReporter(
            send = { id, device -> sent += Sent(id, device) },
            deviceId = { "android-1" },
            scope = this,
            diag = Diag.Silent,
        )
        reporter.report("call-1")
        reporter.report("call-1") // The in-app ring screen, after the notification.
        reporter.report("call-2")
        advanceUntilIdle()

        assertEquals(listOf("call-1", "call-2"), sent.map { it.callId })
        assertEquals("android-1", sent.first().deviceId)
        assertTrue(reporter.hasReported("call-1"))
    }

    @Test
    fun `a failure is tried twice more, then dropped`() = runTest {
        var tries = 0
        val reporter = TeamCallRangReporter(
            send = { _, _ -> tries++; throw ApiError.Server(503, null) },
            deviceId = { "android-1" },
            scope = this,
            diag = Diag.Silent,
        )
        reporter.report("call-1")
        advanceUntilIdle()
        assertEquals(3, tries)
    }

    @Test
    fun `too late, or a server without the route, is not tried again`() = runTest {
        for (status in listOf(404, 405, 409)) {
            var tries = 0
            val reporter = TeamCallRangReporter(
                send = { _, _ -> tries++; throw ApiError.Server(status, "not_ringing") },
                deviceId = { "android-1" },
                scope = this,
                diag = Diag.Silent,
            )
            reporter.report("call-$status")
            advanceUntilIdle()
            assertEquals("status $status", 1, tries)
        }
    }
}
