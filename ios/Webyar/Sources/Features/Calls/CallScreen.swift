import SwiftUI
import LiveKit

/// The call, from "ringing their browser" to "over".
///
/// One screen for all four phases rather than a flow of screens: a call is a
/// single continuous thing to the person on it, and pushing them between
/// views as the state changes would make a two-second connection feel like a
/// journey. What changes is the middle of the screen; the controls stay where
/// the thumb left them.
struct CallScreen: View {
    @Bindable var session: CallSession
    let language: Language
    let onClose: () -> Void

    /// Whether the header and controls are on screen. They get out of the
    /// way of a full-screen picture and come back on a tap.
    @State private var chromeVisible = true
    @State private var hideTask: Task<Void, Never>?
    /// Where the header, the controls and the safe area are over the
    /// picture, for the small picture to settle clear of them.
    @State private var frames = CallScreenFrames()

    var body: some View {
        ZStack {
            if isFullScreenVideo {
                // The safe area, measured: what the small picture keeps
                // inside while the controls are away.
                Color.clear
                    .allowsHitTesting(false)
                    .accessibilityHidden(true)
                    .callScreenFrame { frames.safeArea = $0 }

                // Their video *is* the screen, edge to edge and under the
                // status bar — the way a video call has looked since anyone
                // started making them on a phone. Everything else floats on
                // top of it.
                VideoStage(
                    remote: session.remoteVideoTrack,
                    local: session.localVideoTrack,
                    contactName: session.contactName,
                    contactAvatarURL: session.contactAvatarURL,
                    language: language,
                    visitor: session.visitor,
                    freeArea: frames.free(chromeVisible: chromeVisible)
                )
                .ignoresSafeArea()
                .callScreenFrame { frames.stage = $0 }
                .onTapGesture { revealChrome() }
            } else {
                backdrop
                portrait
            }

            if isFullScreenVideo {
                chrome
                    .opacity(chromeVisible ? 1 : 0)
                    .animation(Theme.Motion.standard, value: chromeVisible)
                    .allowsHitTesting(chromeVisible)
            }
        }
        .coordinateSpace(.named(CallScreenFrames.space))
        .preferredColorScheme(.dark)
        .statusBarHidden(isFullScreenVideo && !chromeVisible)
        .task { session.start() }
        // A video call is watched, not touched. Left to Auto-Lock the screen
        // locks, the app goes to the background and iOS stops the camera.
        .onChange(of: keepsScreenAwake, initial: true) { _, awake in
            UIApplication.shared.isIdleTimerDisabled = awake
        }
        .onDisappear { UIApplication.shared.isIdleTimerDisabled = false }
        .onChange(of: session.phase) { _, phase in
            // An ended call lingers for a moment so the outcome can be read,
            // then gets out of the way on its own. Nobody wants to dismiss a
            // call that is already over.
            guard case .ended = phase else {
                // Arriving at the video screen starts the countdown that
                // clears the controls away from the picture.
                revealChrome()
                return
            }
            chromeVisible = true
            Task {
                try? await Task.sleep(for: .seconds(2))
                onClose()
            }
        }
    }

    /// A connected video call fills the screen, and keeps filling it.
    ///
    /// Deliberately not conditional on a picture actually arriving: a visitor
    /// who turns their camera off for a moment would otherwise throw the
    /// operator back to the portrait layout and then forward again, and a
    /// call that rearranges itself under the thumb is worse than one with a
    /// face on a black background for a few seconds.
    private var isFullScreenVideo: Bool {
        session.channel == .video && session.phase == .connected
    }

    private var keepsScreenAwake: Bool {
        session.channel == .video && session.phase.isLive
    }

    /// The audio layout, and every layout before the picture arrives: name at
    /// the top, face in the middle, controls at the bottom.
    private var portrait: some View {
        VStack(spacing: 0) {
            header
            Spacer(minLength: Theme.Space.lg)
            stage
            Spacer(minLength: Theme.Space.lg)
            controls
        }
        .padding(.horizontal, Theme.Space.xl)
        .padding(.vertical, Theme.Space.xxl)
    }

