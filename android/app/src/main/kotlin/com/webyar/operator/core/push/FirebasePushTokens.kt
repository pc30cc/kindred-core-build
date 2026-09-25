package com.webyar.operator.core.push

import android.content.Context
import android.os.Build
import androidx.core.app.NotificationManagerCompat
import com.google.firebase.messaging.FirebaseMessaging

class FirebasePushTokens(private val configured: () -> Boolean) : PushTokens {
    override suspend fun current(): String? {
        if (!configured()) return null
        val messaging = FirebaseMessaging.getInstance()
        // Auto-init is off in the manifest, so no token exists before the
        // first sign-in; asking for it is what turns it on.
        messaging.isAutoInitEnabled = true
        return messaging.token.awaitResult()
    }

    override suspend fun delete() {
        if (!configured()) return
        val messaging = FirebaseMessaging.getInstance()
        messaging.isAutoInitEnabled = false
        messaging.deleteToken().awaitResult()
    }
}

/** The Android half of the registrar: what the system says about this phone. */
object PushDevice {
    /** `granted` | `denied` — what the system will actually do with a notification. */
    fun permissionOf(context: Context): String =
        if (NotificationManagerCompat.from(context).areNotificationsEnabled()) "granted" else "denied"

    fun info(versionName: String, versionCode: Int): PushRegistrar.DeviceInfo = PushRegistrar.DeviceInfo(
        name = "${Build.MANUFACTURER} ${Build.MODEL} · Android ${Build.VERSION.RELEASE}".take(120),
        appVersion = "$versionName ($versionCode)".take(40),
    )
}
