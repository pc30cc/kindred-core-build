import AVFoundation
import AVKit
import LiveKit
import SwiftUI
import UIKit

/// The other side's video in iOS's own picture-in-picture window once the
/// member leaves the app during a video call — a colleague's or a visitor's
/// (owner, 2026-11-04: "the picture small at the side, and the user can keep
/// working").
///
/// The video-call kind of PiP (iOS 15+): an
/// `AVPictureInPictureVideoCallViewController` whose view draws the remote
/// track with LiveKit's own `VideoView` in its sample-buffer mode — the one
/// renderer that keeps drawing while the app is in the background (Metal
/// does not) — and an `AVPictureInPictureController` built on the call
/// screen's picture (`CallPiPSource`) as its inline source, so it starts on
/// its own when the app goes to the background
/// (`canStartPictureInPictureAutomaticallyFromInline`) and grows back into
/// that picture when tapped.
///
/// One, app-wide: the call screen and the colleague call's floating view
/// (`TeamCallBubble`) hand it their picture in turn, and the PiP window, once
/// up, outlives the view that started it. `end()` closes it with the call.
///
/// The local camera: iOS stops an iPhone app's camera in the background
/// unless the app holds Apple's multitasking camera entitlement
/// (`com.apple.developer.avfoundation.multitasking-camera-access`). This app
/// does not yet; the remote picture still shows in PiP, the member's own
/// camera pauses until they return, and `CallCamera.allowWhileMultitasking`
/// turns multitasking on by itself the day the entitlement is in the build.
@MainActor
final class CallPictureInPicture: NSObject {
    static let shared = CallPictureInPicture()

    /// What the PiP window shows, and what a tap on it brings back.
    struct Call {
        var track: VideoTrack?
        var name: String
        var avatarURL: String?
        var subject: AvatarSkeleton.Subject
        /// Whose PiP this is — the colleague call's uuid, or the visitor
        /// call's screen — so one call's end never closes another's.
        var owner: String
        /// The call screen, full, when the member taps the PiP window to
        /// come back (the colleague call's floating view expands).
        var restore: @MainActor () -> Void
    }

    private var controller: AVPictureInPictureController?
    private var content: CallPiPContentController?
    /// The view on screen the PiP window grows out of and back into.
    private weak var source: UIView?
    private var call: Call?
    private(set) var isActive = false

    private override init() {
        super.init()
        NotificationCenter.default.addObserver(
            self, selector: #selector(appBecameActive),
            name: UIApplication.didBecomeActiveNotification, object: nil
        )
    }

    /// A live video call's picture is on screen in `view`: PiP is ready to
    /// take over when the app goes to the background.
    func attach(_ view: UIView, call: Call) {
        guard AVPictureInPictureController.isPictureInPictureSupported() else { return }
        self.call = call
        source = view
        let content = self.content ?? CallPiPContentController()
        self.content = content
        content.show(call)
        let contentSource = AVPictureInPictureController.ContentSource(
            activeVideoCallSourceView: view,
            contentViewController: content
        )
        if let controller {
            controller.contentSource = contentSource
        } else {
            let controller = AVPictureInPictureController(contentSource: contentSource)
            controller.delegate = self
            controller.canStartPictureInPictureAutomaticallyFromInline = true
            self.controller = controller
        }
    }

    /// The same call, changed: the remote camera came or went, or the call
    /// screen's restore changed.
    func update(_ call: Call) {
        guard self.call?.owner == call.owner else { return }
        self.call = call
        content?.show(call)
    }

    /// The PiP is armed for `owner`'s call, with `view` as its source.
    func holds(_ owner: String, source view: UIView) -> Bool {
        call?.owner == owner && source === view && controller != nil
    }

    /// `view` left the screen. A PiP window already up stays up — the member
    /// is in another app — and comes back to whichever view attaches next;
    /// otherwise nothing is left to start one from.
    func detach(_ view: UIView) {
        guard source === view, !isActive else { return }
        source = nil
        controller?.canStartPictureInPictureAutomaticallyFromInline = false
        controller = nil
    }

    /// `owner`'s call is over, or is no longer a video call on screen: its
    /// PiP window closes and lets go of the picture. Another call's PiP is
    /// left alone.
    func end(owner: String) {
        guard call?.owner == owner else { return }
        controller?.stopPictureInPicture()
        controller?.canStartPictureInPictureAutomaticallyFromInline = false
        controller = nil
        content?.show(nil)
        content = nil
        call = nil
        source = nil
        isActive = false
    }

    /// Back in the app some other way than PiP's own button (its icon, the
    /// call's green pill): the picture goes back into the call screen.
    @objc private func appBecameActive() {
        guard isActive else { return }
        controller?.stopPictureInPicture()
    }
}

extension CallPictureInPicture: @preconcurrency AVPictureInPictureControllerDelegate {
    func pictureInPictureControllerWillStartPictureInPicture(_ controller: AVPictureInPictureController) {
        isActive = true
    }

