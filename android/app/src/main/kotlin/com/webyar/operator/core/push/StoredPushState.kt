package com.webyar.operator.core.push

import androidx.datastore.preferences.core.stringPreferencesKey
import com.webyar.operator.core.storage.SecureStore

/**
 * [PushState] in the app's DataStore, as plain values.
 *
 * None of these is a credential: an install id, a digest of the last
 * registration, and whose user id and workspace the phone is registered for.
 * The FCM token itself is never stored here — Firebase keeps it, and it is
 * asked for fresh each time.
 */
class StoredPushState(private val store: SecureStore) : PushState {
    private val deviceKey = stringPreferencesKey("push.deviceId")
    private val lastKey = stringPreferencesKey("push.lastRegistration")
    private val accountKey = stringPreferencesKey("push.accountId")
    private val workspaceKey = stringPreferencesKey("push.workspaceId")

    override suspend fun deviceId(): String? = store.read(deviceKey)

    override suspend fun setDeviceId(value: String) = store.write(deviceKey, value)

    override suspend fun lastRegistration(): Pair<String, Long>? {
        val raw = store.read(lastKey) ?: return null
        val fingerprint = raw.substringBefore('@').takeIf { it.isNotEmpty() } ?: return null
        val at = raw.substringAfter('@', "").toLongOrNull() ?: return null
        return fingerprint to at
    }

    override suspend fun setLastRegistration(fingerprint: String?, at: Long) {
        if (fingerprint == null) store.remove(lastKey) else store.write(lastKey, "$fingerprint@$at")
    }

    override suspend fun session(): PushSession? {
        val account = store.read(accountKey)?.takeIf { it.isNotBlank() } ?: return null
        return PushSession(account, store.read(workspaceKey)?.takeIf { it.isNotBlank() })
    }

    override suspend fun setSession(session: PushSession?) {
        if (session == null) {
            store.remove(accountKey)
            store.remove(workspaceKey)
            return
        }
        store.write(accountKey, session.accountId)
        val workspace = session.workspaceId
        if (workspace == null) store.remove(workspaceKey) else store.write(workspaceKey, workspace)
    }
}
