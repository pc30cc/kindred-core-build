package com.webyar.ai.core.realtime

import com.webyar.ai.core.Diag
import com.webyar.ai.core.model.Message
import com.webyar.ai.core.model.RealtimeConnect
import com.webyar.ai.core.model.RealtimeEnvelope
import com.webyar.ai.core.model.RealtimeEventPayload
import com.webyar.ai.core.model.RealtimeSubscribe
import com.webyar.ai.core.net.ApiError
import com.webyar.ai.core.net.WebyarApi
import com.webyar.ai.core.realtime.CentrifugoProtocol.StreamPosition
import com.webyar.ai.core.sync.RealtimeHealth
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.withContext
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlin.random.Random

/** Where the realtime client delivers what it hears. The sync coordinator, in the app. */
interface RealtimeSink {
    fun onMessage(workspaceId: String, message: Message)
    fun onEvent(workspaceId: String, event: RealtimeEventPayload)

    /**
     * The first session of this run is up and subscribed. There is no
     * position to recover from yet, so whatever was published before the
     * subscribe — in the second or two it took to negotiate, or during the
     * failed attempts before this one — reached nobody, and only a read
     * finds it.
     *
     * Not left to the screens' own first read: that one is made as the app
     * comes to the front, before the socket exists, and once the socket is
     * up the poll stops and the next safety read is ten minutes off. A
     * message in that window would sit unseen in the list for all of them.
     */
    fun onConnected() {}

    /**
     * The socket is back after having been up in this run. [recovered] is
     * true only when Centrifugo replayed every publication missed while it
     * was down.
     */
    fun onReconnected(recovered: Boolean)
    fun onHealth(health: RealtimeHealth)
}

/**
 * The operator's realtime connection to one workspace.
 *
 * The protocol is the platform's own, exactly as the Mac speaks it
 * (`Realtime.swift`): ask the API for a connection token and the node's
 * `ws_url` (`operator-connect`), for the inbox channel's subscription token
 * (`operator-inbox-subscribe`), the presence channel's
 * (`operator-presence-subscribe`) and the operator's own channel's
 * (`operator-user-subscribe`, team chat), open the socket, `connect`,
 * `subscribe`, answer every `{}`. Nothing here is specific to Android except what a phone
 * adds on top:
 *
 *  - **Backoff with jitter** between attempts — 1, 2, 4, 8, 15, 30 s, times
 *    the server's `reconnect_backoff_multiplier`, times 0.8–1.2 — cut short
 *    when the network comes back ([nudge]).
 *  - **Token rotation** two minutes before the earliest token expires, as the
 *    desktop clients do it: a new socket with fresh tokens (`intent=refresh`).
 *  - **Recovery**: every subscription is resumed from its last offset and
 *    epoch, so a rotation or a short drop replays the missed publications
 *    instead of costing a REST reconcile. Only when the server says it could
 *    not ([RealtimeSink.onReconnected] with `recovered = false`) does the
 *    sync layer reconcile from its cursors.
 *  - **Dedupe** of publications, bounded: a recovered replay can repeat what
 *    was already delivered.
 *
 * [run] runs until cancelled — which is how the app turns realtime off when
 * it goes to the background — and closes the socket on the way out.
 */
