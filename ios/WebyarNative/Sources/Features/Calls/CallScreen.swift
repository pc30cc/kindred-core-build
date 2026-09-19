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

    var body: some View {
        ZStack {
            if isFullScreenVideo {
                // Their video *is* the screen, edge to edge and under the
                // status bar — the way a video call has looked since anyone
                // started making them on a phone. Everything else floats on
                // top of it.
                VideoStage(
                    remote: session.remoteVideoTrack,
                    local: session.localVideoTrack,
                    contactName: session.contactName,
                    contactAvatarURL: session.contactAvatarURL,
                    visitor: session.visitor
                )
                .ignoresSafeArea()
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
        .preferredColorScheme(.dark)
        .statusBarHidden(isFullScreenVideo && !chromeVisible)
        .task { session.start() }
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
                .font(.system(.title2, weight: .semibold))
                .foregroundStyle(.white)
                .lineLimit(1)

            statusLine
                .font(.system(.subheadline, design: .rounded))
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

/// The visitor's video, with the operator's own camera inset into the corner.
///
/// Both tracks arrive as plain values from the session rather than being dug
/// out of `Room` here: the room is not something SwiftUI watches, so a view
/// that reads it directly shows whatever was true at its last redraw.
private struct VideoStage: View {
    let remote: VideoTrack?
    let local: VideoTrack?
    let contactName: String
    let contactAvatarURL: String?
    var visitor: VisitorProfile?

    var body: some View {
        ZStack(alignment: .topTrailing) {
            ZStack {
                // Black behind everything, so letterboxing and the moment
                // before the first frame both read as "a call", not as a
                // broken layout.
                Color.black

                if let remote {
                    SwiftUIVideoView(remote, layoutMode: .fill)
                } else {
                    // Connected, with nothing coming from their camera —
                    // switched off, or never there. Their face says the call
                    // is fine and the picture is not; a spinner that never
                    // resolves would say the opposite.
                    Avatar(
                        name: contactName,
                        imageURL: contactAvatarURL,
                        size: 140,
                        os: visitor?.device?.os,
                        device: visitor?.device?.device,
                        countryCode: visitor?.geo?.countryCode
                    )
                        .shadow(color: .black.opacity(0.35), radius: 24, y: 10)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)

            if let local {
                // The operator's own preview, mirrored the way every selfie
                // camera is: they are looking at themselves, not at a
                // stranger. Inset from the safe area so it never sits under
                // the clock or the notch.
                SwiftUIVideoView(local, layoutMode: .fill, mirrorMode: .mirror)
                    .frame(width: 104, height: 144)
                    .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.lg, style: .continuous))
                    .overlay(
                        RoundedRectangle(cornerRadius: Theme.Radius.lg, style: .continuous)
                            .strokeBorder(.white.opacity(0.25), lineWidth: 0.5)
                    )
                    .shadow(color: .black.opacity(0.4), radius: 12, y: 4)
                    .padding(Theme.Space.lg)
                    .padding(.top, Theme.Space.huge)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

/// A slow ring while the invitation is out — the visual equivalent of a
/// ringing tone, so the wait does not look like a frozen screen.
private struct PulsingRing: View {
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
private struct CallButton: View {
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

    var body: some View {
        CallScreen(session: session, language: language, onClose: onClose)
    }
}