    /// What floats over the picture: the same header and controls, with just
    /// enough shading behind them to stay readable over anything.
    private var chrome: some View {
        VStack(spacing: 0) {
            header
                .padding(.horizontal, Theme.Space.xl)
                .padding(.top, Theme.Space.sm)
                .padding(.bottom, Theme.Space.xl)
                .background(
                    LinearGradient(
                        colors: [.black.opacity(0.6), .clear],
                        startPoint: .top,
                        endPoint: .bottom
                    )
                    .ignoresSafeArea(edges: .top)
                )
                // The small picture settles below this, shading included:
                // the gradient takes touches, and darkens what is under it.
                .callScreenFrame { frames.header = $0 }

            Spacer()

            controls
                .padding(.horizontal, Theme.Space.xl)
                .padding(.top, Theme.Space.xxl)
                .padding(.bottom, Theme.Space.lg)
                .background(
                    LinearGradient(
                        colors: [.clear, .black.opacity(0.65)],
                        startPoint: .top,
                        endPoint: .bottom
                    )
                    .ignoresSafeArea(edges: .bottom)
                )
                // …and above this.
                .callScreenFrame { frames.controls = $0 }
        }
    }

    /// Brings the controls back and starts the clock on hiding them again.
    ///
    /// Auto-hiding is the whole point of a full-screen call: the picture is
    /// what the operator is there for, and a row of buttons sitting on the
    /// visitor's face for the length of the call is the thing every other
    /// call app learned to get out of the way.
    private func revealChrome() {
        chromeVisible = true
        hideTask?.cancel()
        guard isFullScreenVideo else { return }
        hideTask = Task {
            try? await Task.sleep(for: .seconds(5))
            guard !Task.isCancelled else { return }
            chromeVisible = false
        }
    }

    // MARK: - Pieces

    private var backdrop: some View {
        LinearGradient(
            colors: [Color(uiColor: .systemIndigo).opacity(0.5), .black],
            startPoint: .top,
            endPoint: .bottom
        )
        .ignoresSafeArea()
    }

    private var header: some View {
        VStack(spacing: Theme.Space.xs) {
            Text(session.contactName)
                .font(.app(.title2, .semibold))
                .foregroundStyle(.white)
                .lineLimit(1)

            statusLine
                .font(.app(.subheadline, design: .rounded))
                .foregroundStyle(.white.opacity(0.75))
                .monospacedDigit()

            // Two different warnings, both worth saying out loud rather than
            // only in a log: one explains why a call fails on a train, the
            // other why the person on the other end cannot see or hear.
            if let degraded = session.degraded, session.phase == .connected {
                notice(degraded.title(language))
            } else if session.relayWarning, session.phase.isLive {
                notice(Str.callRelayWarning(language))
            }
        }
    }

    private func notice(_ text: String) -> some View {
        Label(text, systemImage: "exclamationmark.triangle.fill")
            .font(Theme.Typo.meta)
            .foregroundStyle(Theme.Palette.warning)
            .multilineTextAlignment(.center)
            .padding(.top, Theme.Space.xs)
    }

    @ViewBuilder
    private var statusLine: some View {
        switch session.phase {
        case .waiting:
            Text(Str.inviteSent(language))
        case .connecting:
            Text(Str.connectingCall(language))
        case .connected:
            if let connectedAt = session.connectedAt {
                TimelineView(.periodic(from: connectedAt, by: 1)) { context in
                    Text(Format.callDuration(from: connectedAt, to: context.date, locale: language.locale))
                }
            }
        case .ended(let outcome):
            Text(outcome.title(language))
        }
    }

    /// The middle of the audio layout: their face, and a ring while the
    /// invitation is still out.
    private var stage: some View {
        Avatar(
            name: session.contactName,
            imageURL: session.contactAvatarURL,
            size: 140,
            os: session.visitor?.device?.os,
            device: session.visitor?.device?.device,
            countryCode: session.visitor?.geo?.countryCode
        )
        .shadow(color: .black.opacity(0.35), radius: 24, y: 10)
        .overlay(alignment: .bottom) {
            if session.phase == .waiting {
                PulsingRing()
            }
        }
    }

