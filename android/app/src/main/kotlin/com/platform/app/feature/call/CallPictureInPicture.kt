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
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import com.platform.app.R
import com.platform.app.i18n.Language
import com.platform.app.i18n.Str
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.map

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
class CallPictureInPicture(private val activity: ComponentActivity) {

    /** Whether the activity is in its picture-in-picture window now. */
    var inWindow by mutableStateOf(false)
        private set

    /** The call the window is for, and how to draw it; null with no call on. */
    private var spec: Spec? = null

    data class Spec(val call: ActiveCall, val aspect: Rational, val muted: Boolean, val language: Language)

    private val supported: Boolean =
        activity.packageManager.hasSystemFeature(PackageManager.FEATURE_PICTURE_IN_PICTURE)

    private val receiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            val call = spec?.call ?: return
            when (intent.action) {
                ACTION_MUTE -> call.toggleMute()
                ACTION_HANG_UP -> call.hangUp()
            }
        }
    }

    /** From the activity's `onCreate`: the window's buttons, and its comings and goings. */
    fun attach() {
        ContextCompat.registerReceiver(
            activity,
            receiver,
            IntentFilter().apply {
                addAction(ACTION_MUTE)
                addAction(ACTION_HANG_UP)
            },
            ContextCompat.RECEIVER_NOT_EXPORTED,
        )
        activity.addOnPictureInPictureModeChangedListener { info ->
            val was = inWindow
            inWindow = info.isInPictureInPictureMode
            // Out of the window, and still in front: it was tapped back to
            // full size, so the call's screen comes back. Dismissed instead
            // (the window swiped away), the activity has already stopped.
            if (was && !inWindow && activity.lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)) {
                spec?.call?.let { call -> activityCalls()?.requestShow(call) }
            }
        }
    }

    /** From the activity's `onDestroy`. */
    fun detach() {
        runCatching { activity.unregisterReceiver(receiver) }
    }

    /** The call (or none) the window would show, kept in step with the call. */
    fun update(next: Spec?) {
        spec = next
        if (!supported) return
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            runCatching { activity.setPictureInPictureParams(params(next)) }
        }
    }

    /** The member is leaving the app (Home, Recents): before Android 12, into the window with the call. */
    fun onUserLeaveHint() {
        val current = spec ?: return
        if (!supported || activity.isInPictureInPictureMode) return
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) return // Entered on its own.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            runCatching { activity.enterPictureInPictureMode(params(current)) }
        } else {
            @Suppress("DEPRECATION")
            runCatching { activity.enterPictureInPictureMode() }
        }
    }

    /** The call ended in the window: the window goes, the app behind with it. */
    fun close() {
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
            builder.setAutoEnterEnabled(spec != null)
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
        return listOf(
            RemoteAction(
                Icon.createWithResource(activity, if (spec.muted) R.drawable.ic_pip_mic_off else R.drawable.ic_pip_mic),
                muteTitle,
                muteTitle,
                broadcast(ACTION_MUTE, REQUEST_MUTE),
            ),
            RemoteAction(
                Icon.createWithResource(activity, R.drawable.ic_pip_call_end),
                hangUpTitle,
                hangUpTitle,
                broadcast(ACTION_HANG_UP, REQUEST_HANG_UP),
            ),
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
fun CallPictureInPictureHost(controller: CallPictureInPicture, calls: ActiveCalls, language: Language) {
    val list by calls.calls.collectAsState()
    val pickedFlow = remember(list) {
        if (list.isEmpty()) {
            flowOf(null)
        } else {
            combine(list.map { call -> call.state.map { call to it } }) { states -> ActiveCalls.pick(states.toList()) }
        }
    }
    val picked by pickedFlow.collectAsState(initial = null)
    val call = picked?.first
    val state = picked?.second
    val remoteFlow = remember(call) { call?.room?.remoteVideo ?: MutableStateFlow(null) }
    val remote by remoteFlow.collectAsState()
    val aspect = rememberVideoAspect(remote?.takeIf { state?.video == true })
    val shape = aspect?.takeIf { state?.video == true } ?: VOICE_PIP_ASPECT
    LaunchedEffect(call, shape, state?.muted, language) {
        controller.update(if (call != null && state != null) CallPictureInPicture.Spec(call, shape, state.muted, language) else null)
    }
    if (controller.inWindow) {
        Box(Modifier.fillMaxSize()) {
            if (call != null) PipCallView(call, language) else CallBackdrop()
        }
        // Over while in the window: nothing to show, and the window goes.
        LaunchedEffect(call) { if (call == null) controller.close() }
    }
}
