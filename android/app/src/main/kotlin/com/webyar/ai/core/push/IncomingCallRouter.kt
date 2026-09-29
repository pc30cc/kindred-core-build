package com.webyar.ai.core.push

import com.webyar.ai.core.Diag
import com.webyar.ai.i18n.Language

/**
 * A call-centre ring or its cancel, turned into what the phone should do.
 *
 * Runs whatever state the app is in — FCM hands a data-only message to the
 * app's service open, backgrounded or cold — so nothing here may lean on the
 * screens being up. What it does lean on is what survives a cold start: who
 * this phone's push registration belongs to, and the language they chose.
 *
 *  - A ring rings only when somebody is signed in here. The server sends it
 *    to the phone registered for the operator it is ringing, and a phone
 *    somebody signed out of is unregistered first; a ring that still finds
 *    nobody is dropped rather than showing one operator's caller to whoever
 *    picks the phone up next.
 *  - A ring that arrives after its expiry is not a call any more.
 *  - A cancel always stops the ring, signed in or not: stopping a ring can
 *    only ever be right.
 */
class IncomingCallRouter(
    private val signedInAccount: suspend () -> String?,
    private val language: suspend () -> Language,
    private val ring: (IncomingCall, Language) -> Unit,
    private val stop: (CallCancel, Language) -> Unit,
    private val nowEpochSeconds: () -> Long = { System.currentTimeMillis() / 1000 },
    private val diag: Diag = Diag.Android,
) {
    /**
     * Whether [data] was a call message — handled or dropped — and nothing
     * else should look at it. [sentAtMillis] is when FCM says it was sent
     * (0 when unknown), which is what a ring's expiry is read against when
     * this phone's clock disagrees with the server's: see
     * [IncomingCall.onPhoneClock].
     */
    suspend fun onMessage(data: Map<String, String>, sentAtMillis: Long = 0): Boolean {
        val type = data[PushPayload.KEY_TYPE]
        if (type != IncomingCall.TYPE_INCOMING && type != IncomingCall.TYPE_CANCEL) return false
        if (type == IncomingCall.TYPE_CANCEL) {
            val cancel = CallCancel.from(data) ?: run {
                diag.warn(AREA, "call cancel dropped: malformed")
                return true
            }
            diag.info(AREA, "ring stopped (${cancel.reason.name.lowercase()}) for ${Diag.id(cancel.callId)}")
            stop(cancel, language())
            return true
        }
        val now = nowEpochSeconds()
        val call = IncomingCall.from(data)?.onPhoneClock(now, sentAtMillis / 1000) ?: run {
            diag.warn(AREA, "ring dropped: malformed")
            return true
        }
        if (call.expired(now)) {
            diag.info(AREA, "ring dropped: arrived after it expired")
            return true
        }
        if (signedInAccount() == null) {
            diag.warn(AREA, "ring dropped: nobody signed in")
            return true
        }
        diag.info(AREA, "ringing for ${Diag.id(call.callId)}")
        ring(call, language())
        return true
    }

    private companion object {
        const val AREA = "Call"
    }
}
