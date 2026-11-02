package com.platform.app.feature.call

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.Dp
import io.livekit.android.room.track.VideoTrack

/** One picture on a video call, and whether it is drawn as a mirror. */
internal data class StagePicture<T : Any>(val track: T, val mirror: Boolean)

/**
 * What a video call's two pictures are doing: which one fills the screen,
 * and what the card floating over it ([SelfView]) shows.
 *
 * Normally the other side's picture fills the screen and the member's own
 * floats in the card. A tap on the card swaps them — the member's own camera
 * edge to edge, the other side in the card — and another tap swaps them back.
 * Each picture keeps its own mirror wherever it is drawn: a front camera's
 * own preview is a mirror in the card and on the whole screen alike, and the
 * other side's is drawn as the screen has always drawn it.
 *
 * There is no card, and so nothing to swap, while the member's own camera
 * gives no picture. Generic in the track so the rule is tested without a
 * LiveKit track.
 */
internal data class CallStage<T : Any>(
    /** Edge to edge, behind the name and the buttons; null leaves the dark screen with the other side's face. */
    val big: StagePicture<T>?,
    /** Whether the card is on screen at all. */
    val hasCard: Boolean,
    /** In the card; null there (swapped, their camera off) is the other side's face on a dark tile. */
    val small: StagePicture<T>?,
    /** The member's own picture is the big one. */
    val swapped: Boolean,
) {
    companion object {
        fun <T : Any> of(
            remote: T?,
            remoteMirror: Boolean,
            own: T?,
            ownMirror: Boolean,
            swapped: Boolean,
        ): CallStage<T> {
            val theirs = remote?.let { StagePicture(it, remoteMirror) }
            val mine = own?.let { StagePicture(it, ownMirror) } ?: return CallStage(theirs, hasCard = false, small = null, swapped = false)
            return if (swapped) {
                CallStage(big = mine, hasCard = true, small = theirs, swapped = true)
            } else {
                CallStage(big = theirs, hasCard = true, small = mine, swapped = false)
            }
        }
    }
}

/**
 * Whether the member has swapped the pictures, for the picture of theirs
 * now on screen ([own]: their camera's track while it is on, else null).
 *
 * Remembered against that picture, so it does not outlive it: when the
 * camera goes off or its track goes away the swap goes with it, and the
 * picture that comes back starts in the card, the way a call opens. Switching
 * lens keeps the same track, and the swap with it.
 */
@Composable
internal fun rememberStageSwap(own: Any?): MutableState<Boolean> = remember(own) { mutableStateOf(false) }

/**
 * What the card shows: a picture, or — swapped while the other side's camera
 * is off — their [face] on a dark tile, at a size that suits the card.
 */
@Composable
internal fun StageCardContent(
    picture: StagePicture<VideoTrack>?,
    room: LiveKitRoom,
    face: @Composable (size: Dp) -> Unit,
) {
    if (picture != null) {
        VideoView(picture.track, room, Modifier.fillMaxSize(), mirror = picture.mirror)
    } else {
        BoxWithConstraints(
            Modifier.fillMaxSize().background(CALL_TILE),
            contentAlignment = Alignment.Center,
        ) {
            face(maxWidth * 0.56f)
        }
    }
}

/** The card's own dark, a step up from the call's so the tile reads as one over it. */
internal val CALL_TILE = Color(0xFF1E232A)
