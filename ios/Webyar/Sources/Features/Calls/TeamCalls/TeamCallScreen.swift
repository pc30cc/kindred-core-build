import SwiftUI
import LiveKit

/// A colleague call, from "Calling…" (or "Incoming voice call") to "Call
/// ended". Drawn in a window of its own above the whole app from
/// `CallManager`'s state (`TeamCallWindow`), so it is there whichever screen
/// was open, a sheet or a photo full screen included — and when the call was
/// answered on the lock screen, before the app had drawn anything.
///
/// Opaque from its first layer (`CallBackdrop`): the window it lives in is
/// clear, and the app under it must never show through (owner, 2026-11-04).
///
/// Three layouts on one backdrop, the controls always at the bottom where
/// the thumb is:
/// - a ring here: the kind of call, the colleague's face with the ring
///   flowing out of it, their name, and large labelled Decline and Answer,
///   which go through CallKit exactly as the lock screen's do (CallKit's own
///   screen stays for the lock screen);
/// - the call: the face, the name, the state or the clock, and the controls
///   on a tray — mute, the speaker or the camera and its flip, hang up;
/// - a video call once both are in the room: the picture edge to edge, the
///   header and the controls fading off it, and the picture handed to iOS's
///   picture-in-picture when the member leaves the app
///   (`CallPictureInPicture`).
///
/// The chevron at the top minimises the call to a small floating view, so
/// the member can use the rest of the app (`TeamCallPresentation`).
struct TeamCallScreen: View {
    let manager: CallManager
    let call: ActiveTeamCall
    let language: Language

    @State private var chromeVisible = true
    @State private var hideTask: Task<Void, Never>?
    /// Where the header, the controls and the safe area are over the
    /// picture, for the small picture to settle clear of them (`VideoStage`).
    @State private var frames = CallScreenFrames()
    @ScaledMetric(relativeTo: .largeTitle) private var scaledFace: CGFloat = 152

    var body: some View {
        ZStack {
            CallBackdrop(photoURL: call.peerAvatarURL)

            if isFullScreenVideo {
                // The safe area, measured: what the small picture keeps
                // inside while the controls are away.
                Color.clear
                    .allowsHitTesting(false)
                    .accessibilityHidden(true)
                    .callScreenFrame { frames.safeArea = $0 }

                // A tap on the picture brings the controls back; one on the
                // small picture swaps the two instead, and a drag moves it —
                // its own gesture, which this one never sees.
                VideoStage(
                    remote: manager.remoteVideo,
                    local: manager.localVideo,
                    contactName: call.peerName(language),
                    contactAvatarURL: call.peerAvatarURL,
                    language: language,
                    subject: .member,
                    localMirror: .auto,
                    freeArea: frames.free(chromeVisible: chromeVisible)
                )
                // PiP grows out of this picture when the app goes to the
                // background, and back into it.
                .background(CallPiPSource(call: pictureInPicture))
                .ignoresSafeArea()
                .callScreenFrame { frames.stage = $0 }
                .onTapGesture { revealChrome() }

                // Above the picture, but only its header and controls take
                // touches: the middle is empty, so the small picture there
                // is dragged and tapped with the controls showing too.
                chrome
                    .opacity(chromeVisible ? 1 : 0)
                    .animation(Theme.Motion.standard, value: chromeVisible)
                    .allowsHitTesting(chromeVisible)
            } else if isRingingHere {
                incoming
                    .transition(.opacity)
            } else {
                portrait
                    .transition(.opacity)
            }
        }
        .animation(.easeInOut(duration: 0.3), value: isRingingHere)
        .coordinateSpace(.named(CallScreenFrames.space))
        .statusBarHidden(isFullScreenVideo && !chromeVisible)
        // A video call is watched, not touched: left to Auto-Lock the screen
        // locks and iOS stops the camera. A voice call has the proximity
        // sensor (`CallManager`) instead.
        .onChange(of: keepsScreenAwake, initial: true) { _, awake in
            UIApplication.shared.isIdleTimerDisabled = awake
        }
        .onDisappear { UIApplication.shared.isIdleTimerDisabled = false }
        .onChange(of: isFullScreenVideo) { _, _ in revealChrome() }
    }

    private var isFullScreenVideo: Bool {
        call.channel == .video && call.isLive
    }

    private var isRingingHere: Bool {
        call.direction == .incoming && call.phase == .ringing
    }

