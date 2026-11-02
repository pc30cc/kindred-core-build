package com.platform.app.core.push

import com.platform.app.core.Diag
import com.platform.app.i18n.Language

/**
 * A call-centre ring or its cancel — or a colleague's ([TeamCallRing],
 * [TeamCallCancel]) — turned into what the phone should do.
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
 *  - A ring for a workspace whose plan has the mobile app off is not shown
 *    (docs/operations/MOBILE_APP_PLAN.md). What this phone remembers of that
 *    plan can be stale — switched back on while the member looked at another
 *    workspace — and the server sends a locked workspace's phones no ring,
 *    so one that arrives is as likely a plan switched back on as a late one:
 *    the plan is asked again first, and only a plan that still says `false`
 *    (or cannot be read) keeps the ring off. A cancel still stops whatever
 *    rings, and a call already on is never touched by this.
 *
 * A colleague's ring keeps the same three rules. It is told apart by its
 * type (`team_call_incoming`, `team_call_cancel`) and handed on separately,
 * because what answering it means is not the call centre's: it is a call
 * between two members, with an outcome both of them see.
 */
class IncomingCallRouter(
    private val signedInAccount: suspend () -> String?,
    private val language: suspend () -> Language,
    private val ring: (IncomingCall, Language) -> Unit,
    private val stop: (CallCancel, Language) -> Unit,
    /**
     * Suspends, and is waited for: a colleague's ring fetches their photo
     * first (briefly — [CallerFace.photo]), and FCM's handler must not return
     * before the ring is up, or a cold-started process could be gone first.
     */
    private val ringColleague: suspend (TeamCallRing, Language) -> Unit,
    private val stopColleague: (TeamCallCancel, Language) -> Unit,
    /**
     * Whether the plan of the workspace a ring is for was last read, on this
     * phone, with the mobile app off ([com.platform.app.core.model.mobileAppLocked]).
     * Local reads only, as the other two: it can run before any screen.
     */
    private val workspaceLocked: suspend (String) -> Boolean = { false },
    /**
     * That workspace's plan read again, for a ring [workspaceLocked] would
     * keep off: true while it still says the mobile app is off, false once
     * it no longer does, null when it cannot be read (in time). Bounded by
     * the caller: FCM's handler waits for it.
     */
    private val planStillLocked: suspend (String) -> Boolean? = { null },
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
        if (type == TeamCallRing.TYPE_INCOMING || type == TeamCallRing.TYPE_CANCEL) {
            onColleagueMessage(type, data, sentAtMillis)
            return true
        }
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
        if (locked(call.workspaceId)) {
            diag.info(AREA, "ring dropped: the mobile app is off in ${Diag.id(call.workspaceId)}'s plan")
            return true
        }
        diag.info(AREA, "ringing for ${Diag.id(call.callId)}")
        ring(call, language())
        return true
    }

    /** A colleague's ring or its cancel: the same rules as a call-centre one. */
    private suspend fun onColleagueMessage(type: String, data: Map<String, String>, sentAtMillis: Long) {
        if (type == TeamCallRing.TYPE_CANCEL) {
            val cancel = TeamCallCancel.from(data) ?: run {
                diag.warn(AREA, "colleague call cancel dropped: malformed")
                return
            }
            diag.info(AREA, "colleague ring stopped (${cancel.reason.name.lowercase()}) for ${Diag.id(cancel.callId)}")
            stopColleague(cancel, language())
            return
        }
        val now = nowEpochSeconds()
        val ring = TeamCallRing.from(data)?.onPhoneClock(now, sentAtMillis / 1000) ?: run {
            diag.warn(AREA, "colleague ring dropped: malformed")
            return
        }
        if (ring.expired(now)) {
            diag.info(AREA, "colleague ring dropped: arrived after it expired")
            return
        }
        if (signedInAccount() == null) {
            diag.warn(AREA, "colleague ring dropped: nobody signed in")
            return
        }
        if (locked(ring.workspaceId)) {
            diag.info(AREA, "colleague ring dropped: the mobile app is off in ${Diag.id(ring.workspaceId)}'s plan")
            return
        }
        diag.info(AREA, "colleague ringing for ${Diag.id(ring.callId)}")
        ringColleague(ring, language())
    }

    /**
     * Whether a ring for [workspaceId] stays off: remembered with the mobile
     * app off, and still so when its plan is asked again. A plan that cannot
     * be read leaves the memory standing — it was an explicit `false`.
     */
    private suspend fun locked(workspaceId: String): Boolean {
        if (!workspaceLocked(workspaceId)) return false
        val still = planStillLocked(workspaceId)
        if (still == false) diag.info(AREA, "the mobile app is on again in ${Diag.id(workspaceId)}'s plan: ringing")
        return still != false
    }

    private companion object {
        const val AREA = "Call"
    }
}
