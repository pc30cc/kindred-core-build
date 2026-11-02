import SwiftUI
import LiveKit

/// A colleague call, from "Calling…" (or "Incoming voice call") to "Call
/// ended". Drawn in a window of its own above the whole app from
/// `CallManager`'s state (`TeamCallWindow`), so it is there whichever screen
/// was open, a sheet or a photo full screen included — and when the call was
/// answered on the lock screen, before the app had drawn anything.
///
/// The visitor call's visual language (`CallScreen`): the face in the middle
/// on a dark backdrop, the controls at the bottom where the thumb is, a video
/// call edge to edge once both are in the room with the controls fading off
/// the picture. What is new is the ring: an incoming call has Decline and
/// Answer, which go through CallKit exactly as the lock screen's do.
struct TeamCallScreen: View {
    let manager: CallManager
    let call: ActiveTeamCall
    let language: Language

    @State private var chromeVisible = true
    @State private var hideTask: Task<Void, Never>?
    /// Where the header, the controls and the safe area are over the
    /// picture, for the small picture to settle clear of them (`VideoStage`).
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
            } else {
                backdrop
                portrait
            }
        }
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

    private var keepsScreenAwake: Bool {
        call.channel == .video && !call.phase.isOver
    }

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

    private var chrome: some View {
        VStack(spacing: 0) {
            header
                .padding(.horizontal, Theme.Space.xl)
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
                .padding(.horizontal, Theme.Space.lg)
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
            Text(call.peerName(language))
                .font(.app(.title2, .semibold))
                .foregroundStyle(.white)
                .lineLimit(1)

            statusLine
                .font(.app(.subheadline, design: .rounded))
                .foregroundStyle(.white.opacity(0.75))
                .monospacedDigit()

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

    @ViewBuilder
    private var statusLine: some View {
        switch call.phase {
        case .calling:
            Text(Str.teamCallCalling(language))
        case .ringing:
            switch call.direction {
            case .outgoing:
                Text(Str.teamCallRinging(language))
            case .incoming:
                Text(call.channel == .video ? Str.teamCallIncomingVideo(language) : Str.teamCallIncomingVoice(language))
            }
        case .connecting:
            Text(Str.teamCallConnecting(language))
        case .live(let since):
            TimelineView(.periodic(from: since, by: 1)) { context in
                Text(Format.callDuration(from: since, to: context.date, locale: language.locale))
            }
        case .ended(let end):
            Text(end.title(language, channel: call.channel))
        }
    }

    /// The colleague's face: their photo, or the member silhouette — never
    /// their initials. A ring around it while the call rings.
    private var stage: some View {
        Avatar(name: call.peerName(language), imageURL: call.peerAvatarURL, size: 140, subject: .member)
            .shadow(color: .black.opacity(0.35), radius: 24, y: 10)
            .overlay(alignment: .bottom) {
                if call.isRinging {
                    PulsingRing()
                }
            }
    }

    @ViewBuilder
    private var controls: some View {
        if call.direction == .incoming, call.phase == .ringing {
            HStack(spacing: Theme.Space.huge) {
                CallButton(icon: "phone.down.fill", title: Str.teamCallDecline(language), tint: Theme.Palette.danger) {
                    manager.end()
                }
                CallButton(icon: call.channel.icon, title: Str.teamCallAnswer(language), tint: Theme.Palette.success) {
                    manager.answer()
                }
            }
        } else if call.phase.isOver {
            CallButton(icon: "xmark", title: Str.done(language)) {
                manager.dismiss()
            }
        } else {
            HStack(spacing: call.channel == .video ? Theme.Space.sm : Theme.Space.xl) {
                CallButton(
                    icon: call.isMuted ? "mic.slash.fill" : "mic.fill",
                    title: call.isMuted ? Str.teamCallUnmute(language) : Str.teamCallMute(language),
                    isOn: call.isMuted
                ) {
                    manager.toggleMute()
                }

                if call.channel == .video {
                    CallButton(
                        icon: call.isCameraOn ? "video.fill" : "video.slash.fill",
                        title: Str.teamCallCamera(language),
                        isOn: !call.isCameraOn
                    ) {
                        manager.toggleCamera()
                    }
                    .disabled(!call.isLive)

                    CallButton(icon: "arrow.triangle.2.circlepath.camera", title: Str.teamCallSwitchCamera(language)) {
                        manager.switchCamera()
                    }
                    .disabled(!call.isLive || !call.isCameraOn)
                } else {
                    CallButton(
                        icon: call.isSpeakerOn ? "speaker.wave.2.fill" : "speaker.fill",
                        title: Str.teamCallSpeaker(language),
                        isOn: call.isSpeakerOn
                    ) {
                        manager.toggleSpeaker()
                    }
                }

                CallButton(icon: "phone.down.fill", title: Str.teamCallHangUp(language), tint: Theme.Palette.danger) {
                    manager.end()
                }
            }
        }
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
