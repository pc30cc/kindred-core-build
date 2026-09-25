package com.webyar.operator.core.realtime

import io.ktor.client.HttpClient
import io.ktor.client.engine.okhttp.OkHttp
import io.ktor.client.plugins.websocket.DefaultClientWebSocketSession
import io.ktor.client.plugins.websocket.WebSockets
import io.ktor.client.plugins.websocket.webSocketSession
import io.ktor.client.request.header
import io.ktor.websocket.CloseReason
import io.ktor.websocket.Frame
import io.ktor.websocket.close
import io.ktor.websocket.readText
import kotlinx.coroutines.channels.ClosedReceiveChannelException
import kotlinx.coroutines.withTimeoutOrNull

/**
 * A WebSocket, reduced to what the realtime client needs from one: text in,
 * text out, and how it ended.
 *
 * An interface so the client's whole state machine — backoff, rotation,
 * recovery, dedupe — runs in the JVM tests against a scripted server, on a
 * virtual clock, with no network.
 */
interface RealtimeSocket {
    /** The next text message, or null once the socket has closed. */
    suspend fun receive(): String?

    suspend fun send(text: String)

    suspend fun close()

    /** The close code the server sent, when it sent one. */
    suspend fun closeCode(): Int?
}

fun interface RealtimeTransport {
    suspend fun open(url: String): RealtimeSocket
}

/**
 * Ktor's WebSocket client on the OkHttp engine — the same engine the REST
 * client runs on — in a client of its own.
 *
 * Its own, and deliberately bare: the REST client's `HttpTimeout` would
 * count a socket that is open for half an hour as a request that timed out,
 * and its logging would write every frame — message bodies included — to
 * logcat in a debug build. OkHttp clears the socket's read timeout itself
 * once a WebSocket is upgraded; liveness is the server's `{}` ping every
 * 25 s, which the client answers and watches for.
 */
class KtorRealtimeTransport : RealtimeTransport {

    private val client = HttpClient(OkHttp) {
        install(WebSockets)
    }

    override suspend fun open(url: String): RealtimeSocket {
        val session = client.webSocketSession(url) {
            header("X-Client-Platform", "android")
        }
        return KtorSocket(session)
    }

    private class KtorSocket(private val session: DefaultClientWebSocketSession) : RealtimeSocket {
        override suspend fun receive(): String? {
            while (true) {
                val frame = try {
                    session.incoming.receive()
                } catch (_: ClosedReceiveChannelException) {
                    return null
                }
                when (frame) {
                    is Frame.Text -> return frame.readText()
                    is Frame.Close -> return null
                    // Ktor answers protocol pings itself; binary frames are
                    // not part of the JSON protocol.
                    else -> continue
                }
            }
        }

        override suspend fun send(text: String) {
            session.outgoing.send(Frame.Text(text))
        }

        override suspend fun close() {
            runCatching { session.close(CloseReason(CloseReason.Codes.NORMAL, "")) }
        }

        override suspend fun closeCode(): Int? =
            withTimeoutOrNull(500) { runCatching { session.closeReason.await()?.code?.toInt() }.getOrNull() }
    }
}