class RealtimeClient(
    private val api: WebyarApi,
    private val transport: RealtimeTransport,
    private val sink: RealtimeSink,
    private val clock: () -> Long = System::currentTimeMillis,
    private val random: Random = Random.Default,
    private val diag: Diag = Diag.Android,
    private val policy: RealtimeTiming = RealtimeTiming(),
    private val appVersion: String = "",
) {
    private val json = Json { ignoreUnknownKeys = true; explicitNulls = false; coerceInputValues = true }
    private val nudges = MutableSharedFlow<Unit>(extraBufferCapacity = 1)
    private val seen = SeenSet(policy.dedupeCapacity)

    /** The network came back: skip what is left of the current backoff. */
    fun nudge() {
        nudges.tryEmit(Unit)
    }

    private sealed interface Outcome {
        /** The server has no socket to offer: stay on polling and ask again later. */
        data object Unavailable : Outcome
        /** Tokens are about to expire: open a fresh socket now. */
        data object Rotate : Outcome
        data class Failed(val reason: String, val terminal: Boolean = false) : Outcome
        /** The session itself is gone; realtime has nothing to do until sign-in. */
        data object SignedOut : Outcome
    }

    suspend fun run(workspaceId: String) {
        val positions = HashMap<String, StreamPosition>()
        var failures = 0
        var everConnected = false
        var rotating = false
        sink.onHealth(RealtimeHealth.CONNECTING)
        try {
            while (true) {
                val intent = when {
                    rotating -> "refresh"
                    everConnected || failures > 0 -> "reconnect"
                    else -> "initial"
                }
                val outcome = session(workspaceId, intent, positions, everConnected) { everConnected = true; failures = 0 }
                rotating = false
                when (outcome) {
                    Outcome.Rotate -> {
                        diag.info(AREA, "rotating tokens")
                        rotating = true
                    }
                    Outcome.Unavailable -> {
                        sink.onHealth(RealtimeHealth.DEGRADED)
                        diag.info(AREA, "no realtime on this server; polling, asking again in ${policy.unavailableRetryMs / 1000}s")
                        waitOrNudge(policy.unavailableRetryMs)
                        failures = 0
                    }
                    Outcome.SignedOut -> {
                        diag.warn(AREA, "negotiation refused: signed out")
                        sink.onHealth(RealtimeHealth.DEGRADED)
                        return
                    }
                    is Outcome.Failed -> {
                        failures++
                        sink.onHealth(if (failures >= policy.degradedAfter) RealtimeHealth.DEGRADED else RealtimeHealth.CONNECTING)
                        val wait = backoff(failures, outcome.terminal)
                        diag.info(AREA, "disconnected (${outcome.reason}); attempt $failures, retry in ${wait}ms")
                        waitOrNudge(wait)
                    }
                }
            }
        } finally {
            sink.onHealth(RealtimeHealth.IDLE)
        }
    }

    private var multiplier = 1.0

    /** The delay before attempt [failures]+1, jittered so a fleet does not reconnect in step. */
    internal fun backoff(failures: Int, terminal: Boolean): Long {
        val steps = policy.backoffStepsMs
        val base = steps[(failures - 1).coerceIn(0, steps.lastIndex)]
        val scaled = (base * multiplier).coerceAtMost(policy.backoffCapMs.toDouble())
        val jittered = (scaled * (0.8 + random.nextDouble() * 0.4)).toLong()
        return if (terminal) jittered.coerceAtLeast(policy.terminalFloorMs) else jittered
    }

    private suspend fun waitOrNudge(ms: Long) {
        withTimeoutOrNull(ms) { nudges.first() }
    }

    private suspend fun session(
        workspaceId: String,
        intent: String,
        positions: MutableMap<String, StreamPosition>,
        reconnecting: Boolean,
        connected: () -> Unit,
    ): Outcome {
        val tokens = try {
            negotiate(workspaceId, intent) ?: return Outcome.Unavailable
        } catch (e: CancellationException) {
            throw e
        } catch (e: ApiError) {
            if (e.isAuthFailure) return Outcome.SignedOut
            return Outcome.Failed("negotiate ${e.javaClass.simpleName}")
        }
        multiplier = (tokens.connect.policy?.reconnectBackoffMultiplier ?: 1.0).coerceIn(1.0, 4.0)

        val url = tokens.connect.wsUrl.orEmpty()
        val socket = try {
            withTimeoutOrNull(policy.connectTimeoutMs) { transport.open(url) }
                ?: return Outcome.Failed("open timed out")
        } catch (e: CancellationException) {
            throw e
        } catch (e: Throwable) {
            return Outcome.Failed("open ${e.javaClass.simpleName}")
        }

        try {
            socket.send(CentrifugoProtocol.connect(1, tokens.connect.token.orEmpty(), CLIENT_NAME, appVersion))
            val connectReply = awaitReply(socket, 1, workspaceId) ?: return Outcome.Failed("no connect reply")
            connectReply.error?.let { return Outcome.Failed("connect error ${it.code}", terminal = it.code == 101) }

            val inbox = tokens.inbox
            val inboxChannel = inbox.channel.orEmpty()
            val recovered = subscribe(socket, 2, inbox, positions, workspaceId)
                ?: return Outcome.Failed("inbox subscribe refused")

            // Presence is advisory: an error here costs the green dot, not
            // the inbox, so it is logged and the session carries on.
            tokens.presence?.let { presence ->
                if (subscribe(socket, 3, presence, positions, workspaceId) == null) {
                    diag.warn(AREA, "presence subscribe refused")
                }
            }
            // So is the operator's own channel: without it the team chat
            // falls back to its poll, and the inbox does not notice.
            tokens.user?.let { user ->
                if (subscribe(socket, 4, user, positions, workspaceId) == null) {
                    diag.warn(AREA, "own channel subscribe refused")
                }
            }

            connected()
            sink.onHealth(RealtimeHealth.CONNECTED)
            diag.info(AREA, "connected ($intent)${if (recovered) ", recovered" else ""}")
            if (reconnecting) sink.onReconnected(recovered) else sink.onConnected()

            val rotateAt = rotationTime(tokens.earliestExpiry())
            return read(socket, workspaceId, inboxChannel, positions, rotateAt)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Throwable) {
            return Outcome.Failed("socket ${e.javaClass.simpleName}")
        } finally {
            // Closed even when the run is being cancelled — which is exactly
            // when it matters: the app went to the background.
            withContext(NonCancellable) { socket.close() }
        }
    }

    /**
     * When to rotate: [RealtimeTiming.rotateBeforeExpiryMs] before the
     * earliest token expires. The expiry is the server's clock and the
     * phone's may be wrong by hours; a lifetime that comes out implausible
     * (under four minutes — the server's floor is five — or over three
     * hours) is replaced by a conservative guess rather than trusted, which
     * is what keeps a phone set an hour fast from rotating every ten seconds.
     */
    internal fun rotationTime(expiresAt: Long?): Long? {
        expiresAt ?: return null
        val now = clock()
        var lifetime = expiresAt - now
        if (lifetime < PLAUSIBLE_MIN_LIFETIME_MS || lifetime > PLAUSIBLE_MAX_LIFETIME_MS) {
            lifetime = policy.assumedLifetimeMs
        }
        return now + (lifetime - policy.rotateBeforeExpiryMs).coerceAtLeast(policy.minSessionMs)
    }

    private class Tokens(
        val connect: RealtimeConnect,
        val inbox: RealtimeSubscribe,
        val presence: RealtimeSubscribe?,
        val user: RealtimeSubscribe?,
    ) {
        fun earliestExpiry(): Long? =
            listOfNotNull(connect.expiresAt, inbox.expiresAt, presence?.expiresAt, user?.expiresAt).minOrNull()
    }

    /** Fresh tokens for every attempt, as the desktop clients mint them. Null when there is no socket to be had. */
    private suspend fun negotiate(workspaceId: String, intent: String): Tokens? {
        val connect = api.realtimeConnect(workspaceId, intent)
        if (!connect.isCentrifugo) return null
        val inbox = api.realtimeInboxSubscribe(workspaceId)
        if (!inbox.isUsable) return null
        val presence = optionalGrant { api.realtimePresenceSubscribe(workspaceId) }
        // A server that predates the operator's own channel answers 404:
        // no grant, and the team chat keeps to its poll.
        val user = optionalGrant { api.realtimeUserSubscribe(workspaceId) }
        return Tokens(connect, inbox, presence, user)
    }

    /** A grant the session can do without: any failure is no grant. */
    private suspend fun optionalGrant(ask: suspend () -> RealtimeSubscribe): RealtimeSubscribe? =
        try {
            ask().takeIf { it.isUsable }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Throwable) {
            null
        }

    /**
     * Subscribes, resuming from the channel's last position when there is
     * one. Returns whether the server recovered everything since then, or
     * null when the subscription was refused.
     */
    private suspend fun subscribe(
        socket: RealtimeSocket,
        id: Int,
        grant: RealtimeSubscribe,
        positions: MutableMap<String, StreamPosition>,
        workspaceId: String,
    ): Boolean? {
        val channel = grant.channel.orEmpty()
        val from = positions[channel]
        socket.send(CentrifugoProtocol.subscribe(id, channel, grant.token.orEmpty(), from))
        var reply = awaitReply(socket, id, workspaceId) ?: return null
        if (reply.error?.code == CentrifugoProtocol.ERROR_UNRECOVERABLE_POSITION) {
            // History no longer reaches that far back. Subscribe plainly; the
            // caller reconciles over REST because this is not "recovered".
            positions.remove(channel)
            socket.send(CentrifugoProtocol.subscribe(id + 10, channel, grant.token.orEmpty(), null))
            reply = awaitReply(socket, id + 10, workspaceId) ?: return null
        }
        val error = reply.error
        if (error != null && error.code != CentrifugoProtocol.ERROR_ALREADY_SUBSCRIBED) return null
        val result = reply.result
        result?.publications?.forEach { deliver(workspaceId, channel, it, positions) }
        if (result?.epoch != null && result.offset != null) {
            positions[channel] = StreamPosition(result.offset, result.epoch)
        }
        return from != null && result?.recovered == true
    }

    /** Reads until the reply to [id], answering pings and delivering publications meanwhile. */
    private suspend fun awaitReply(socket: RealtimeSocket, id: Int, workspaceId: String): Inbound.Reply? =
        withTimeoutOrNull(policy.replyTimeoutMs) {
            var reply: Inbound.Reply? = null
            var ended = false
            while (reply == null && !ended) {
                val text = socket.receive()
                if (text == null) {
                    ended = true
                } else {
                    for (frame in CentrifugoProtocol.parse(text)) {
                        when (frame) {
                            Inbound.Ping -> socket.send(CentrifugoProtocol.PONG)
                            is Inbound.Reply -> if (frame.id == id) reply = frame
                            is Inbound.Publication -> deliver(workspaceId, frame.channel, frame, null)
                            is Inbound.Disconnect -> ended = true
                            else -> Unit
                        }
                    }
                }
            }
            reply
        }

    /**
     * The session proper: publications in, pings answered, until the socket
     * closes, goes quiet for longer than two ping intervals, or it is time to
     * rotate the tokens.
     */
    private suspend fun read(
        socket: RealtimeSocket,
        workspaceId: String,
        inboxChannel: String,
        positions: MutableMap<String, StreamPosition>,
        rotateAt: Long?,
    ): Outcome {
        while (true) {
            val untilRotate = rotateAt?.let { it - clock() }
            if (untilRotate != null && untilRotate <= 0) return Outcome.Rotate
            val wait = minOf(policy.staleAfterMs, untilRotate ?: Long.MAX_VALUE)
            val next: Any? = withTimeoutOrNull(wait) { socket.receive() ?: Closed }
            when (next) {
                null -> {
                    if (rotateAt != null && clock() >= rotateAt) return Outcome.Rotate
                    return Outcome.Failed("stale: no ping in ${policy.staleAfterMs / 1000}s")
                }
                Closed -> {
                    val code = socket.closeCode()
                    return Outcome.Failed("closed ${code ?: "-"}", terminal = code != null && CentrifugoProtocol.isTerminal(code))
                }
                is String -> for (frame in CentrifugoProtocol.parse(next)) {
                    when (frame) {
                        Inbound.Ping -> socket.send(CentrifugoProtocol.PONG)
                        is Inbound.Publication -> deliver(workspaceId, frame.channel.ifEmpty { inboxChannel }, frame, positions)
                        is Inbound.Disconnect ->
                            return Outcome.Failed(
                                "server disconnect ${frame.code}",
                                terminal = CentrifugoProtocol.isTerminal(frame.code),
                            )
                        is Inbound.Unsubscribed -> if (frame.channel == inboxChannel) {
                            return Outcome.Failed("unsubscribed ${frame.code}")
                        }
                        else -> Unit
                    }
                }
                else -> Unit
            }
        }
    }

    /**
     * One publication: its position noted, then — unless it was already
     * delivered — decoded and handed to the sink. Only the inbox channel's
     * and the operator's own channel's publications carry anything the app
     * reads; presence joins and leaves are the server's business.
     */
    private fun deliver(
        workspaceId: String,
        channel: String,
        publication: Inbound.Publication,
        positions: MutableMap<String, StreamPosition>?,
    ) {
        if (positions != null && publication.offset != null) {
            positions[channel]?.let { positions[channel] = it.copy(offset = publication.offset) }
        }
        if (channel.isNotEmpty() && !channel.endsWith(":inbox") && !channel.contains(":user:")) return
        val data = publication.data ?: return
        val envelope = runCatching { json.decodeFromJsonElement(RealtimeEnvelope.serializer(), data) }.getOrNull() ?: return
        val payload = envelope.payload ?: return
        if (!seen.add(dedupeKey(channel, publication.offset, positions?.get(channel)?.epoch, envelope.type, payload))) return
        when (envelope.type) {
            "message" -> runCatching { json.decodeFromJsonElement(Message.serializer(), payload) }
                .getOrNull()
                ?.let { sink.onMessage(workspaceId, it) }
            "event" -> runCatching { json.decodeFromJsonElement(RealtimeEventPayload.serializer(), payload) }
                .getOrNull()
                ?.let { sink.onEvent(workspaceId, it) }
            // `typing` has no screen here yet; `seen` is declared and never sent.
            else -> Unit
        }
    }

    /**
     * What makes two publications the same one.
     *
     * For an event, its place in the stream when it has one: a replay after
     * a reconnect is the same offset, and two events that merely read alike
     * are not the same event. Keyed on the payload alone, a second hand-over
     * or take-over with the same reason and actor in one session would be
     * silently dropped — several server events carry no timestamp to tell
     * them apart.
     *
     * For a message, the whole payload, not the message id: the server
     * republishes a call card under the SAME id when its status changes
     * (`invitations.ts`), and that is news.
     */
    private fun dedupeKey(
        channel: String,
        offset: Long?,
        epoch: String?,
        type: String?,
        payload: JsonElement,
    ): String =
        // A message is its row: the same payload twice is the same state,
        // whatever the stream says. An event is a happening, and two alike
        // are two — unless they are the same place in the stream.
        if (type == "event" && offset != null) "$channel:${epoch.orEmpty()}:$offset"
        else "$type:${payload.hashCode()}:${payload.toString().length}"

    private companion object {
        const val AREA = "Realtime"
        const val PLAUSIBLE_MIN_LIFETIME_MS = 4 * 60_000L
        const val PLAUSIBLE_MAX_LIFETIME_MS = 3 * 60 * 60_000L
        const val CLIENT_NAME = "webyar-android"
    }

    /** The socket's end, as distinct from a quiet socket. */
    private object Closed
}

