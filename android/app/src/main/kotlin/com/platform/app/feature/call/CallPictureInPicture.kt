package com.platform.app.feature.call

import android.app.PendingIntent
import android.app.PictureInPictureParams
import android.app.RemoteAction
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.graphics.drawable.Icon
import android.os.Build
import android.util.Rational
import androidx.activity.ComponentActivity
import androidx.annotation.RequiresApi
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import com.platform.app.R
import com.platform.app.i18n.Language
import com.platform.app.i18n.Str
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.map
import androidx.compose.runtime.setValue
import androidx.compose.runtime.getValue

/**
 * A call in the system's picture-in-picture window while the member is in
 * another app (Home, Recents, a notification that opens one).
 *
 * The app is one activity, so the window is offered only while a call is on
 * — placed or answered, ringing on the other side or live, on its screen or
 * minimised into its bubble ([ActiveCalls.pick]) — and never for anything
 * else the app shows: leaving the inbox with no call on just leaves.
 *  - Android 12 and later enter on their own as the app goes
 *    ([PictureInPictureParams.Builder.setAutoEnterEnabled]), which is also
 *    what animates the call smoothly into its window.
 *  - Before that, the app asks as the member leaves ([onUserLeaveHint]).
 *
 * The window is shaped like the other side's picture on a video call
 * ([rememberVideoAspect]), and a little taller than wide on a voice call. Its
 * two buttons are the system's ([RemoteAction]): mute or unmute, and hang up.
 * The foreground service ([OngoingCallService]) is what keeps the microphone
 * and the camera; this only keeps the call in view. Tapped back to full size,
 * the call's own screen comes back ([ActiveCalls.requestShow]); dismissed,
 * the call goes on with its notification, whose End ends it. A call that ends
 * while in the window closes it.
 */
/** The picture-in-picture window as the host composable drives it ([CallPictureInPicture]; a fake in tests). */
interface PipWindow {
    /** Whether the activity is in its picture-in-picture window now. */
    val inWindow: Boolean

    /** The call (or none) the window would show. */
    fun update(next: CallPictureInPicture.Spec?)

    /** The call ended in the window: the window goes. */
    fun close()
}

class CallPictureInPicture(private val activity: ComponentActivity) : PipWindow {

    override var inWindow by mutableStateOf(false)
        private set

    /**
     * A permission dialog this app opened over a call in progress (the camera
     * or the microphone, asked for mid-call): leaving for it is not leaving
     * the app, so the call does not go into the window — before Android 12
     * the dialog's start counts as the user leaving, and from 12 the window
     * would enter on its own. Released when the activity is back in front.
     */
    private var heldForPermission = false

    fun holdForPermission() {
        if (heldForPermission) return
        heldForPermission = true
        update(spec)
    }

    /** The call the window is for, and how to draw it; null with no call on. */
    private var spec: Spec? = null

    data class Spec(
        val call: ActiveCall,
        val aspect: Rational,
        val muted: Boolean,
        val language: Language,
        /** Both on the line: only then is there a microphone to mute (the full screen's Mute is off before too). */
        val live: Boolean = true,
    )

    /**
     * The next way out of the window is not "tapped back to full size": a
     * notification the member tapped (a chat, a ring's Answer) has already
     * put its own screen in front, which raising the call would cover.
     */
    private var skipNextRaise = false

    /** A notification tap is navigating while the call is in the window. */
    fun notificationOpened() {
        if (inWindow) skipNextRaise = true
    }

    private val supported: Boolean =
        activity.packageManager.hasSystemFeature(PackageManager.FEATURE_PICTURE_IN_PICTURE)

