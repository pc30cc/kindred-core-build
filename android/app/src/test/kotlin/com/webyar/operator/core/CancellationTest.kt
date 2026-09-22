package com.webyar.operator.core

import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.coroutines.cancellation.CancellationException

/**
 * The difference between "this failed" and "nobody is waiting for it any more".
 *
 * These look alike from inside a `catch` and mean opposite things, and the one
 * time the app got them confused it cost a working feature: a cancelled
 * invitation request was reported as a failed call, and the call screen said
 * "the call could not connect" about a call that went on to ring, be answered
 * and connect.
 */
class CancellationTest {

    @Test
    fun `a failure is still a failure`() {
        val result = runCatchingUnlessCancelled { error("boom") }

        assertTrue(result.isFailure)
        assertEquals("boom", result.exceptionOrNull()?.message)
    }

    @Test
    fun `a value still comes back`() {
        assertEquals(7, runCatchingUnlessCancelled { 7 }.getOrNull())
    }

    @Test
    fun `a cancellation is not a failure, and keeps unwinding`() = runTest {
        var reportedAsFailure = false
        var unwound = false

        val job = launch(start = CoroutineStart.UNDISPATCHED) {
            try {
                runCatchingUnlessCancelled { awaitCancellation() }
                    .onFailure { reportedAsFailure = true }
            } catch (cancelled: CancellationException) {
                unwound = true
                throw cancelled
            }
        }
        job.cancelAndJoin()

        assertFalse("a cancelled request must not look like a failed one", reportedAsFailure)
        assertTrue("cancellation must still cancel", unwound)
    }

    /**
     * The behaviour this exists to avoid, pinned so that "why not just use
     * `runCatching`?" has an answer that runs.
     */
    @Test
    fun `the standard library is the one that conflates them`() = runTest {
        var reportedAsFailure = false

        val job = launch(start = CoroutineStart.UNDISPATCHED) {
            runCatching { awaitCancellation() }.onFailure { reportedAsFailure = true }
        }
        job.cancelAndJoin()

        assertTrue(reportedAsFailure)
    }
}
