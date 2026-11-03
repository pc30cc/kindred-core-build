package com.platform.app.feature.call

import io.livekit.android.room.participant.VideoTrackPublishDefaults
import io.livekit.android.room.track.CameraPosition
import io.livekit.android.room.track.CustomVideoPreset
import io.livekit.android.room.track.LocalVideoTrackOptions
import io.livekit.android.room.track.VideoCaptureParameter
import io.livekit.android.room.track.VideoCodec
import io.livekit.android.room.track.VideoEncoding

/**
 * What a call's camera captures and what it sends: one 720p picture at about
 * 1 Mbps, and two small copies for a receiver that draws it small.
 *
 * On 2026-11-03 the production server measured an Android phone on Iranian
 * mobile data uploading 2.3-2.4 Mbps at LiveKit's defaults for a 720p capture
 * (all three layers) and downloading 1.8-2 Mbps (the iPhone's 720p layer), and
 * that ~4 Mbps clogged the link until the signalling timed out and the call
 * ended. These numbers halve it, and the iPhone app sends the same ones
 * (`CallMediaBudget.swift`), so both sides of a call cost the same.
 *
 * Every call this app makes or answers, colleague or visitor, gets them:
 * [LiveKitRoom] is the only place a room is built. Bitrates are bits per
 * second and rates frames per second, which is how [VideoEncoding] takes them
 * and how it hands them to WebRTC (`maxBitrateBps`, `maxFramerate`).
 */
internal object CallVideoEncoding {

    // The camera as it was before: 1280×720 at 30 fps, the SDK's own 720p
    // capture. WebRTC drops it to the layers' 24 fps before encoding, so
    // asking the camera for 24 would save no bandwidth, and it would change
    // the frame-rate range each phone's camera picks.
    const val CAPTURE_WIDTH = 1280
    const val CAPTURE_HEIGHT = 720
    const val CAPTURE_FPS = 30

    // The picture the other side shows full screen: still 720p, at 1 Mbps and
    // 24 fps instead of LiveKit's 1.7 Mbps at 30. Most of the saving is here.
    const val TOP_MAX_BITRATE_BPS = 1_000_000
    const val TOP_MAX_FPS = 24

    // The copies a receiver takes when it draws the picture small or its link
    // is poor, each under LiveKit's own (160 kbps at 15, 450 kbps at 30).
    // A quarter and a half of the capture, exactly: the SDK scales a layer
    // down by the capture's long side over the layer's, so 4 and 2 here.
    const val LOW_WIDTH = 320
    const val LOW_HEIGHT = 180
    const val LOW_MAX_BITRATE_BPS = 120_000
    const val LOW_MAX_FPS = 15

    const val MID_WIDTH = 640
    const val MID_HEIGHT = 360
    const val MID_MAX_BITRATE_BPS = 400_000
    const val MID_MAX_FPS = 20

    /** The front camera, as every call has opened on, at the capture above. */
    val captureDefaults = LocalVideoTrackOptions(
        position = CameraPosition.FRONT,
        captureParams = VideoCaptureParameter(
            width = CAPTURE_WIDTH,
            height = CAPTURE_HEIGHT,
            maxFps = CAPTURE_FPS,
        ),
    )

    /**
     * The camera's encodings, published through the room's defaults so that
     * `setCameraEnabled(true)` uses them without being told.
     */
    val publishDefaults = VideoTrackPublishDefaults(
        videoEncoding = VideoEncoding(maxBitrate = TOP_MAX_BITRATE_BPS, maxFps = TOP_MAX_FPS),
        // Still on: with adaptive stream a receiver drawing the picture small
        // takes a small layer, and dynacast stops the layers nobody takes.
        simulcast = true,
        // VP8, as before. Simulcast is what saves the bandwidth here; an SVC
        // codec would also bring a backup codec, a second encoder to pay for.
        videoCodec = VideoCodec.VP8.codecName,
        // Smallest first, like the SDK's own list. Named here, or the SDK
        // picks its defaults (160 and 450 kbps) under our top layer.
        simulcastLayers = listOf(
            CustomVideoPreset(
                capture = VideoCaptureParameter(width = LOW_WIDTH, height = LOW_HEIGHT, maxFps = LOW_MAX_FPS),
                encoding = VideoEncoding(maxBitrate = LOW_MAX_BITRATE_BPS, maxFps = LOW_MAX_FPS),
            ),
            CustomVideoPreset(
                capture = VideoCaptureParameter(width = MID_WIDTH, height = MID_HEIGHT, maxFps = MID_MAX_FPS),
                encoding = VideoEncoding(maxBitrate = MID_MAX_BITRATE_BPS, maxFps = MID_MAX_FPS),
            ),
        ),
    )
}