    private val receiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            val call = spec?.call ?: return
            when (intent.action) {
                ACTION_MUTE -> if (spec?.live == true) call.toggleMute()
                ACTION_HANG_UP -> call.hangUp()
            }
        }
    }

    /** From the activity's `onCreate`: the window's buttons, and its comings and goings. */
    fun attach() {
        // Recreated while in the window (a change this activity does not
        // handle itself): no mode change will say so.
        inWindow = activity.isInPictureInPictureMode
        ContextCompat.registerReceiver(
            activity,
            receiver,
            IntentFilter().apply {
                addAction(ACTION_MUTE)
                addAction(ACTION_HANG_UP)
            },
            ContextCompat.RECEIVER_NOT_EXPORTED,
        )
        activity.lifecycle.addObserver(
            androidx.lifecycle.LifecycleEventObserver { _, event ->
                if (event == Lifecycle.Event.ON_RESUME && heldForPermission) {
                    heldForPermission = false
                    update(spec)
                }
            },
        )
        activity.addOnPictureInPictureModeChangedListener { info ->
            val was = inWindow
            inWindow = info.isInPictureInPictureMode
            // Out of the window, and still in front: it was tapped back to
            // full size, so the call's screen comes back. Dismissed instead
            // (the window swiped away), the activity has already stopped.
            if (was && !inWindow) {
                val skip = skipNextRaise
                skipNextRaise = false
                if (!skip && activity.lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)) {
                    spec?.call?.let { call -> activityCalls()?.requestShow(call) }
                }
            }
        }
    }

    /** From the activity's `onDestroy`. */
    fun detach() {
        runCatching { activity.unregisterReceiver(receiver) }
    }

    /** The call (or none) the window would show, kept in step with the call. */
    override fun update(next: Spec?) {
        spec = next
        if (!supported) return
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            runCatching { activity.setPictureInPictureParams(params(next)) }
        }
    }

    /** The member is leaving the app (Home, Recents): before Android 12, into the window with the call. */
    fun onUserLeaveHint() {
        val current = spec ?: return
        if (!supported || heldForPermission || activity.isInPictureInPictureMode) return
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) return // Entered on its own.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            runCatching { activity.enterPictureInPictureMode(params(current)) }
        } else {
            @Suppress("DEPRECATION")
            runCatching { activity.enterPictureInPictureMode() }
        }
    }

    /** The call ended in the window: the window goes, the app behind with it. */
    override fun close() {
        if (inWindow) activity.moveTaskToBack(false)
    }

    @RequiresApi(Build.VERSION_CODES.O)
    private fun params(spec: Spec?): PictureInPictureParams {
        val builder = PictureInPictureParams.Builder()
        if (spec != null) {
            builder.setAspectRatio(spec.aspect)
            builder.setActions(actions(spec))
        } else {
            builder.setActions(emptyList())
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            builder.setAutoEnterEnabled(spec != null && !heldForPermission)
            // A picture resizes smoothly; a face and a timer redraw anyway.
            builder.setSeamlessResizeEnabled(true)
        }
        return builder.build()
    }

    @RequiresApi(Build.VERSION_CODES.O)
    private fun actions(spec: Spec): List<RemoteAction> {
        val l = spec.language
        val muteTitle = if (spec.muted) Str.teamCallUnmute(l) else Str.teamCallMute(l)
        val hangUpTitle = Str.teamCallHangUp(l)
        val hangUp = RemoteAction(
            Icon.createWithResource(activity, R.drawable.ic_pip_call_end),
            hangUpTitle,
            hangUpTitle,
            broadcast(ACTION_HANG_UP, REQUEST_HANG_UP),
        )
        // Mute only once both are on the line, as on the full screen: before
        // it there is no microphone in a room to mute.
        if (!spec.live) return listOf(hangUp)
        return listOf(
            RemoteAction(
                Icon.createWithResource(activity, if (spec.muted) R.drawable.ic_pip_mic_off else R.drawable.ic_pip_mic),
                muteTitle,
                muteTitle,
                broadcast(ACTION_MUTE, REQUEST_MUTE),
            ),
            hangUp,
        )
    }

    private fun broadcast(action: String, request: Int): PendingIntent =
        PendingIntent.getBroadcast(
            activity,
            request,
            // This app's own package only: nothing outside it reaches the receiver.
            Intent(action).setPackage(activity.packageName),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )

    private fun activityCalls(): ActiveCalls? =
        (activity.application as? com.platform.app.PlatformApp)?.graph?.activeCalls

    private companion object {
        val ACTION_MUTE = "${com.platform.app.BuildConfig.APPLICATION_ID}.call.PIP_MUTE"
        val ACTION_HANG_UP = "${com.platform.app.BuildConfig.APPLICATION_ID}.call.PIP_HANG_UP"
        const val REQUEST_MUTE = 7101
        const val REQUEST_HANG_UP = 7102
    }
}

/**
 * Keeps [controller] in step with the calls on this phone, and while the
 * activity is in its window draws the call there ([PipCallView]) over the
 * whole app, which stays composed underneath (its call sessions with it).
 */
@Composable
fun CallPictureInPictureHost(controller: PipWindow, calls: ActiveCalls, language: Language) {
    val list by calls.calls.collectAsState()
    val pickedFlow = remember(list) {
        if (list.isEmpty()) {
            flowOf(null)
        } else {
            combine(list.map { call -> call.state.map { call to it } }) { states -> ActiveCalls.pick(states.toList()) }
        }
    }
    // Seeded with what the calls say now, not a placeholder null: an activity
    // recreated while in the window (a new wallpaper, language or bold text)
    // composes this in the window at once, and a first frame reading "no
    // call" would close the window over a live call.
    val initial = remember(list) { ActiveCalls.pick(list.map { it to it.state.value }) }
    val picked by pickedFlow.collectAsState(initial = initial)
    val call = picked?.first
    val state = picked?.second
    val remote by rememberRemoteVideo(call).collectAsState()
    val aspect = rememberVideoAspect(remote?.takeIf { state?.video == true })
    val shape = aspect?.takeIf { state?.video == true } ?: VOICE_PIP_ASPECT
    val live = state?.stage == ActiveCallStage.LIVE
    LaunchedEffect(call, shape, state?.muted, live, language) {
        controller.update(
            if (call != null && state != null) CallPictureInPicture.Spec(call, shape, state.muted, language, live) else null,
        )
    }
    if (controller.inWindow) {
        Box(Modifier.fillMaxSize()) {
            if (call != null) PipCallView(call, language) else CallBackdrop()
        }
        // Over while in the window: nothing to show, and the window goes.
        // Read again before closing, so only a call really over closes it.
        LaunchedEffect(call) { if (call == null && pickedFlow.first() == null) controller.close() }
    }
}
