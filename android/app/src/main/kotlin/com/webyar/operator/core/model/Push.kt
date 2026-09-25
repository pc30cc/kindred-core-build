package com.webyar.operator.core.model

import kotlinx.serialization.EncodeDefault
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * `POST /api/push/devices` — this phone, for this operator.
 *
 * The server upserts on `(user_id, device_id)` and first deletes any OTHER
 * user's row holding the same `push_token` (`server/services/push/devices.ts`),
 * so a phone handed from one operator to another can never keep notifying
 * the first one. `user_id` is never sent: it is the session's.
 *
 * `platform` and `transport` carry [EncodeDefault] for the reason spelled
 * out on `LoginBody.client`: with `encodeDefaults = false`, a property equal
 * to its default is left out of the JSON, and these two must always be sent.
 */
@Serializable
data class PushDeviceRegistration(
    @SerialName("push_token") val pushToken: String,
    /** Stable for this install: `android-<uuid>`, kept in DataStore. */
    @SerialName("device_id") val deviceId: String,
    @SerialName("device_name") val deviceName: String? = null,
    @SerialName("app_version") val appVersion: String? = null,
    /** `granted` | `denied` | `prompt` — the three the server accepts. */
    @SerialName("permission_status") val permissionStatus: String? = null,
    /** The workspace in front of the operator, as iOS sends it. */
    @SerialName("workspace_id") val workspaceId: String? = null,
    @EncodeDefault(EncodeDefault.Mode.ALWAYS) val platform: String = "android",
    @EncodeDefault(EncodeDefault.Mode.ALWAYS) val transport: String = "fcm",
)

@Serializable
data class PushDeviceResponse(
    val ok: Boolean? = null,
    @SerialName("device_id") val deviceId: String? = null,
    /** False when the server has no FCM credentials: registering changes nothing. */
    @SerialName("push_enabled") val pushEnabled: Boolean? = null,
)

@Serializable
data class PushDeviceUnregister(@SerialName("device_id") val deviceId: String)
