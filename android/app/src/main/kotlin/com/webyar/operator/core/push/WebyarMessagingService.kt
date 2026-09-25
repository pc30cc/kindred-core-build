package com.webyar.operator.core.push

import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import com.webyar.operator.WebyarApp

/**
 * Where FCM hands this app its messages and its tokens.
 *
 * The server sends a notification-plus-data message
 * (`server/services/push/fcm.ts`), so with the app in the background the
 * SYSTEM draws the notification from the `notification` block and this
 * class is not called at all — nothing of ours runs, no socket is opened,
 * no poll is scheduled. With the app in front, [onMessageReceived] is called
 * instead and the app decides: a targeted sync of the conversation the push
 * names, and a notification unless the operator is already looking at it.
 *
 * Both paths are thin: the work belongs to [PushRouter] and [PushRegistrar],
 * which the rest of the app shares, so a push and a realtime event about
 * the same message end up in the same repository and are the same row.
 */
class WebyarMessagingService : FirebaseMessagingService() {

    override fun onNewToken(token: String) {
        // The token itself is not taken from here: the registrar asks
        // Firebase for the current one, so there is exactly one source for
        // it. What this says is "register again" — handed to WorkManager,
        // because this can run with no UI and no network.
        PushRegistrationWorker.enqueue(applicationContext, reason = "token rotated")
    }

    override fun onMessageReceived(message: RemoteMessage) {
        val graph = (application as? WebyarApp)?.graph ?: return
        graph.pushRouter.onMessage(
            payload = PushPayload.from(message.data),
            title = message.notification?.title,
            body = message.notification?.body,
        )
    }
}