    private var keepsScreenAwake: Bool {
        call.channel == .video && !call.phase.isOver
    }

    /// The call can go to its floating view: it is on, and not ringing here
    /// (a ring is answered or declined, not put aside).
    private var canMinimize: Bool {
        !call.phase.isOver && !isRingingHere
    }

    private var faceSize: CGFloat { min(scaledFace, 200) }

    private var pictureInPicture: CallPictureInPicture.Call {
        CallPictureInPicture.Call(
            track: manager.remoteVideo,
            name: call.peerName(language),
            avatarURL: call.peerAvatarURL,
            subject: .member,
            owner: call.uuid.uuidString,
            restore: { TeamCallPresentation.shared.expand() }
        )
    }

    // MARK: - A ring here

    private var incoming: some View {
        VStack(spacing: 0) {
            CallPill(
                text: call.channel == .video ? Str.teamCallIncomingVideo(language) : Str.teamCallIncomingVoice(language),
                icon: call.channel.icon
            )
            .padding(.top, Theme.Space.lg)

            Spacer(minLength: Theme.Space.xl)

            CallHalo(diameter: faceSize, ringing: true) { face }

            Text(call.peerName(language))
                .font(.app(.largeTitle, .bold))
                .foregroundStyle(.white)
                .multilineTextAlignment(.center)
                .lineLimit(2)
                .minimumScaleFactor(0.7)
                .padding(.top, Theme.Space.huge + Theme.Space.sm)
                .accessibilityAddTraits(.isHeader)

            Spacer(minLength: Theme.Space.xl)

            HStack(alignment: .top) {
                CallButton(icon: "phone.down.fill", title: Str.teamCallDecline(language), tint: Theme.Palette.danger, prominent: true) {
                    manager.end()
                }
                Spacer(minLength: Theme.Space.lg)
                CallButton(icon: call.channel.icon, title: Str.teamCallAnswer(language), tint: Theme.Palette.success, prominent: true, beckons: true) {
                    manager.answer()
                }
            }
            .padding(.horizontal, Theme.Space.xl)
            .padding(.bottom, Theme.Space.xl)
        }
        .padding(.horizontal, Theme.Space.xl)
        .padding(.vertical, Theme.Space.lg)
    }

    // MARK: - The call

    private var portrait: some View {
        VStack(spacing: 0) {
            topBar
            Spacer(minLength: Theme.Space.lg)
            CallHalo(diameter: faceSize, ringing: call.isRinging) { face }
            header
                .padding(.top, Theme.Space.xxl)
            Spacer(minLength: Theme.Space.lg)
            controls
        }
        .padding(.horizontal, Theme.Space.lg)
        .padding(.top, Theme.Space.sm)
        .padding(.bottom, Theme.Space.lg)
    }

    /// Minimise at the leading edge, the kind of call in the middle.
    private var topBar: some View {
        HStack {
            if canMinimize {
                CallCornerButton(icon: "chevron.down", label: Str.teamCallMinimize(language)) {
                    TeamCallPresentation.shared.minimize()
                }
            } else {
                Color.clear.frame(width: Theme.Size.minTouchTarget, height: Theme.Size.minTouchTarget)
            }
            Spacer()
            CallPill(
                text: call.channel == .video ? Str.teamCallLogVideo(language) : Str.teamCallLogVoice(language),
                icon: call.channel.icon
            )
            Spacer()
            Color.clear.frame(width: Theme.Size.minTouchTarget, height: Theme.Size.minTouchTarget)
        }
    }

    private var chrome: some View {
        VStack(spacing: 0) {
            // The name, the clock and any warning in the flow, so they size
            // the bar (and its measured frame) and stay inside the safe
            // area; centred, clear of the chevron.
            ZStack(alignment: .top) {
                header
                    .padding(.horizontal, Theme.Size.minTouchTarget + Theme.Space.sm)
                    .frame(maxWidth: .infinity)
                HStack(alignment: .top) {
                    if canMinimize {
                        CallCornerButton(icon: "chevron.down", label: Str.teamCallMinimize(language)) {
                            TeamCallPresentation.shared.minimize()
                        }
                    }
                    Spacer(minLength: 0)
                }
            }
            .padding(.horizontal, Theme.Space.lg)
            .padding(.top, Theme.Space.sm)
            .padding(.bottom, Theme.Space.xl)
            .background(
                LinearGradient(colors: [.black.opacity(0.6), .clear], startPoint: .top, endPoint: .bottom)
                    .ignoresSafeArea(edges: .top)
            )
            // The small picture settles below this, shading included:
            // the gradient takes touches, and darkens what is under it.
            .callScreenFrame { frames.header = $0 }

            Spacer()

            controls
                .padding(.horizontal, Theme.Space.md)
                .padding(.top, Theme.Space.xxl)
                .padding(.bottom, Theme.Space.lg)
                .background(
                    LinearGradient(colors: [.clear, .black.opacity(0.65)], startPoint: .top, endPoint: .bottom)
                        .ignoresSafeArea(edges: .bottom)
                )
                // …and above this.
                .callScreenFrame { frames.controls = $0 }
        }
    }

