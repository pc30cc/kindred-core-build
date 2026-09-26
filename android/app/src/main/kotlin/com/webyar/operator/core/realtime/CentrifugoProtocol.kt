package com.webyar.operator.core.realtime

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put

/**
 * Centrifugo's client protocol, JSON flavour — the same frames the Mac,
 * Windows and web clients send (`macos/Webyar/Core/Realtime/Realtime.swift`,
 * `src/realtime/providers/centrifugo.ts`), against the server's v5.
 *
 * Commands are one JSON object with an `id`; replies carry the same `id`;
 * server pushes have no `id` and a `push` key; an empty object `{}` is a
 * ping and must be answered with one. Several frames may share one
 * WebSocket message, separated by newlines.
 *
 * Pure functions, so every frame this app sends and every shape it can
 * receive is pinned by a JVM test with no socket in sight.
 */
object CentrifugoProtocol {

    private val json = Json { ignoreUnknownKeys = true }

    /** Where a subscription had read up to — what `recover` resumes from. */
    data class StreamPosition(val offset: Long, val epoch: String)

    fun connect(id: Int, token: String, name: String, version: String): String =
        buildJsonObject {
            put("id", id)
            put(
                "connect",
                buildJsonObject {
                    put("token", token)
                    put("name", name)
                    put("version", version)
                },
            )
        }.toString()

    /**
     * Subscribes, and when [recover] is given asks the server for everything
     * published on the channel since that position. The namespace has
     * `force_recovery` and a 50-publication / 300 s history
     * (`deploy/centrifugo/config.json`), so a short disconnect — a token
     * rotation, a tunnel — comes back with nothing missed and no REST
     * reconcile at all.
     */
    fun subscribe(id: Int, channel: String, token: String, recover: StreamPosition?): String =
        buildJsonObject {
            put("id", id)
            put(
                "subscribe",
                buildJsonObject {
                    put("channel", channel)
                    put("token", token)
                    if (recover != null) {
                        put("recover", true)
                        put("offset", recover.offset)
                        put("epoch", recover.epoch)
                    }
                },
            )
        }.toString()

    /** The answer to a ping. */
    const val PONG: String = "{}"

    /** Every frame in one WebSocket message. A frame that will not parse is [Inbound.Unknown], never a crash. */
    fun parse(message: String): List<Inbound> =
        message.split('\n').map { it.trim() }.filter { it.isNotEmpty() }.map(::parseFrame)

    private fun parseFrame(text: String): Inbound {
        val frame = runCatching { json.parseToJsonElement(text).jsonObject }.getOrNull() ?: return Inbound.Unknown
        if (frame.isEmpty()) return Inbound.Ping

        val id = frame["id"]?.jsonPrimitive?.intOrNull
        if (id != null && id > 0) {
            val error = (frame["error"] as? JsonObject)?.let {
                ReplyError(
                    code = it["code"]?.jsonPrimitive?.intOrNull ?: 0,
                    message = it["message"]?.jsonPrimitive?.contentOrNull,
                )
            }
            val result = (frame["connect"] ?: frame["subscribe"] ?: frame["refresh"]) as? JsonObject
            return Inbound.Reply(id, error, result?.let(::subscribeResult))
        }

        val push = frame["push"] as? JsonObject ?: return Inbound.Unknown
        val channel = push["channel"]?.jsonPrimitive?.contentOrNull
        (push["pub"] as? JsonObject)?.let { pub ->
            return Inbound.Publication(
                channel = channel.orEmpty(),
                data = pub["data"],
                offset = pub["offset"]?.jsonPrimitive?.longOrNull,
            )
        }
        (push["disconnect"] as? JsonObject)?.let {
            return Inbound.Disconnect(
                code = it["code"]?.jsonPrimitive?.intOrNull ?: 0,
                reason = it["reason"]?.jsonPrimitive?.contentOrNull,
            )
        }
        (push["unsubscribe"] as? JsonObject)?.let {
            return Inbound.Unsubscribed(channel.orEmpty(), it["code"]?.jsonPrimitive?.intOrNull ?: 0)
        }
        return Inbound.Unknown
    }

    private fun subscribeResult(obj: JsonObject): ReplyResult = ReplyResult(
        recoverable = obj["recoverable"]?.jsonPrimitive?.contentOrNull == "true",
        recovered = obj["recovered"]?.jsonPrimitive?.contentOrNull == "true",
        wasRecovering = obj["was_recovering"]?.jsonPrimitive?.contentOrNull == "true",
        epoch = obj["epoch"]?.jsonPrimitive?.contentOrNull,
        offset = obj["offset"]?.jsonPrimitive?.longOrNull,
        publications = (obj["publications"] as? kotlinx.serialization.json.JsonArray)
            ?.mapNotNull { element ->
                val pub = element as? JsonObject ?: return@mapNotNull null
                Inbound.Publication(
                    channel = "",
                    data = pub["data"],
                    offset = pub["offset"]?.jsonPrimitive?.longOrNull,
                )
            }
            .orEmpty(),
    )

    /**
     * Whether a disconnect code asks the client not to come straight back.
     * Centrifugo's convention: 3500–3999 and 4500–4999 are terminal; the
     * rest mean "reconnect".
     */
    fun isTerminal(code: Int): Boolean = code in 3500..3999 || code in 4500..4999

    /** `token expired` — fresh tokens fix it; the next attempt mints them. */
    const val ERROR_TOKEN_EXPIRED = 109

    /** The position asked to recover from is gone from history; subscribe plainly. */
    const val ERROR_UNRECOVERABLE_POSITION = 112

    /** Already subscribed on this connection: harmless, as the web client treats it. */
    const val ERROR_ALREADY_SUBSCRIBED = 105
}

/** One frame from the server. */
sealed interface Inbound {
    data object Ping : Inbound
    data class Reply(val id: Int, val error: ReplyError?, val result: ReplyResult?) : Inbound
    data class Publication(val channel: String, val data: JsonElement?, val offset: Long?) : Inbound
    data class Disconnect(val code: Int, val reason: String?) : Inbound
    data class Unsubscribed(val channel: String, val code: Int) : Inbound
    data object Unknown : Inbound
}

data class ReplyError(val code: Int, val message: String?)

data class ReplyResult(
    val recoverable: Boolean,
    val recovered: Boolean,
    val wasRecovering: Boolean,
    val epoch: String?,
    val offset: Long?,
    val publications: List<Inbound.Publication>,
)
