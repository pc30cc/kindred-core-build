package com.webyar.operator.feature.call

import androidx.compose.runtime.Composable
import androidx.compose.runtime.key
import androidx.compose.ui.Modifier
import androidx.compose.ui.viewinterop.AndroidView
import io.livekit.android.renderer.TextureViewRenderer
import io.livekit.android.room.track.VideoTrack

/**
 * One video track, drawn.
 *
 * A `TextureViewRenderer` rather than a `SurfaceViewRenderer`, which is the
 * choice that matters here: a SurfaceView punches a hole through the window
 * and cannot be drawn over, rounded or animated. This screen puts the
 * operator's own picture in a rounded card ON TOP of the visitor's, so the
 * one that composites normally is the only one that works.
 *
 * The renderer is initialised from the room — a renderer given a different
 * EGL context draws nothing and says nothing about why — and released when it
 * leaves composition, because one that is not holds a texture and a decoder.
 */
@Composable
fun VideoView(
    track: VideoTrack?,
    room: LiveKitRoom,
    modifier: Modifier = Modifier,
    mirror: Boolean = false,
) {
    if (track == null) return

    // Keyed on the track, so a new one gets a new renderer rather than being
    // attached to the old one's. `factory` runs once per view; without the
    // key, a visitor switching camera — or a re-subscribe after a reconnect —
    // would leave the renderer bound to a track nobody is sending on any more,
    // showing a frozen last frame.
    key(track) {
        AndroidView(
            modifier = modifier,
            factory = { context ->
                TextureViewRenderer(context).apply {
                    room.initRenderer(this)
                    setMirror(mirror)
                    track.addRenderer(this)
                }
            },
            update = { view -> view.setMirror(mirror) },
            onRelease = { view ->
                track.removeRenderer(view)
                view.release()
            },
        )
    }
}
