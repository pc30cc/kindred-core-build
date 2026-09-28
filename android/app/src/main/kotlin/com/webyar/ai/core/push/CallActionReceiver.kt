package com.webyar.ai.core.push

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import com.webyar.ai.i18n.Language

/**
 * Decline, pressed on a ringing call: this phone stops ringing, and that is
 * all.
 *
 * Not the call centre's reject. That route takes the call out of the queue
 * altogether — the visitor is hung up on — which is what a desk's Reject
 * means and not what silencing a phone in a pocket should do: on a call rung
 * to every available operator, one of them declining would end it for the
 * others too. The call stays on offer to the console and to every other
 * phone, and runs its course there.
 *
 * A broadcast rather than an activity, so declining does not open the app.
 */
class CallActionReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != CallNotifications.ACTION_DECLINE) return
        val callId = intent.getStringExtra(CallNotifications.EXTRA_CALL)?.takeIf { PushPayload.isId(it) } ?: return
        // Declined, not missed, so no missed-call line and no language needed for one.
        CallNotifications.stop(context, callId, missed = false, language = Language.DEFAULT)
        CallNotifications.forget(callId)
    }
}
