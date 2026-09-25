package com.webyar.operator.core.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement

// The realtime negotiation, as `server/routes/realtime.ts` answers it. The
// same three calls the Mac and Windows apps make (`operator-connect`,
// `operator-inbox-subscribe`, `operator-presence-subscribe`): the server
// mints short-lived Centrifugo JWTs and names the node to open the socket
// on, and nothing about the protocol is specific to this platform.

/**
 * `POST /api/realtime/operator-connect`.
 *
 * `vendor` is the switch. Anything other than `centrifugo` — `polling_builtin`,
 * `supabase`, `disabled` — means there is no socket to open on this
 * deployment, and the app stays on its (foreground-only) delta polling.
 */
@Serializable
data class RealtimeConnect(
    val vendor: String? = null,
    @SerialName("ws_url") val wsUrl: String? = null,
    val token: String? = null,
    /** Epoch milliseconds. */
    @SerialName("expires_at") val expiresAt: Long? = null,
    @SerialName("effective_policy") val policy: RealtimePolicy? = null,
) {
    val isCentrifugo: Boolean
        get() = vendor == "centrifugo" && !wsUrl.isNullOrBlank() && !token.isNullOrBlank() &&
            policy?.forcePolling != true
}

/** The part of `effective_policy` a client acts on. */
@Serializable
data class RealtimePolicy(
    @SerialName("force_polling") val forcePolling: Boolean? = null,
    @SerialName("reconnect_backoff_multiplier") val reconnectBackoffMultiplier: Double? = null,
)

/** `POST /api/realtime/operator-{inbox,presence}-subscribe`. */
@Serializable
data class RealtimeSubscribe(
    val vendor: String? = null,
    val channel: String? = null,
    val token: String? = null,
    @SerialName("expires_at") val expiresAt: Long? = null,
) {
    val isUsable: Boolean
        get() = vendor == "centrifugo" && !channel.isNullOrBlank() && !token.isNullOrBlank()
}

/**
 * One publication's `data`: `{type, payload}` (`publishers/types.ts`).
 *
 * `payload` stays a [JsonElement] until [type] says what it is. A `message`
 * payload decodes as a [Message] — it is the same row the thread endpoint
 * returns, minus `updated_at` — and an `event` payload as [RealtimeEventPayload].
 */
@Serializable
data class RealtimeEnvelope(
    val type: String? = null,
    val payload: JsonElement? = null,
)

/**
 * An operator event: a status change, a claim, a spam flag, a call card.
 *
 * Only what the app acts on is decoded. None of these carry the new row, so
 * each one becomes a targeted re-read of the conversations it names — never
 * a reload of the inbox.
 */
@Serializable
data class RealtimeEventPayload(
    val kind: String? = null,
    @SerialName("conversation_id") val conversationId: String? = null,
    @SerialName("workspace_id") val workspaceId: String? = null,
    @SerialName("contact_id") val contactId: String? = null,
    /** Set on `outbound_delivery_failed`: which message's status moved. */
    @SerialName("message_id") val messageId: String? = null,
    val reason: String? = null,
)