    private var controls: some View {
        HStack(spacing: Theme.Space.xl) {
            if session.phase.isLive {
                CallButton(
                    icon: session.isMuted ? "mic.slash.fill" : "mic.fill",
                    title: Str.mute(language),
                    isOn: session.isMuted
                ) {
                    session.toggleMute()
                }
                .disabled(session.phase != .connected)

                if session.channel == .video {
                    CallButton(
                        icon: session.isCameraOn ? "video.fill" : "video.slash.fill",
                        title: Str.camera(language),
                        isOn: !session.isCameraOn
                    ) {
                        session.toggleCamera()
                    }
                    .disabled(session.phase != .connected)
                } else {
                    CallButton(
                        icon: session.isSpeakerOn ? "speaker.wave.2.fill" : "speaker.fill",
                        title: Str.speaker(language),
                        isOn: session.isSpeakerOn
                    ) {
                        session.toggleSpeaker()
                    }
                    .disabled(session.phase != .connected)
                }
            }

            CallButton(
                icon: "phone.down.fill",
                title: session.phase.isLive ? Str.hangUpCall(language) : Str.done(language),
                tint: Theme.Palette.danger
            ) {
                if session.phase.isLive {
                    Task { await session.hangUp() }
                } else {
                    onClose()
                }
            }
        }
    }
}

/// The other side's video, with the member's own camera in a small picture
/// over it — a visitor's call, or a colleague's (`TeamCallScreen`).
///
/// The small picture (CallPicture.swift, Android's `SelfView`):
/// - **Drag** it anywhere; let go and it settles into the nearest corner of
///   `freeArea` — below the header, above the controls, inside the safe area
///   — with a spring (none under Reduce Motion). A flick carries it towards
///   the corner it was thrown at. The corner is the glass's, not the
///   language's, and the phone remembers it for the next call.
/// - **Tap** it and the two swap: the member's own camera large, the other
///   side small (their face, when their camera is off). Tap again to swap
///   back. A drag is never a tap: one gesture decides which it was.
/// - Its own camera going off puts everything back as the call opened.
///
/// Both tracks arrive as plain values from the session rather than being dug
/// out of `Room` here: the room is not something SwiftUI watches, so a view
/// that reads it directly shows whatever was true at its last redraw.
struct VideoStage: View {
    let remote: VideoTrack?
    let local: VideoTrack?
    let contactName: String
    let contactAvatarURL: String?
    /// The language the small picture's VoiceOver label and actions speak.
    let language: Language
    var visitor: VisitorProfile?
    /// A visitor's face, or a colleague's (`.member`) — which decides the
    /// silhouette when there is no picture.
    var subject: AvatarSkeleton.Subject = .person
    /// The member's own camera. A visitor call only ever uses the front
    /// camera, so it is always mirrored; a colleague call can switch to the
    /// back one, which `.auto` leaves the right way round. Wherever it is
    /// drawn, large or small, it keeps this; the other side's never mirrors.
    var localMirror: VideoView.MirrorMode = .mirror
    /// The part of the stage the small picture may settle in, in the stage's
    /// own coordinates (`CallScreenFrames.free`): what the call screen's
    /// header and controls leave, when they are showing. Nil: the stage's own
    /// safe area.
    var freeArea: CGRect? = nil

    /// The coordinate space the small picture is laid out and dragged in.
    private static let pictureSpace = "call.picture"
    /// The settle: a little give, no wobble — Android's spring, near enough.
    private static let settleSpring = Animation.spring(response: 0.32, dampingFraction: 0.8)

