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

    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        ZStack {
            backdrop

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
        .preferredColorScheme(.dark)
        .task { session.start() }
        .onChange(of: session.phase) { _, phase in
            // An ended call lingers for a moment so the outcome can be read,
            // then gets out of the way on its own. Nobody wants to dismiss a
            // call that is already over.
            guard case .ended = phase else { return }
            Task {
                try? await Task.sleep(for: .seconds(2))
                onClose()
            }
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

            if session.relayWarning, session.phase.isLive {
                // Worth saying out loud rather than only in a log: this is the
                // reason a call works in the office and fails on a train.
                Label(Str.callRelayWarning(language), systemImage: "exclamationmark.triangle.fill")
                    .font(Theme.Typo.meta)
                    .foregroundStyle(Theme.Palette.warning)
                    .padding(.top, Theme.Space.xs)
            }
        }
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
                    Text(Format.callDuration(from: connectedAt, to: context.date))
                }
            }
        case .ended(let outcome):
            Text(outcome.title(language))
        }
    }

    /// The middle of the screen: their video if there is any, their face if
    /// not.
    @ViewBuilder
    private var stage: some View {
        if session.channel == .video, session.phase == .connected, let room = session.room {
            VideoStage(room: room, isCameraOn: session.isCameraOn)
        } else {
            Avatar(
                name: session.contactName,
                imageURL: session.contactAvatarURL,
                size: 140
            )
            .shadow(color: .black.opacity(0.35), radius: 24, y: 10)
            .overlay(alignment: .bottom) {
                if session.phase == .waiting {
                    PulsingRing()
                }
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
private struct VideoStage: View {
    let room: Room
    let isCameraOn: Bool

    private var remoteTrack: VideoTrack? {
        room.remoteParticipants.values
            .flatMap(\.videoTracks)
            .compactMap { $0.track as? VideoTrack }
            .first
    }

    private var localTrack: VideoTrack? {
        room.localParticipant.videoTracks
            .compactMap { $0.track as? VideoTrack }
            .first
    }

    var body: some View {
        ZStack(alignment: .topTrailing) {
            if let remoteTrack {
                SwiftUIVideoView(remoteTrack, layoutMode: .fill)
                    .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.xl, style: .continuous))
            } else {
                RoundedRectangle(cornerRadius: Theme.Radius.xl, style: .continuous)
                    .fill(.white.opacity(0.08))
                    .overlay(ProgressView().tint(.white))
            }

            if isCameraOn, let localTrack {
                SwiftUIVideoView(localTrack, layoutMode: .fill, mirrorMode: .mirror)
                    .frame(width: 96, height: 132)
                    .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.md, style: .continuous))
                    .overlay(
                        RoundedRectangle(cornerRadius: Theme.Radius.md, style: .continuous)
                            .strokeBorder(.white.opacity(0.25), lineWidth: 0.5)
                    )
                    .padding(Theme.Space.md)
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
        language: Language,
        onClose: @escaping () -> Void
    ) {
        self.language = language
        self.onClose = onClose
        _session = State(
            initialValue: CallSession(
                invitation: invitation,
                contactName: contactName,
                contactAvatarURL: contactAvatarURL
            )
        )
    }

    var body: some View {
        CallScreen(session: session, language: language, onClose: onClose)
    }
}
