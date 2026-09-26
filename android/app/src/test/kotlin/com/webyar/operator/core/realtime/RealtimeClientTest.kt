package com.webyar.operator.core.realtime

import com.webyar.operator.core.Diag
import com.webyar.operator.core.model.RealtimeConnect
import com.webyar.operator.core.model.RealtimePolicy
import com.webyar.operator.core.net.ApiError
import com.webyar.operator.core.sync.RealtimeHealth
import com.webyar.operator.testing.FakeCentrifugo
import com.webyar.operator.testing.RecordingSink
import com.webyar.operator.testing.ScriptedApi
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.currentTime
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException
import kotlin.random.Random

/**
 * The socket's life: the frames it sends, what it delivers, how it comes
 * back after losing the connection — and that it stops when told to.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class RealtimeClientTest {

    private val api = ScriptedApi()
    private val server = FakeCentrifugo()
    private val sink = RecordingSink()

    /** Jitter pinned to the middle of its range, so backoff is exact. */
    private val noJitter = object : Random() {
        override fun nextBits(bitCount: Int): Int = 0
        override fun nextDouble(): Double = 0.5
    }

    private fun TestScope.client() = RealtimeClient(
        api = api,
        transport = server.transport,
        sink = sink,
        clock = { currentTime },
        random = noJitter,
        diag = Diag.Silent,
    )

    /** A server that pings every 25 s, as Centrifugo's `websocket_ping_interval` does. */
    private fun TestScope.keepAlive() {
        backgroundScope.launch {
            while (true) {
                delay(25_000)
                server.sockets.lastOrNull()?.ping()
            }
        }
    }

    private fun TestScope.start(): Job {
        val client = client()
        val job = backgroundScope.launch { client.run("ws-1") }
        runCurrent()
        return job
    }

    @Test
    fun `connects with the platform's tokens and subscribes to the inbox and presence`() = runTest {
        start()

        val socket = server.latest
        assertEquals(listOf("wss://rt.test/connection/websocket"), server.openedUrls)
        assertTrue(socket.sent[0].contains("\"connect\"") && socket.sent[0].contains("connection-token"))
        assertEquals("ws:ws-1:inbox", socket.subscribes[0]["channel"].toString().trim('"'))
        assertTrue(socket.sent[1].contains("inbox-token"))
        assertEquals("ws:ws-1:operators", socket.subscribes[1]["channel"].toString().trim('"'))
        assertEquals(listOf("initial"), api.connectIntents)
        assertEquals(RealtimeHealth.CONNECTED, sink.health.last())
    }

    @Test
    fun `a message publication reaches the app as a message, an event as an event`() = runTest {
        start()
        server.publish("ws:ws-1:inbox", server.messageData("m-1", "c-1", "hello"))
        server.publish("ws:ws-1:inbox", server.eventData("conversation_updated", "c-2"))
        runCurrent()

        assertEquals("hello", sink.messages.single().body)
        assertEquals("c-1", sink.messages.single().conversationId)
        assertEquals("conversation_updated", sink.events.single().kind)
    }

    @Test
    fun `a repeated publication is delivered once, a changed one again`() = runTest {
        start()
        val card = server.messageData("m-1", "c-1", "call", extra = ""","metadata":{"status":"ringing"}""")
        val answered = server.messageData("m-1", "c-1", "call", extra = ""","metadata":{"status":"answered"}""")
        server.publish("ws:ws-1:inbox", card)
        server.publish("ws:ws-1:inbox", card)
        server.publish("ws:ws-1:inbox", answered)
        runCurrent()

        assertEquals(2, sink.messages.size)
    }

    @Test
    fun `presence traffic is not the inbox's business`() = runTest {
        start()
        server.publish("ws:ws-1:operators", server.messageData("m-1", "c-1", "not for the inbox"))
        runCurrent()
        assertTrue(sink.messages.isEmpty())
    }

    @Test
    fun `a ping is answered with a pong`() = runTest {
        start()
        server.latest.ping()
        server.latest.ping()
        runCurrent()
        assertEquals(2, server.latest.pongs)
    }

    @Test
    fun `a dropped socket comes back after its backoff, resuming where it left off`() = runTest {
        start()
        server.publish("ws:ws-1:inbox", server.eventData("conversation_updated", "c-1"))
        runCurrent()
        server.latest.drop()
        runCurrent()

        advanceTimeBy(999)
        assertEquals(1, server.sockets.size)
        advanceTimeBy(2)
        assertEquals(2, server.sockets.size)

        val resume = server.latest.subscribes.first()
        assertEquals("true", resume["recover"].toString())
        assertEquals("1", resume["offset"].toString())
        assertEquals("\"epoch-1\"", resume["epoch"].toString())
        assertEquals(listOf("initial", "reconnect"), api.connectIntents)
        assertEquals(listOf(true), sink.reconnects)
    }

    @Test
    fun `a reconnect the server could not recover is reported as such`() = runTest {
        start()
        server.publish("ws:ws-1:inbox", server.eventData("conversation_updated", "c-1"))
        runCurrent()
        server.canRecover = false
        server.latest.drop()
        advanceTimeBy(1_001)

        assertEquals(listOf(false), sink.reconnects)
    }

    @Test
    fun `backoff grows with each failure and stops growing`() = runTest {
        server.refuseOpen = IOException("unreachable")
        start()
        val attempts = { api.connectIntents.size }
        assertEquals(1, attempts())

        // 1, 2, 4, 8, 15, 30, 30 seconds.
        var at = 0L
        for ((wait, expected) in listOf(1_000L to 2, 2_000L to 3, 4_000L to 4, 8_000L to 5, 15_000L to 6, 30_000L to 7, 30_000L to 8)) {
            at += wait
            advanceTimeBy(at - currentTime)
            assertEquals("not before ${at}ms", expected - 1, attempts())
            advanceTimeBy(1)
            assertEquals("at ${at}ms", expected, attempts())
        }
        assertEquals(RealtimeHealth.DEGRADED, sink.health.last())
    }

    @Test
    fun `the server's backoff multiplier stretches the waits`() = runTest {
        api.connectAnswer = api.connectAnswer.copy(policy = RealtimePolicy(reconnectBackoffMultiplier = 2.0))
        start()
        server.latest.drop()
        runCurrent()
        advanceTimeBy(1_999)
        assertEquals(1, server.sockets.size)
        advanceTimeBy(2)
        assertEquals(2, server.sockets.size)
    }

    @Test
    fun `the network coming back skips what is left of a backoff`() = runTest {
        server.refuseOpen = IOException("offline")
        val client = client()
        backgroundScope.launch { client.run("ws-1") }
        runCurrent()
        advanceTimeBy(1_001)
        advanceTimeBy(2_001)
        val before = api.connectIntents.size

        server.refuseOpen = null
        client.nudge()
        runCurrent()

        assertEquals(before + 1, api.connectIntents.size)
        assertEquals(RealtimeHealth.CONNECTED, sink.health.last())
    }

    @Test
    fun `tokens are rotated two minutes before they expire`() = runTest {
        api.connectAnswer = api.connectAnswer.copy(expiresAt = 30 * 60_000L)
        keepAlive()
        start()

        advanceTimeBy(28 * 60_000L - 1)
        assertEquals(1, server.sockets.size)
        advanceTimeBy(2)
        runCurrent()

        assertEquals(2, server.sockets.size)
        assertEquals(listOf("initial", "refresh"), api.connectIntents)
        assertTrue(server.sockets.first().closed)
    }

    @Test
    fun `a phone clock hours off does not rotate every ten seconds`() = runTest {
        // Expired an hour ago by this phone's clock.
        api.connectAnswer = api.connectAnswer.copy(expiresAt = -60 * 60_000L)
        keepAlive()
        start()
        advanceTimeBy(60_000)
        assertEquals(1, server.sockets.size)
    }

    @Test
    fun `a silent socket is taken for dead`() = runTest {
        start()
        advanceTimeBy(60_001)
        advanceTimeBy(1_001)
        assertEquals(2, server.sockets.size)
    }

    @Test
    fun `a server without realtime leaves the app polling and asks again later`() = runTest {
        api.connectAnswer = RealtimeConnect(vendor = "polling_builtin")
        start()

        assertTrue(server.sockets.isEmpty())
        assertEquals(RealtimeHealth.DEGRADED, sink.health.last())
        advanceTimeBy(300_001)
        assertEquals(2, api.connectIntents.size)
    }

    @Test
    fun `force_polling is obeyed`() = runTest {
        api.connectAnswer = api.connectAnswer.copy(policy = RealtimePolicy(forcePolling = true))
        start()
        assertTrue(server.sockets.isEmpty())
    }

    @Test
    fun `a revoked session ends realtime`() = runTest {
        api.failConnect = ApiError.Unauthorized
        val job = start()
        assertFalse(job.isActive)
        assertEquals(RealtimeHealth.IDLE, sink.health.last())
    }

    @Test
    fun `stopping closes the socket`() = runTest {
        val job = start()
        job.cancel()
        runCurrent()

        assertTrue(server.latest.closed)
        assertEquals(RealtimeHealth.IDLE, sink.health.last())
    }

    @Test
    fun `a terminal disconnect code waits at least thirty seconds`() = runTest {
        start()
        server.latest.push("""{"push":{"disconnect":{"code":3501,"reason":"bad request"}}}""")
        runCurrent()
        advanceTimeBy(29_000)
        assertEquals(1, server.sockets.size)
        advanceTimeBy(2_000)
        assertEquals(2, server.sockets.size)
    }
}