    @State private var corner = CallPicturePlacement.corner()
    @State private var pictures = CallPictureSwap()
    @State private var touch = CallPictureTouch()
    /// Where the small picture's centre is while a finger has it; nil once
    /// it has settled into its corner.
    @State private var dragCenter: CGPoint? = nil
    /// `freeArea` as the small picture follows it (`follow(_:_:)`); nil
    /// until it first changes, when `freeArea` itself is used.
    @State private var shownArea: CGRect? = nil
    /// True while a finger is on the small picture; back to false however the
    /// touch ends, including when the system takes it away.
    @GestureState private var touching = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.layoutDirection) private var layoutDirection

    var body: some View {
        ZStack {
            // Black behind everything, so letterboxing and the moment
            // before the first frame both read as "a call", not as a
            // broken layout.
            Color.black

            if let track = largeTrack {
                SwiftUIVideoView(track, layoutMode: .fill, mirrorMode: largeMirror)
            } else {
                // Connected, with nothing coming from their camera —
                // switched off, or never there. Their face says the call
                // is fine and the picture is not; a spinner that never
                // resolves would say the opposite.
                face(size: 140)
                    .shadow(color: .black.opacity(0.35), radius: 24, y: 10)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .overlay { pictureLayer }
        .onChange(of: freeArea) { old, new in follow(old, new) }
        .onChange(of: localID) { _, id in
            // Their camera off, or another track: theirs is large again,
            // and stays so when it comes back.
            pictures.localChanged(to: id)
            if id == nil {
                touch = CallPictureTouch()
                dragCenter = nil
            }
        }
    }

    // MARK: - Which picture is where

    /// The own track on screen, by identity: a camera that goes off and on
    /// again, or a replaced track, is a fresh start for the swap.
    private var localID: ObjectIdentifier? {
        local.map { ObjectIdentifier($0) }
    }

    private var swapped: Bool { pictures.isSwapped(local: localID) }

    private var largeTrack: VideoTrack? { swapped ? local : remote }
    private var largeMirror: VideoView.MirrorMode { swapped ? localMirror : .auto }
    private var smallTrack: VideoTrack? { swapped ? remote : local }
    private var smallMirror: VideoView.MirrorMode { swapped ? .auto : localMirror }

    /// Their photo or their silhouette — never their initials.
    private func face(size: CGFloat) -> some View {
        Avatar(
            name: contactName,
            imageURL: contactAvatarURL,
            size: size,
            subject: subject,
            os: visitor?.device?.os,
            device: visitor?.device?.device,
            countryCode: visitor?.geo?.countryCode
        )
    }

    private var motion: Animation? { reduceMotion ? nil : Self.settleSpring }

    // MARK: - The small picture

    /// Only while the member's own camera is on: without it there is nothing
    /// to show small, and nothing to swap.
    ///
    /// Laid out left to right whatever the app's language, so a corner is the
    /// glass's corner — a Persian or Arabic screen does not move it across —
    /// and the finger and the picture agree on which way is right. What is
    /// inside the picture keeps the app's direction.
    @ViewBuilder
    private var pictureLayer: some View {
        if local != nil {
            GeometryReader { proxy in
                let bounds = CGRect(origin: .zero, size: proxy.size)
                let insets = proxy.safeAreaInsets
                let fallback = CGRect(
                    x: insets.leading,
                    y: insets.top,
                    width: max(0, proxy.size.width - insets.leading - insets.trailing),
                    height: max(0, proxy.size.height - insets.top - insets.bottom)
                )
                let room = CallPictureLayout.room(free: shownArea ?? freeArea, fallback: fallback)
                let size = CallPictureLayout.fittedSize(in: room)
                let settled = CallPictureLayout.center(at: corner, size: size, in: room)

                smallPicture(size: size)
                    .gesture(drag(settled: settled, size: size, bounds: bounds, room: room))
                    .onChange(of: touching) { _, isTouching in
                        // The system took the touch away mid-drag — a call
                        // coming in, Control Centre: no end, and no tap. The
                        // picture settles where it was.
                        guard !isTouching, let center = dragCenter else { return }
                        settle(in: .nearest(to: center, in: room))
                    }
                    .position(dragCenter ?? settled)
            }
            .coordinateSpace(.named(Self.pictureSpace))
            .environment(\.layoutDirection, .leftToRight)
        }
    }

    private func smallPicture(size: CGSize) -> some View {
        let shape = RoundedRectangle(cornerRadius: Theme.Radius.lg, style: .continuous)
        return ZStack {
            if let track = smallTrack {
                // Its own touches are the picture's: the renderer is a UIKit
                // view, and the drag and the tap belong to the card.
                SwiftUIVideoView(track, layoutMode: .fill, mirrorMode: smallMirror)
                    .allowsHitTesting(false)
            } else {
                // Swapped, and their camera is off: their face on a dark
                // tile, as the large picture would show it.
                Color(white: 0.14)
                face(size: min(56, size.width * 0.6))
            }
        }
        .environment(\.layoutDirection, layoutDirection)
        .frame(width: size.width, height: size.height)
        .clipShape(shape)
        .overlay(shape.strokeBorder(.white.opacity(0.25), lineWidth: 0.5))
        .contentShape(shape)
        .shadow(color: .black.opacity(0.4), radius: 12, y: 4)
        // One element for VoiceOver: what is small, what is large, a
        // double-tap that swaps, and the corners one by one.
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(swapped ? Str.callPictureTheirsSmall(language) : Str.callPictureYoursSmall(language))
        .accessibilityHint(Str.callPictureSwapHint(language))
        .accessibilityAddTraits(.isButton)
        .accessibilityAction { swapPictures() }
        .accessibilityAction(named: Text(Str.callPictureSwap(language))) { swapPictures() }
        .accessibilityAction(named: Text(Str.callPictureMove(language))) { settle(in: corner.next) }
    }

    /// Tap and drag in one gesture, so they can never both happen: the touch
    /// is a tap until the finger has travelled past the slop
    /// (`CallPictureTouch`), and only a touch that never did swaps the
    /// pictures when it lifts. `minimumDistance: 0` takes the touch from the
    /// first moment, so the stage's own tap (the controls) never sees it.
    private func drag(settled: CGPoint, size: CGSize, bounds: CGRect, room: CGRect) -> some Gesture {
        DragGesture(minimumDistance: 0, coordinateSpace: .named(Self.pictureSpace))
            .updating($touching) { _, state, _ in state = true }
            .onChanged { value in
                touch.track(start: value.startLocation, translation: value.translation, origin: dragCenter ?? settled)
                guard touch.isDrag else { return }
                dragCenter = CallPictureLayout.clamped(touch.center(translation: value.translation), size: size, in: bounds)
            }
            .onEnded { value in
                var ended = touch
                ended.track(start: value.startLocation, translation: value.translation, origin: dragCenter ?? settled)
                touch = CallPictureTouch()
                guard ended.isDrag else {
                    swapPictures()
                    return
                }
                let released = CallPictureLayout.clamped(ended.center(translation: value.translation), size: size, in: bounds)
                settle(in: CallPictureLayout.corner(releasedAt: released, velocity: value.velocity, in: room))
            }
    }

    /// The room changed under the picture — the controls fading in or out,
    /// the header growing a line, the status bar going — and the picture
    /// follows, springing from its corner to the same corner of the new room.
    /// Not from before the screen was first measured, though: that is no
    /// place it was ever seen, and a call should not open with it flying in.
    private func follow(_ old: CGRect?, _ new: CGRect?) {
        guard old != nil, new != nil else {
            shownArea = new
            return
        }
        withAnimation(motion) { shownArea = new }
    }

    private func swapPictures() {
        pictures.toggle(local: localID)
    }

    /// Into `next` corner, springing there from wherever it is, and
    /// remembered for the next call.
    private func settle(in next: CallPictureCorner) {
        withAnimation(motion) {
            corner = next
            dragCenter = nil
        }
        CallPicturePlacement.remember(next)
    }
}

extension View {
    /// Reports this view's frame in the call screen's coordinate space
    /// (`CallScreenFrames.space`) whenever it changes, for the small picture
    /// to keep out of the way of what the screen draws over the stage.
    func callScreenFrame(_ report: @escaping (CGRect) -> Void) -> some View {
        onGeometryChange(for: CGRect.self) { proxy in
            proxy.frame(in: .named(CallScreenFrames.space))
        } action: { frame in
            report(frame)
        }
    }
}

/// A slow ring while the invitation is out — the visual equivalent of a
/// ringing tone, so the wait does not look like a frozen screen.
struct PulsingRing: View {
    @State private var expanded = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Circle()
            .stroke(.white.opacity(0.35), lineWidth: 2)
            .frame(width: 150, height: 150)
            .scaleEffect(expanded ? 1.25 : 1)
            .opacity(expanded ? 0 : 1)
            .onAppear {
                guard !reduceMotion else { return }
                withAnimation(.easeOut(duration: 1.6).repeatForever(autoreverses: false)) {
                    expanded = true
                }
            }
            .allowsHitTesting(false)
            .accessibilityHidden(true)
    }
}

