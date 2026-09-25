package com.webyar.operator.core.push

import com.webyar.operator.core.Diag
import com.webyar.operator.core.model.PushDeviceRegistration
import com.webyar.operator.core.net.ApiError
import com.webyar.operator.core.net.WebyarApi
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.security.MessageDigest
import java.util.UUID

/** Where the FCM token comes from. Firebase in the app; a fake in the tests. */
interface PushTokens {
    /** The current token, minting one if needed. Null when push is not available in this build. */
    suspend fun current(): String?

    /**
     * Forgets the token, so the next one is new. Done at sign-out: whatever
     * a stale message addressed to the old token says, it can no longer
     * reach this phone.
     */
    suspend fun delete()
}

/** What the registrar keeps between launches — plain values, no credentials. */
interface PushState {
    suspend fun deviceId(): String?
    suspend fun setDeviceId(value: String)
    /** A digest of the last registration that landed, and when. */
    suspend fun lastRegistration(): Pair<String, Long>?
    suspend fun setLastRegistration(fingerprint: String?, at: Long)
    /** Who the phone is registered for, so a background token rotation can re-register without the UI. */
    suspend fun session(): PushSession?
    suspend fun setSession(session: PushSession?)
}

/** The operator and workspace a registration speaks for. */
data class PushSession(val accountId: String, val workspaceId: String?)

/** What a registration found; for the log and the tests. */
enum class PushResult { REGISTERED, UNCHANGED, UNREGISTERED, NO_TOKEN, NOT_PERMITTED, SIGNED_OUT, RETRY_LATER, UNAVAILABLE }

/**
 * This phone's push registration, kept true.
 *
 * The same endpoint and the same semantics as iOS's `PushController`
 * (`POST /api/push/devices`), with Android's own fields: `platform=android`,
 * `transport=fcm`, a stable per-install `device_id`, the notification
 * permission as the system reports it.
 *
 * **It registers only when all of these hold**: somebody is signed in, this
 * build has Firebase, and the operator allows notifications. A phone that
 * does not allow them is UNregistered rather than registered as denied —
 * iOS's rule, and the honest one: the server should not believe a device
 * will show what it sends.
 *
 * **It re-registers** when anything in the registration changes — a new
 * token (rotation, reinstall), a different workspace, the permission, the
 * app version — and otherwise at most weekly, which keeps the row's
 * `last_seen_at` meaningful. A digest of the last registration that landed
 * is what "changed" is measured against.
 *
 * **Sign-out** unregisters BEFORE the session is revoked (the route needs
 * it, and the server keeps devices apart from sessions on purpose), then
 * deletes the token. The server's own rule — a token registered by another
 * user is taken from whoever had it — covers the rest: User A's
 * notifications cannot reach User B on the same phone.
 */
