package com.webyar.operator.core.storage

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import android.util.Log
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.first
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

private val Context.dataStore by preferencesDataStore(name = "webyar")

/**
 * The session token, encrypted by a key the app cannot export.
 *
 * The port of `TokenStore.swift`, and the reasoning carries over exactly: the
 * token IS the session — anyone holding it is signed in as the operator — so
 * it never sits in plain preferences, which on Android is a world-readable
 * XML file on a rooted device and a plain file in the backup set on any
 * device.
 *
 * Android has no Keychain, so this is the two-part equivalent: an AES key
 * generated inside the Android Keystore, which the app can use but never read
 * out, and the ciphertext in DataStore. The key is NOT
 * `setUserAuthenticationRequired` — that is the deliberate counterpart of
 * iOS's `AfterFirstUnlock`: the app has to refresh the inbox in the background
 * after a push, so it cannot require an unlocked screen. It is also not
 * exportable and does not survive a restore onto another device, which is what
 * `ThisDeviceOnly` bought on iOS.
 */
class SecureStore(private val context: Context) {

    private companion object {
        const val TAG = "webyar.secure"
        const val KEY_ALIAS = "com.webyar.operator.session"
        const val ANDROID_KEYSTORE = "AndroidKeyStore"
        const val TRANSFORMATION = "AES/GCM/NoPadding"
        const val GCM_TAG_BITS = 128
        const val IV_BYTES = 12
        val TOKEN = stringPreferencesKey("session.token")
    }

    suspend fun readToken(): String? = read(TOKEN)?.let { stored ->
        runCatching { decrypt(stored) }
            .onFailure {
                // The key is gone — the app was reinstalled, or the user
                // changed their lock screen in a way that invalidated it.
                // Nobody is signed in; that is an ordinary answer, not a bug.
                Log.i(TAG, "Stored session token could not be decrypted; treating as signed out.")
            }
            .getOrNull()
    }

    suspend fun writeToken(token: String?) {
        if (token == null) {
            remove(TOKEN)
            return
        }
        runCatching { write(TOKEN, encrypt(token)) }.onFailure {
            // iOS logs the equivalent Keychain failure rather than swallowing
            // it, for the same reason: the app carries on working perfectly
            // until the next launch, when the session is gone with nothing to
            // explain it.
            Log.e(TAG, "Could not store the session token. The operator will have to sign in again next launch.", it)
        }
    }

    // MARK: - Plain values
    //
    // Deliberately not encrypted: a remembered name, an API origin and a
    // language are settings, not credentials. Only the token gets the key.

    suspend fun read(key: Preferences.Key<String>): String? =
        context.dataStore.data.first()[key]

    suspend fun write(key: Preferences.Key<String>, value: String) {
        context.dataStore.edit { it[key] = value }
    }

    suspend fun remove(key: Preferences.Key<String>) {
        context.dataStore.edit { it.remove(key) }
    }

    // MARK: - Keystore

    private fun secretKey(): SecretKey {
        val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        (keyStore.getEntry(KEY_ALIAS, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }

        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
        generator.init(
            KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                // See the class note: background refresh after a push means
                // this cannot wait for an unlocked screen.
                .setUserAuthenticationRequired(false)
                .build()
        )
        return generator.generateKey()
    }

    /** `base64(iv):base64(ciphertext)` — the IV is not a secret and must travel with it. */
    private fun encrypt(plain: String): String {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, secretKey())
        val bytes = cipher.doFinal(plain.toByteArray(Charsets.UTF_8))
        return "${b64(cipher.iv)}:${b64(bytes)}"
    }

    private fun decrypt(stored: String): String {
        val (ivPart, bodyPart) = stored.split(":", limit = 2).let {
            require(it.size == 2) { "stored token is not iv:ciphertext" }
            it[0] to it[1]
        }
        val iv = unB64(ivPart)
        require(iv.size == IV_BYTES) { "unexpected IV length" }
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.DECRYPT_MODE, secretKey(), GCMParameterSpec(GCM_TAG_BITS, iv))
        return String(cipher.doFinal(unB64(bodyPart)), Charsets.UTF_8)
    }

    private fun b64(bytes: ByteArray) = Base64.encodeToString(bytes, Base64.NO_WRAP)
    private fun unB64(text: String) = Base64.decode(text, Base64.NO_WRAP)
}
