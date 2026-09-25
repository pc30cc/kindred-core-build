package com.webyar.operator.testing

import com.webyar.operator.core.model.Message
import com.webyar.operator.core.model.RealtimeEventPayload
import com.webyar.operator.core.realtime.RealtimeSink
import com.webyar.operator.core.realtime.RealtimeSocket
import com.webyar.operator.core.realtime.RealtimeTransport
import com.webyar.operator.core.sync.RealtimeHealth
import kotlinx.coroutines.channels.Channel
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull

/**
 * A Centrifugo v5 that speaks just enough of the JSON protocol for the
 * client's tests: it answers `connect` and `subscribe`, keeps an epoch and
 * an offset per channel, and can recover — or refuse to — on resubscribe.
 */
class FakeCentrifugo {
    val sockets = mutableListOf<FakeSocket>()
    val openedUrls = mutableListOf<String>()

    /** Whether a resubscribe with `recover` is answered `recovered: true`. */
    var canRecover = true

    /** Opening a socket throws this, when set. */
    var refuseOpen: Throwable? = null

    val epoch = "epoch-1"
    private val offsets = HashMap<String, Long>()

    val transport = RealtimeTransport { url ->
        refuseOpen?.let { throw it }
        openedUrls += url
        FakeSocket(this).also { sockets += it }
    }

    val latest: FakeSocket get() = sockets.last()

    fun offset(channel: String): Long = offsets[channel] ?: 0L

    /** Publishes on the latest socket, advancing the channel's offset. */
    fun publish(channel: String, data: String) {
        val next = offset(channel) + 1
        offsets[channel] = next
        latest.push("""{"push":{"channel":"$channel","pub":{"data":$data,"offset":$next}}}""")
    }

    fun messageData(id: String, conversationId: String, body: String, extra: String = ""): String =
        """{"type":"message","payload":{"id":"$id","conversation_id":"$conversationId","sender_type":"contact","body":"$body","created_at":"2026-09-25T10:00:00Z"$extra}}"""

    fun eventData(kind: String, conversationId: String): String =
        """{"type":"event","payload":{"kind":"$kind","conversation_id":"$conversationId","workspace_id":"ws-1"}}"""

    internal fun reply(socket: FakeSocket, frame: JsonObject) {
        val id = frame["id"]?.jsonPrimitive?.intOrNull ?: return
        frame["connect"]?.let {
            socket.push("""{"id":$id,"connect":{"client":"c-1","version":"5.4.5","ping":25,"pong":true}}""")
            return
        }
        val subscribe = frame["subscribe"] as? JsonObject ?: return
        val channel = subscribe["channel"]?.jsonPrimitive?.contentOrNull.orEmpty()
        socket.subscribes += subscribe
        val recovering = subscribe["recover"]?.jsonPrimitive?.booleanOrNull == true
        val from = subscribe["offset"]?.jsonPrimitive?.longOrNull
        if (recovering && !canRecover) {
            socket.push("""{"id":$id,"subscribe":{"recoverable":true,"epoch":"$epoch","offset":${offset(channel)},"recovered":false,"was_recovering":true}}""")
            return
        }
        val recovered = recovering && from != null
        socket.push("""{"id":$id,"subscribe":{"recoverable":true,"epoch":"$epoch","offset":${offset(channel)},"recovered":$recovered,"was_recovering":$recovering}}""")
    }
}

class FakeSocket(private val server: FakeCentrifugo) : RealtimeSocket {
    val sent = mutableListOf<String>()
    val subscribes = mutableListOf<JsonObject>()
    private val inbox = Channel<String?>(Channel.UNLIMITED)
    var closed = false
        private set
    private var code: Int? = null

    override suspend fun receive(): String? = if (closed) null else inbox.receive()

    override suspend fun send(text: String) {
        sent += text
        val frame = runCatching { Json.parseToJsonElement(text).jsonObject }.getOrNull() ?: return
        server.reply(this, frame)
    }

    override suspend fun close() {
        closed = true
        inbox.trySend(null)
    }

    override suspend fun closeCode(): Int? = code

    fun push(text: String) {
        inbox.trySend(text)
    }

    fun ping() = push("{}")

    /** The server hangs up. */
    fun drop(code: Int? = null) {
        this.code = code
        inbox.trySend(null)
    }

    val pongs: Int get() = sent.count { it == "{}" }
}

/** What reached the app from the socket. */
class RecordingSink : RealtimeSink {
    val messages = mutableListOf<Message>()
    val events = mutableListOf<RealtimeEventPayload>()
    val reconnects = mutableListOf<Boolean>()
    val health = mutableListOf<RealtimeHealth>()

    override fun onMessage(workspaceId: String, message: Message) {
        messages += message
    }

    override fun onEvent(workspaceId: String, event: RealtimeEventPayload) {
        events += event
    }

    override fun onReconnected(recovered: Boolean) {
        reconnects += recovered
    }

    override fun onHealth(health: RealtimeHealth) {
        this.health += health
    }
}