/// One round control with its label, sized for a thumb.
///
/// The label has a width of its own and may take two lines, so four of these
/// in a row — a colleague's video call — still fit the narrowest iPhone in
/// every language ("Kamerayı değiştir").
struct CallButton: View {
    let icon: String
    let title: String
    var isOn: Bool = false
    var tint: Color?
    let action: () -> Void

    var body: some View {
        VStack(spacing: Theme.Space.sm) {
            Button(action: action) {
                Image(systemName: icon)
                    .font(.system(size: 24, weight: .medium))
                    .foregroundStyle(tint == nil && isOn ? .black : .white)
                    .frame(width: 66, height: 66)
                    .background(
                        Circle().fill(tint ?? (isOn ? .white : .white.opacity(0.18)))
                    )
            }
            .buttonStyle(.plain)

            Text(title)
                .font(Theme.Typo.meta)
                .foregroundStyle(.white.opacity(0.8))
                .multilineTextAlignment(.center)
                .lineLimit(2)
                .frame(width: 76)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(title)
        .accessibilityAddTraits(isOn ? [.isSelected, .isButton] : .isButton)
    }
}

extension CallOutcome {
    func title(_ language: Language) -> String {
        switch self {
        case .hungUp, .visitorLeft: Str.callEnded(language)
        case .declined: Str.callDeclined(language)
        case .expired: Str.callNoAnswer(language)
        case .failed: Str.callFailed(language)
        }
    }
}

/// Owns the call for as long as it is on screen.
///
/// The session has to be created once and live for the whole call. Building
/// it inside the presentation's content closure would make a new one on every
/// re-render — a fresh poll, a fresh room, a call that restarts itself while
/// somebody is talking into it.
struct CallHost: View {
    let language: Language
    let onClose: () -> Void

