package com.platform.app.feature.call

import androidx.compose.runtime.Composable
import androidx.compose.runtime.key
import androidx.compose.ui.Modifier
import androidx.compose.ui.viewinterop.AndroidView
import io.livekit.android.renderer.TextureViewRenderer
import io.livekit.android.room.track.VideoTrack
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.unit.LayoutDirection

/**
 * One video track, drawn.
 *
 * A `TextureViewRenderer` rather than a `SurfaceViewRenderer`, which is the
 * choice that matters here: a SurfaceView punches a hole through the window
 * and cannot be drawn over, rounded or animated. The call screens put one
 * picture in a rounded card ON TOP of the other ([SelfView]), and swap which
 * is which on a tap, so the one that composites normally — drawn in Compose's
 * own order, the card's after the full screen's — is the only one that works.
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
    // showing a frozen last frame. A swap is the same case at both places:
    // each gets a fresh renderer on the other track, and each old one takes
    // its sink off its track and lets its texture go (`onRelease`).
    key(track) {
        // Left to right whatever the app's direction, so a Persian screen
        // never adds a second flip to the one [mirror] asks for.
        CompositionLocalProvider(LocalLayoutDirection provides LayoutDirection.Ltr) {
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
}