    func pictureInPictureControllerDidStopPictureInPicture(_ controller: AVPictureInPictureController) {
        isActive = false
        // The view that started it may have gone meanwhile (the call screen
        // gave way to the floating view): nothing to start the next one from.
        if source == nil { self.controller = nil }
    }

    func pictureInPictureController(
        _ controller: AVPictureInPictureController,
        failedToStartPictureInPictureWithError error: Error
    ) {
        isActive = false
    }

    /// The member tapped the PiP window to come back: the call screen opens
    /// full before the picture flies back into it.
    func pictureInPictureController(
        _ controller: AVPictureInPictureController,
        restoreUserInterfaceForPictureInPictureStopWithCompletionHandler completionHandler: @escaping (Bool) -> Void
    ) {
        call?.restore()
        completionHandler(true)
    }
}

/// What the PiP window draws: the remote camera, edge to edge, over the
/// colleague's (or visitor's) face on the call's dark backdrop for while
/// their camera is off — never a letter.
final class CallPiPContentController: AVPictureInPictureVideoCallViewController {
    private let video = VideoView()
    private let face = UIHostingController(rootView: CallPiPFace(name: "", avatarURL: nil, subject: .member))

    init() {
        super.init(nibName: nil, bundle: nil)
        // A phone's camera, upright: the shape the window opens in.
        preferredContentSize = CGSize(width: 360, height: 640)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black

        addChild(face)
        face.view.backgroundColor = .black
        face.view.frame = view.bounds
        face.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(face.view)
        face.didMove(toParent: self)

        // Sample buffers: drawn in the background, where PiP lives.
        video.renderMode = .sampleBuffer
        video.layoutMode = .fill
        video.mirrorMode = .off
        video.frame = view.bounds
        video.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(video)
    }

    func show(_ call: CallPictureInPicture.Call?) {
        loadViewIfNeeded()
        video.track = call?.track
        video.isHidden = call?.track == nil
        face.rootView = CallPiPFace(
            name: call?.name ?? "",
            avatarURL: call?.avatarURL,
            subject: call?.subject ?? .member
        )
    }
}

/// The face in the PiP window while the remote camera is off.
struct CallPiPFace: View {
    let name: String
    let avatarURL: String?
    let subject: AvatarSkeleton.Subject

    var body: some View {
        ZStack {
            CallBackdrop(photoURL: avatarURL)
            Avatar(name: name, imageURL: avatarURL, size: 120, subject: subject)
        }
        .environment(\.colorScheme, .dark)
    }
}

/// Where the call screen hands its picture to `CallPictureInPicture`: a
/// plain view behind the video, the size of it, which PiP grows out of and
/// back into. Present only while a live video call is on screen.
struct CallPiPSource: UIViewRepresentable {
    let call: CallPictureInPicture.Call

    func makeUIView(context: Context) -> Anchor {
        let anchor = Anchor()
        anchor.isUserInteractionEnabled = false
        anchor.backgroundColor = .clear
        return anchor
    }

    func updateUIView(_ anchor: Anchor, context: Context) {
        anchor.call = call
        anchor.sync()
    }

    static func dismantleUIView(_ anchor: Anchor, coordinator: ()) {
        CallPictureInPicture.shared.detach(anchor)
    }

    final class Anchor: UIView {
        var call: CallPictureInPicture.Call?

        override func didMoveToWindow() {
            super.didMoveToWindow()
            sync()
        }

        /// Updates its own PiP, and arms it again whenever the shared one
        /// is not (or no longer) this call's from this view — another call's
        /// end, or a view that took over and left.
        func sync() {
            guard let call else { return }
            guard window != nil else {
                CallPictureInPicture.shared.detach(self)
                return
            }
            if CallPictureInPicture.shared.holds(call.owner, source: self) {
                CallPictureInPicture.shared.update(call)
            } else {
                CallPictureInPicture.shared.attach(self, call: call)
            }
        }
    }
}

/// The member's own camera and multitasking: on, where iOS allows it.
enum CallCamera {
    /// Lets the camera keep running while the app is in PiP — which iOS
    /// allows an iPhone app only with Apple's multitasking camera
    /// entitlement. Without it `isMultitaskingAccessSupported` is false and
    /// nothing changes: the camera pauses in the background and resumes on
    /// return. Called once the camera is published.
    @MainActor
    static func allowWhileMultitasking(_ participant: LocalParticipant) {
        guard let track = participant.firstCameraPublication?.track as? LocalVideoTrack,
              let camera = track.capturer as? CameraCapturer,
              camera.isMultitaskingAccessSupported,
              !camera.isMultitaskingAccessEnabled
        else { return }
        camera.captureSession.beginConfiguration()
        camera.isMultitaskingAccessEnabled = true
        camera.captureSession.commitConfiguration()
    }
}