    @State private var session: CallSession

    init(
        invitation: CallInvitation,
        contactName: String,
        contactAvatarURL: String?,
        visitor: VisitorProfile?,
        language: Language,
        onClose: @escaping () -> Void
    ) {
        self.language = language
        self.onClose = onClose
        _session = State(
            initialValue: CallSession(
                invitation: invitation,
                contactName: contactName,
                contactAvatarURL: contactAvatarURL,
                visitor: visitor
            )
        )
    }

    /// This screen in `VisitorCallScreens`, for as long as it is up.
    @State private var presence = UUID()

    var body: some View {
        CallScreen(session: session, language: language, onClose: onClose)
            .onAppear { VisitorCallScreens.shared.opened(presence) }
            .onDisappear {
                VisitorCallScreens.shared.closed(presence)
                // Taken off screen from outside (a workspace switch or a sign-out pops the
                // conversation it was presented from): nothing would be left to hang up with,
                // the room and microphone would stay open and the server would keep the call.
                // Nothing is ever presented over this screen, so this is only ever the end.
                if session.phase.isLive { Task { await session.hangUp() } }
            }
    }
}

/// The visitor calls whose screen is up (`CallHost`), for the one thing
/// outside a call that has to know: the lock over the app when its plan has
/// the mobile app off (`SignedInRoot`, docs/operations/MOBILE_APP_PLAN.md).
/// A visitor call's screen is presented from the conversation it was placed
/// in, so taking the app off screen would take the call with it — and a call
/// already on is never cut by a lock. The lock waits for the call to close.
/// (A colleague call has a window of its own, `TeamCallWindow`, and never
/// needs this.)
@MainActor
@Observable
final class VisitorCallScreens {
    static let shared = VisitorCallScreens()

    private(set) var open: Set<UUID> = []

    var isOn: Bool { !open.isEmpty }

    func opened(_ screen: UUID) { _ = open.insert(screen) }
    func closed(_ screen: UUID) { _ = open.remove(screen) }
}