    /// The controls come back on a tap and leave the picture again after a
    /// few seconds, as on a visitor's video call.
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

    /// The colleague's face: their photo, or the member silhouette — never
    /// their initials.
    private var face: some View {
        Avatar(name: call.peerName(language), imageURL: call.peerAvatarURL, size: faceSize, subject: .member)
    }

    private var header: some View {
        VStack(spacing: Theme.Space.sm) {
            Text(call.peerName(language))
                .font(.app(.title, .bold))
                .foregroundStyle(.white)
                .multilineTextAlignment(.center)
                .lineLimit(isFullScreenVideo ? 1 : 2)
                .minimumScaleFactor(0.75)
                .accessibilityAddTraits(.isHeader)

            statusLine

            if let degraded = call.degraded, call.isLive {
                notice(degraded.title(language))
            } else if call.relayWarning, !call.phase.isOver {
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

    /// The state, in words; the clock once both are in the room.
    @ViewBuilder
    private var statusLine: some View {
        if case .live(let since) = call.phase {
            TimelineView(.periodic(from: since, by: 1)) { context in
                CallPill(text: Format.callDuration(from: since, to: context.date, locale: language.locale))
                    .monospacedDigit()
            }
        } else {
            Text(TeamCallScreen.status(call, language))
                .font(.app(.headline, .regular))
                .foregroundStyle(.white.opacity(0.78))
                .multilineTextAlignment(.center)
                .contentTransition(.opacity)
                .animation(.easeInOut(duration: 0.25), value: TeamCallScreen.status(call, language))
        }
    }

    /// What the call screen and its floating view say before the clock runs:
    /// "Calling…" until a phone of the colleague's rings, "Ringing…" after
    /// (`CallManager.apply`), and so on.
    static func status(_ call: ActiveTeamCall, _ language: Language) -> String {
        switch call.phase {
        case .calling:
            Str.teamCallCalling(language)
        case .ringing:
            switch call.direction {
            case .outgoing: Str.teamCallRinging(language)
            case .incoming: call.channel == .video ? Str.teamCallIncomingVideo(language) : Str.teamCallIncomingVoice(language)
            }
        case .connecting:
            Str.teamCallConnecting(language)
        case .live:
            ""
        case .ended(let end):
            end.title(language, channel: call.channel)
        }
    }

    @ViewBuilder
    private var controls: some View {
        if call.phase.isOver {
            CallButton(icon: "xmark", title: Str.done(language)) {
                manager.dismiss()
            }
            .padding(.bottom, Theme.Space.md)
        } else {
            CallControlTray {
                HStack(alignment: .top, spacing: 0) {
                    CallButton(
                        icon: call.isMuted ? "mic.slash.fill" : "mic.fill",
                        title: call.isMuted ? Str.teamCallUnmute(language) : Str.teamCallMute(language),
                        isOn: call.isMuted
                    ) {
                        manager.toggleMute()
                    }
                    .frame(maxWidth: .infinity)

                    if call.channel == .video {
                        CallButton(
                            icon: call.isCameraOn ? "video.fill" : "video.slash.fill",
                            title: Str.teamCallCamera(language),
                            isOn: !call.isCameraOn
                        ) {
                            manager.toggleCamera()
                        }
                        .disabled(!call.isLive)
                        .frame(maxWidth: .infinity)

                        CallButton(icon: "arrow.triangle.2.circlepath.camera", title: Str.teamCallSwitchCamera(language)) {
                            manager.switchCamera()
                        }
                        .disabled(!call.isLive || !call.isCameraOn)
                        .frame(maxWidth: .infinity)
                    } else {
                        CallButton(
                            icon: call.isSpeakerOn ? "speaker.wave.2.fill" : "speaker.fill",
                            title: Str.teamCallSpeaker(language),
                            isOn: call.isSpeakerOn
                        ) {
                            manager.toggleSpeaker()
                        }
                        .frame(maxWidth: .infinity)
                    }

                    CallButton(icon: "phone.down.fill", title: Str.teamCallHangUp(language), tint: Theme.Palette.danger) {
                        manager.end()
                    }
                    .frame(maxWidth: .infinity)
                }
            }
        }
    }
}

/// The colleague call, minimised: a small card floating over the app — the
/// colleague's picture on a video call, their face and the clock (or the
/// state) on a voice call — dragged anywhere by its window
/// (`TeamCallWindow`), and opening the call again when tapped.
struct TeamCallBubble: View {
    let manager: CallManager
    let call: ActiveTeamCall
    let language: Language

    private var showsVideo: Bool { call.channel == .video && call.isLive }

    var body: some View {
        ZStack {
            CallBackdrop(photoURL: call.peerAvatarURL)

            if showsVideo, let remote = manager.remoteVideo {
                SwiftUIVideoView(remote, layoutMode: .fill, mirrorMode: .off)
            } else {
                VStack(spacing: Theme.Space.sm) {
                    Avatar(name: call.peerName(language), imageURL: call.peerAvatarURL, size: 56, subject: .member)
                        .overlay(Circle().strokeBorder(.white.opacity(0.2), lineWidth: 1))
                    status
                        .font(.app(size: 13, .semibold))
                        .foregroundStyle(.white)
                        .monospacedDigit()
                        .lineLimit(1)
                        .minimumScaleFactor(0.6)
                }
                .padding(Theme.Space.sm)
            }

            if call.isMuted {
                Image(systemName: "mic.slash.fill")
                    .font(.system(size: 11, weight: .bold))
                    .foregroundStyle(.white)
                    .padding(6)
                    .background(Circle().fill(Theme.Palette.danger))
                    .padding(6)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topTrailing)
            }
        }
        // PiP grows out of the floating view too, when the member leaves the
        // app with the call minimised.
        .background {
            if showsVideo { CallPiPSource(call: pictureInPicture) }
        }
        .frame(width: TeamCallWindow.bubbleSize.width, height: TeamCallWindow.bubbleSize.height)
        .clipShape(RoundedRectangle(cornerRadius: 24, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 24, style: .continuous).strokeBorder(.white.opacity(0.18), lineWidth: 1))
        .shadow(color: .black.opacity(0.35), radius: 8, y: 3)
        .padding(TeamCallWindow.bubbleMargin)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .contentShape(Rectangle())
        .onTapGesture { TeamCallPresentation.shared.expand() }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Str.teamCallReturnToCall(language))
        .accessibilityValue(call.peerName(language))
        .accessibilityAddTraits(.isButton)
        .accessibilityAction { TeamCallPresentation.shared.expand() }
    }

    @ViewBuilder
    private var status: some View {
        if case .live(let since) = call.phase {
            TimelineView(.periodic(from: since, by: 1)) { context in
                Text(Format.callDuration(from: since, to: context.date, locale: language.locale))
            }
        } else {
            Text(TeamCallScreen.status(call, language))
        }
    }

    private var pictureInPicture: CallPictureInPicture.Call {
        CallPictureInPicture.Call(
            track: manager.remoteVideo,
            name: call.peerName(language),
            avatarURL: call.peerAvatarURL,
            subject: .member,
            owner: call.uuid.uuidString,
            restore: { TeamCallPresentation.shared.expand() }
        )
    }
}

extension TeamCallEnd {
    /// The line under the colleague's name once the call is over.
    func title(_ language: Language, channel: CallChannel) -> String {
        switch self {
        case .hungUp, .remoteEnded: Str.teamCallEnded(language)
        case .declined, .declinedElsewhere: Str.teamCallDeclined(language)
        case .cancelled: Str.teamCallCancelled(language)
        case .noAnswer: Str.teamCallNoAnswer(language)
        case .missed: channel == .video ? Str.teamCallMissedVideo(language) : Str.teamCallMissedVoice(language)
        case .answeredElsewhere: Str.teamCallAnsweredElsewhere(language)
        case .busy: Str.teamCallBusy(language)
        case .notInPlan: Str.teamCallNotInPlan(language)
        case .limitReached: Str.teamCallLimitReached(language)
        case .failed: Str.teamCallFailed(language)
        }
    }
}
