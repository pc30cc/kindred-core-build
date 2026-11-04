import AVFoundation
import LiveKit

/// What the camera sends on a call: every room this app joins, a visitor's
/// call (`CallSession`) and a colleague's (`TeamCallRoom`) alike, with the
/// same numbers as the Android app's (`CallVideoEncoding.kt`).
///
/// LiveKit's defaults for a 1280x720 camera are three simulcast layers that
/// add up to about 2.3 Mbps, 1.7 Mbps of it the 720p layer alone. Measured on
/// 2026-11-03: a colleague video call between an iPhone and an Android phone
/// on Iranian mobile data carried about 4 Mbps through that link, which
/// clogged (packets arriving 6 s late, the signalling and the media timing
/// out) until the call ended. These caps halve that and keep a good picture.
///
/// Each value is a ceiling the encoder may stay under, in LiveKit's units:
/// bits per second and frames per second (read against client-sdk-swift
/// 2.17.0, and unchanged in 2.19.0, the newest 2.x that `from: 2.17.0`
/// resolves to: `VideoEncoding`, `VideoParameters`,
/// `Utils.computeVideoEncodings`). The capture, codec, adaptive stream,
/// dynacast and the audio are left as they were.
enum CallMediaBudget {
    /// The front camera at 1280x720 and 30 fps, as before (30 is the SDK's
    /// own default): the encoder sends 24 of those frames, not the camera.
    static let captureDimensions = Dimensions(width: 1280, height: 720)
    static let captureFps = 30

    /// The top layer, the track's own encoding: the full 1280x720.
    static let topMaxBitrate = 1_000_000
    static let topMaxFps = 24

    /// The two layers simulcast sends below the top one, for a picture shown
    /// small or a link that cannot carry the top. Smaller than the top and
    /// under its bitrate and frame rate, so LiveKit sends them as written.
    static let lowLayer = VideoParameters(
        dimensions: Dimensions(width: 320, height: 180),
        encoding: VideoEncoding(maxBitrate: 120_000, maxFps: 15)
    )
    static let midLayer = VideoParameters(
        dimensions: Dimensions(width: 640, height: 360),
        encoding: VideoEncoding(maxBitrate: 400_000, maxFps: 20)
    )

    /// `RoomOptions.defaultCameraCaptureOptions` of every call room.
    static let cameraCapture = CameraCaptureOptions(
        position: .front,
        dimensions: captureDimensions,
        fps: captureFps
    )

    /// `RoomOptions.defaultVideoPublishOptions` of every call room: the top
    /// layer and the two below it, simulcast on as before.
    static let videoPublish = VideoPublishOptions(
        encoding: VideoEncoding(maxBitrate: topMaxBitrate, maxFps: topMaxFps),
        simulcast: true,
        simulcastLayers: [lowLayer, midLayer]
    )
}