/** The timings the client runs on; tests shrink them. */
data class RealtimeTiming(
    val backoffStepsMs: List<Long> = listOf(1_000, 2_000, 4_000, 8_000, 15_000, 30_000),
    val backoffCapMs: Long = 60_000,
    /** A server that said "go away" is not asked again for at least this long. */
    val terminalFloorMs: Long = 30_000,
    val unavailableRetryMs: Long = 300_000,
    val connectTimeoutMs: Long = 10_000,
    val replyTimeoutMs: Long = 10_000,
    /** Two missed 25 s pings and a margin: the connection is dead. */
    val staleAfterMs: Long = 60_000,
    val rotateBeforeExpiryMs: Long = 120_000,
    /** What a token's lifetime is taken to be when the phone's clock cannot be trusted to say. */
    val assumedLifetimeMs: Long = 25 * 60_000L,
    val minSessionMs: Long = 10_000,
    /** Failures in a row before polling takes over. */
    val degradedAfter: Int = 2,
    val dedupeCapacity: Int = 512,
)

/** A bounded set that forgets its oldest entries — never an unbounded `Set`. */
internal class SeenSet(private val capacity: Int) {
    private val entries = object : LinkedHashMap<String, Unit>(capacity, 0.75f, false) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, Unit>?): Boolean = size > capacity
    }

    /** True when [key] was not already present. */
    @Synchronized
    fun add(key: String): Boolean = entries.put(key, Unit) == null

    @get:Synchronized
    val size: Int get() = entries.size
}