class PushRegistrar(
    private val api: WebyarApi,
    private val tokens: PushTokens,
    private val state: PushState,
    private val permission: () -> String,
    private val device: DeviceInfo,
    private val clock: () -> Long = System::currentTimeMillis,
    private val diag: Diag = Diag.Android,
    /** Hands a failed registration to WorkManager to try again with a network. */
    private val scheduleRetry: () -> Unit = {},
) {
    private val lock = Mutex()

    data class DeviceInfo(val name: String, val appVersion: String)

    suspend fun deviceId(): String = state.deviceId() ?: ("android-" + UUID.randomUUID()).also { state.setDeviceId(it) }

    /** Signed in, or moved to another workspace. */
    suspend fun bind(session: PushSession?, reason: String): PushResult {
        state.setSession(session)
        return sync(reason)
    }

    /**
     * Brings the server's view of this device in line with this phone's.
     * Safe to call as often as anything changes; it asks the server only
     * when the registration it would send is not the one that last landed.
     */
    suspend fun sync(reason: String): PushResult = lock.withLock {
        val session = state.session() ?: return@withLock PushResult.SIGNED_OUT
        val allowed = permission()
        if (allowed != "granted") {
            val had = state.lastRegistration() != null
            if (had) {
                val removed = unregisterQuietly()
                if (!removed) return@withLock PushResult.RETRY_LATER
                state.setLastRegistration(null, clock())
                diag.info(AREA, "notifications not allowed ($allowed); unregistered ($reason)")
                return@withLock PushResult.UNREGISTERED
            }
            return@withLock PushResult.NOT_PERMITTED
        }
        val token = try {
            tokens.current()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Throwable) {
            diag.warn(AREA, "no FCM token yet: ${e.javaClass.simpleName}")
            scheduleRetry()
            return@withLock PushResult.RETRY_LATER
        } ?: return@withLock PushResult.UNAVAILABLE

        val registration = PushDeviceRegistration(
            pushToken = token,
            deviceId = deviceId(),
            deviceName = device.name,
            appVersion = device.appVersion,
            permissionStatus = allowed,
            workspaceId = session.workspaceId,
        )
        val fingerprint = fingerprint(session, registration)
        val last = state.lastRegistration()
        if (last != null && last.first == fingerprint && clock() - last.second < REFRESH_MS) {
            return@withLock PushResult.UNCHANGED
        }
        try {
            val answer = api.registerPushDevice(registration)
            state.setLastRegistration(fingerprint, clock())
            // The token is never logged; its digest's first characters are
            // enough to tell two registrations apart in a field report.
            diag.info(
                AREA,
                "FCM token registered ($reason), token#${fingerprint.take(6)}, " +
                    "server push ${if (answer.pushEnabled == false) "NOT configured" else "on"}",
            )
            PushResult.REGISTERED
        } catch (e: CancellationException) {
            throw e
        } catch (e: ApiError) {
            if (e.isAuthFailure) return@withLock PushResult.SIGNED_OUT
            diag.warn(AREA, "registration failed ($reason): ${e.javaClass.simpleName}")
            scheduleRetry()
            PushResult.RETRY_LATER
        }
    }

    /** FCM handed out a new token. The next sync registers it. */
    suspend fun onNewToken(): PushResult = sync("token rotated")

    /**
     * Before the session is revoked: this device stops receiving this
     * operator's notifications. Best effort — a phone offline at sign-out
     * still deletes its token afterwards, which is what actually stops
     * delivery.
     */
    suspend fun beforeSignOut() {
        lock.withLock {
            if (state.lastRegistration() != null || state.session() != null) {
                val removed = unregisterQuietly()
                diag.info(AREA, "sign-out: device ${if (removed) "unregistered" else "could not be unregistered"}")
            }
        }
    }

    /** After the session is gone: forget who this phone was registered for, and the token. */
    suspend fun afterSignOut() {
        lock.withLock {
            state.setSession(null)
            state.setLastRegistration(null, clock())
        }
        try {
            tokens.delete()
            diag.info(AREA, "sign-out: FCM token deleted")
        } catch (e: CancellationException) {
            throw e
        } catch (e: Throwable) {
            diag.warn(AREA, "sign-out: token delete failed: ${e.javaClass.simpleName}")
        }
    }

    private suspend fun unregisterQuietly(): Boolean = try {
        api.unregisterPushDevice(deviceId())
        true
    } catch (e: CancellationException) {
        throw e
    } catch (e: Throwable) {
        false
    }

    private fun fingerprint(session: PushSession, registration: PushDeviceRegistration): String {
        val text = listOf(
            session.accountId,
            registration.pushToken,
            registration.deviceId,
            registration.workspaceId.orEmpty(),
            registration.permissionStatus.orEmpty(),
            registration.appVersion.orEmpty(),
        ).joinToString("|")
        return MessageDigest.getInstance("SHA-256").digest(text.toByteArray())
            .joinToString("") { "%02x".format(it) }
    }

    companion object {
        private const val AREA = "Push"

        /** How long an unchanged registration stands before it is sent again. */
        const val REFRESH_MS = 7L * 24 * 60 * 60 * 1000

    }
}
