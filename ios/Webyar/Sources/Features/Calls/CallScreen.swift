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
    @ScaledMetric(relativeTo: .largeTitle) private var scaledFace: CGFloat = 152

    var body: some View {
        ZStack {
            // Opaque from the first layer: nothing of the conversation under
            // the cover shows through (owner, 2026-11-04).
            CallBackdrop(photoURL: session.contactAvatarURL)

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
                // iOS's picture-in-picture takes the visitor's picture over
                // when the operator leaves the app (`CallPictureInPicture`).
                .background(CallPiPSource(call: pictureInPicture))
                .ignoresSafeArea()
                .callScreenFrame { frames.stage = $0 }
                .onTapGesture { revealChrome() }
            } else {
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
            CallScreenAwake.set(.visitorCall, awake: awake)
        }
        .onDisappear {
            CallScreenAwake.set(.visitorCall, awake: false)
            CallPictureInPicture.shared.end(owner: pictureInPictureOwner)
        }
        .onChange(of: isFullScreenVideo) { _, video in
            if !video { CallPictureInPicture.shared.end(owner: pictureInPictureOwner) }
        }
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

    private var faceSize: CGFloat { min(scaledFace, 200) }

    /// This call's claim on the shared PiP: only its own end closes it.
    private var pictureInPictureOwner: String {
        "visitor-\(ObjectIdentifier(session).hashValue)"
    }

    private var pictureInPicture: CallPictureInPicture.Call {
        CallPictureInPicture.Call(
            track: session.remoteVideoTrack,
            name: session.contactName,
            avatarURL: session.contactAvatarURL,
            subject: .person,
            owner: pictureInPictureOwner,
            // The cover is still up under PiP: coming back is enough.
            restore: {}
        )
    }

    /// The audio layout, and every layout before the picture arrives: the
    /// kind of call at the top, the face in the middle with the name and the
    /// state under it, the controls on their tray at the bottom — the
    /// colleague call's layout (`TeamCallScreen`).
    private var portrait: some View {
        VStack(spacing: 0) {
            CallPill(
                text: session.channel == .video ? Str.teamCallLogVideo(language) : Str.teamCallLogVoice(language),
                icon: session.channel.icon
            )
            .padding(.top, Theme.Space.sm)
            Spacer(minLength: Theme.Space.lg)
            stage
            header
                .padding(.top, Theme.Space.xxl)
            Spacer(minLength: Theme.Space.lg)
            CallControlTray { controls }
        }
        .padding(.horizontal, Theme.Space.lg)
        .padding(.bottom, Theme.Space.lg)
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

    private var header: some View {
        VStack(spacing: Theme.Space.sm) {
            Text(session.contactName)
                .font(.app(.title, .bold))
                .foregroundStyle(.white)
                .multilineTextAlignment(.center)
                .lineLimit(isFullScreenVideo ? 1 : 2)
                .minimumScaleFactor(0.75)
                .accessibilityAddTraits(.isHeader)

            statusLine

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
            statusText(Str.inviteSent(language))
        case .connecting:
            statusText(Str.connectingCall(language))
        case .connected:
            if let connectedAt = session.connectedAt {
                TimelineView(.periodic(from: connectedAt, by: 1)) { context in
                    CallPill(text: Format.callDuration(from: connectedAt, to: context.date, locale: language.locale))
                        .monospacedDigit()
                }
            }
        case .ended(let outcome):
            statusText(outcome.title(language))
        }
    }

    private func statusText(_ text: String) -> some View {
        Text(text)
            .font(.app(.headline, .regular))
            .foregroundStyle(.white.opacity(0.78))
            .multilineTextAlignment(.center)
            .contentTransition(.opacity)
    }

    /// The middle of the audio layout: their face, and a ring while the
    /// invitation is still out.
    private var stage: some View {
        CallHalo(diameter: faceSize, ringing: session.phase == .waiting) {
            Avatar(
                name: session.contactName,
                imageURL: session.contactAvatarURL,
                size: faceSize,
                os: session.visitor?.device?.os,
                device: session.visitor?.device?.device,
                countryCode: session.visitor?.geo?.countryCode
            )
        }
    }

    private var controls: some View {
        HStack(alignment: .top, spacing: Theme.Space.xl) {
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

/// One round control with its label, sized for a thumb.
///
/// The label has a width of its own and may take two lines, so four of these
/// in a row — a colleague's video call — still fit the narrowest iPhone in
/// every language ("Kamerayı değiştir").
///
/// `prominent` is a ring's Answer and Decline: larger, so neither is missed
/// and neither is hit by mistake; `beckons` makes Answer breathe gently (not
/// under Reduce Motion).
struct CallButton: View {
    let icon: String
    let title: String
    var isOn: Bool = false
    var tint: Color?
    var prominent: Bool = false
    var beckons: Bool = false
    let action: () -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.isEnabled) private var isEnabled

    private var diameter: CGFloat { prominent ? 78 : 62 }

    var body: some View {
        VStack(spacing: Theme.Space.sm) {
            Button(action: action) {
                Image(systemName: icon)
                    .font(.system(size: prominent ? 30 : 23, weight: .semibold))
                    .foregroundStyle(tint == nil && isOn ? .black : .white)
                    .frame(width: diameter, height: diameter)
                    .background(
                        Circle().fill(tint ?? (isOn ? .white : .white.opacity(0.16)))
                    )
                    .overlay(
                        Circle().strokeBorder(.white.opacity(tint == nil && !isOn ? 0.12 : 0), lineWidth: 1)
                    )
                    .shadow(color: (tint ?? .clear).opacity(prominent ? 0.45 : 0), radius: 14, y: 6)
                    .modifier(Beckon(active: beckons && !reduceMotion))
                    .opacity(isEnabled ? 1 : 0.45)
            }
            .buttonStyle(CallButtonPress())

            Text(title)
                .font(prominent ? .app(.subheadline, .semibold) : Theme.Typo.meta)
                .foregroundStyle(.white.opacity(prominent ? 0.95 : 0.8))
                .multilineTextAlignment(.center)
                .lineLimit(2)
                .minimumScaleFactor(0.75)
                .frame(width: prominent ? 96 : 78)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(title)
        .accessibilityAddTraits(isOn ? [.isSelected, .isButton] : .isButton)
    }
}

/// A press shrinks the control a little, as the system's call buttons do.
private struct CallButtonPress: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.92 : 1)
            .animation(.easeOut(duration: 0.15), value: configuration.isPressed)
    }
}

/// Answer's slow breath while a call rings.
private struct Beckon: ViewModifier {
    let active: Bool

    func body(content: Content) -> some View {
        if active {
            content.phaseAnimator([false, true]) { view, up in
                view.scaleEffect(up ? 1.07 : 1)
            } animation: { _ in
                .easeInOut(duration: 0.9)
            }
        } else {
            content
        }
    }
}

extension CallOutcome {
    func title(_ language: Language) -> String {
        switch self {
        case .hungUp, .visitorLeft: Str.callEnded(language)
        case .declined: Str.callDeclined(language)
        case .expired: Str.callNoAnswer(language)
        case .failed(let reason) where reason == CallSession.colleagueCallReason:
            Str.callEndedForColleagueCall(language)
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
        self.invitation = invitation
        _session = State(
            initialValue: CallSession(
                invitation: invitation,
                contactName: contactName,
                contactAvatarURL: contactAvatarURL,
                visitor: visitor
            )
        )
    }

    /// The invitation this screen is for, its key in `VisitorCallScreens`.
    private let invitation: CallInvitation

    var body: some View {
        CallScreen(session: session, language: language, onClose: onClose)
            .onAppear { VisitorCallScreens.shared.opened(invitation, phase: session.phase) }
            .onChange(of: session.phase) { _, phase in
                VisitorCallScreens.shared.changed(invitation.id, phase: phase)
            }
            .onDisappear {
                VisitorCallScreens.shared.closed(invitation.id)
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

    /// One visitor call, from its invitation request to its screen closing.
    struct Entry: Equatable {
        var phase: CallPhase
        /// When the invitation runs out; nil while it is being requested.
        var expiresAt: Date?
        /// A screen has taken this entry over (`CallHost`).
        var claimed = false
    }

    /// What a visitor call means for a colleague's ring
    /// (`CallManager.reportIncoming`, docs/operations/TEAM_CALLS.md, "iOS").
    enum Busy: Equatable {
        /// No visitor call this phone is in: the ring rings.
        case none
        /// The visitor is being invited (the request, or a screen still
        /// waiting, even past the invitation's expiry: the visitor may have
        /// answered while the app was suspended, and the screen learns it at
        /// its next poll): the ring is ended on this phone only — no room,
        /// no audio yet, and the member's other phones may still answer.
        case inviting
        /// Joining or in the visitor's room: the ring is declined.
        case live
    }

    private(set) var calls: [String: Entry] = [:]

    /// How long past its invitation's expiry a waiting screen still counts:
    /// enough for a suspended app to wake and poll. A join later than this
    /// fails safely anyway — the token route refuses a finished call.
    static let lateJoinGrace: TimeInterval = 5 * 60

    /// A visitor call's screen is up, or about to be: what the plan lock
    /// waits on (`SignedInRoot`).
    var isOn: Bool { !calls.isEmpty }

    /// Busy, for a colleague's ring arriving `now`. An ended screen left
    /// behind is not a call. A waiting one is, whatever its expiry says: an
    /// invitation answered before it ran out never expires, and a suspended
    /// app has not polled to find out — at worst one ring on this phone is
    /// lost while the screen clears itself at its next poll.
    func busy(now: Date) -> Busy {
        var result = Busy.none
        for entry in calls.values {
            switch entry.phase {
            case .connecting, .connected:
                return .live
            case .waiting:
                if entry.expiresAt.map({ now < $0.addingTimeInterval(Self.lateJoinGrace) }) ?? true {
                    result = .inviting
                }
            case .ended:
                break
            }
        }
        return result
    }

    /// The invitation request is on its way (`ConversationActionsModel.invite`).
    func requesting(_ key: String) {
        calls[key] = Entry(phase: .waiting, expiresAt: nil)
    }

    /// The request came back with an invitation: the mark moves to its id,
    /// for the screen to take over. A screen that never comes (the cover was
    /// not presented) lets it go after a few seconds.
    func handOver(_ key: String, to invitation: CallInvitation) {
        calls[key] = nil
        let id = invitation.id
        calls[id] = calls[id] ?? Entry(
            phase: .waiting,
            expiresAt: invitation.expiresAt ?? Date().addingTimeInterval(120)
        )
        Task { [weak self] in
            try? await Task.sleep(for: .seconds(10))
            guard let self, let entry = self.calls[id], !entry.claimed else { return }
            self.calls[id] = nil
        }
    }

    func dropped(_ key: String) {
        calls[key] = nil
    }

    /// A screen for the invitation is up, in `phase`.
    func opened(_ invitation: CallInvitation, phase: CallPhase) {
        var entry = calls[invitation.id] ?? Entry(phase: phase, expiresAt: invitation.expiresAt)
        entry.phase = phase
        entry.claimed = true
        calls[invitation.id] = entry
    }

    func changed(_ invitationID: String, phase: CallPhase) {
        calls[invitationID]?.phase = phase
    }

    func closed(_ invitationID: String) {
        calls[invitationID] = nil
    }
}
