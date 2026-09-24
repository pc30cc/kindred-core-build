import AVFoundation
import AppKit
import LiveKit
import SwiftUI

/// The inside of the call window — the Windows call page (Assets/Call/call.html)
/// in SwiftUI: the visitor's face and the call's state in the middle, the
/// controls in a glass row at the bottom, and for a video call their picture
/// edge to edge with the operator's own camera inset in the corner.
struct CallView: View {
    let call: LiveCall
    @Environment(AppModel.self) private var app

    private var s: Strings { app.strings }

    /// A picture is on screen: the name moves to the corner out of its way.
    private var videoLive: Bool { call.remoteVideoTrack != nil || call.localVideoTrack != nil }

    var body: some View {
        ZStack {
            Color(hex: 0x0C0E14)
                .ignoresSafeArea()
            if videoLive {
                videoLayer
                    .ignoresSafeArea()
            } else {
                centeredWho
            }
        }
        .overlay(alignment: .topLeading) {
            if videoLive {
                compactWho
                    .padding(.top, 14)
                    .padding(.horizontal, 20)
            }
        }
        .overlay(alignment: .top) { notices }
        .overlay(alignment: .topTrailing) { pinButton }
        .overlay(alignment: .bottom) {
            controls
                .padding(.bottom, 22)
        }
        .environment(\.colorScheme, .dark)
        .foregroundStyle(Color(hex: 0xE8ECF4))
    }

    // MARK: The person

    private var centeredWho: some View {
        VStack(spacing: 14) {
            ZStack {
                if call.phase == .waiting {
                    CallPulse()
                }
                avatar(112)
            }
            .frame(width: 160, height: 160)
            Text(call.name)
                .appFont(22, .bold)
                .lineLimit(1)
                .truncationMode(.tail)
            statusLine
                .appFont(14)
                .foregroundStyle(statusColor)
                .multilineTextAlignment(.center)
        }
        .padding(.horizontal, 24)
        .padding(.bottom, 60)
    }

    private var compactWho: some View {
        HStack(spacing: 12) {
            avatar(40)
            VStack(alignment: .leading, spacing: 2) {
                Text(call.name)
                    .appFont(15, .bold)
                    .lineLimit(1)
                statusLine
                    .appFont(13)
                    .foregroundStyle(statusColor)
            }
            .shadow(color: .black.opacity(0.6), radius: 4, y: 1)
        }
    }

    private func avatar(_ size: CGFloat) -> some View {
        let c = call.conversation
        return AvatarView(name: c == nil ? call.name : c?.contacts?.name, email: c?.contacts?.email, os: c?.visitorOs,
                          countryCode: c?.visitorCountryCode, imageURL: c?.contacts?.avatarUrl, size: size)
    }

    private var statusColor: Color {
        call.phase == .connected ? Palette.success : Color(hex: 0x98A2B3)
    }

    @ViewBuilder
    private var statusLine: some View {
        switch call.phase {
        case .waiting:
            Text(s[call.desk == nil ? "callWaiting" : "connectingCall"])
        case .connecting:
            Text(s["connectingCall"])
        case .connected:
            if let at = call.connectedAt {
                TimelineView(.periodic(from: at, by: 1)) { context in
                    Text(Display.duration(Int(context.date.timeIntervalSince(at)), s.language))
                        .monospacedDigit()
                }
            } else {
                Text(Display.duration(0, s.language))
            }
        case .ended(let outcome):
            Text(s[outcome.textKey])
        }
    }

    // MARK: Video

    private var videoLayer: some View {
        GeometryReader { geo in
            ZStack(alignment: .bottomTrailing) {
                Color.black
                if let remote = call.remoteVideoTrack {
                    SwiftUIVideoView(remote, layoutMode: .fill)
                        .frame(width: geo.size.width, height: geo.size.height)
                        .clipped()
                }
                if let local = call.localVideoTrack {
                    localPreview(local, width: min(geo.size.width * 0.26, 260))
                }
            }
            .frame(width: geo.size.width, height: geo.size.height)
        }
    }

    /// The operator's own camera, mirrored the way every selfie camera is.
    private func localPreview(_ track: VideoTrack, width: CGFloat) -> some View {
        let shape = RoundedRectangle(cornerRadius: 14, style: .continuous)
        return SwiftUIVideoView(track, layoutMode: .fill, mirrorMode: .mirror)
            .frame(width: width, height: width / 1.6)
            .clipShape(shape)
            .overlay { shape.strokeBorder(Color.white.opacity(0.18), lineWidth: 2) }
            .shadow(color: .black.opacity(0.5), radius: 16, y: 12)
            .padding(.bottom, 96)
            .padding(.trailing, 18)
    }

    // MARK: Notices

    @ViewBuilder
    private var notices: some View {
        VStack(spacing: 8) {
            if let key = call.warningKey, call.phase.isLive {
                Label(s[key], systemImage: "exclamationmark.triangle.fill")
                    .appFont(12)
                    .foregroundStyle(Palette.warning)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 6)
                    .glassCapsule(tint: Palette.warning.opacity(0.35))
            }
            if let blocked = call.mediaBlocked, call.phase.isLive {
                permissionNotice(blocked)
            }
        }
        .padding(.top, 14)
        .padding(.horizontal, 60)
        .frame(maxWidth: 520)
    }

    /// macOS refused the microphone or camera: where to allow it, one click away.
    private func permissionNotice(_ type: AVMediaType) -> some View {
        HStack(spacing: 10) {
            Text(s["mediaPermission"])
                .appFont(12)
                .foregroundStyle(Color(hex: 0xE8ECF4))
                .fixedSize(horizontal: false, vertical: true)
            Button(s["openWindowsSettings"]) { openPrivacySettings(type) }
                .controlSize(.small)
                .glassButton()
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .glassCard(12)
    }

    private func openPrivacySettings(_ type: AVMediaType) {
        let pane = type == .video ? "Privacy_Camera" : "Privacy_Microphone"
        if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?\(pane)") {
            NSWorkspace.shared.open(url)
        }
    }

    // MARK: Window

    private var pinButton: some View {
        let on = CallCoordinator.shared.isFloating
        return Button {
            CallCoordinator.shared.setFloating(!on)
        } label: {
            Image(systemName: on ? "pin.fill" : "pin")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(on ? Palette.brand : Color.white.opacity(0.85))
                .frame(width: 30, height: 30)
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .glass(Circle(), interactive: true)
        .help(s["callKeepOnTop"])
        .padding(.top, 12)
        .padding(.horizontal, 14)
    }

    // MARK: Controls

    private var controls: some View {
        let live = call.phase == .connected
        return GlassGroup(spacing: 14) {
            HStack(spacing: 14) {
                CallControlButton(icon: call.isMuted ? "mic.slash.fill" : "mic.fill",
                                  help: s[call.isMuted ? "unmute" : "mute"],
                                  solid: call.isMuted ? Color.white : nil) {
                    call.toggleMute()
                }
                .keyboardShortcut("m", modifiers: [.command, .shift])
                .disabled(!live)
                if call.isVideo {
                    CallControlButton(icon: call.isCameraOn ? "video.fill" : "video.slash.fill",
                                      help: s["camera"],
                                      solid: call.isCameraOn ? nil : Color.white) {
                        call.toggleCamera()
                    }
                    .keyboardShortcut("v", modifiers: [.command, .shift])
                    .disabled(!live)
                }
                CallControlButton(icon: "phone.down.fill", help: s["hangUpCall"], solid: Palette.danger) {
                    call.hangUp()
                }
                .disabled(!call.phase.isLive)
            }
        }
        .opacity(call.phase.isLive ? 1 : 0.4)
    }
}

/// One round control: glass, or a solid disc when switched off (white) or for hanging up (red).
private struct CallControlButton: View {
    let icon: String
    let help: String
    var solid: Color?
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            face
        }
        .buttonStyle(.plain)
        .help(help)
        .accessibilityLabel(help)
    }

    @ViewBuilder
    private var face: some View {
        let glyph = Image(systemName: icon)
            .font(.system(size: 20, weight: .medium))
            .foregroundStyle(solid == Color.white ? Color(hex: 0x0C0E14) : Color.white)
            .frame(width: 56, height: 56)
            .contentShape(Circle())
        if let solid {
            glyph.background(Circle().fill(solid))
        } else {
            glyph.glass(Circle(), interactive: true)
        }
    }
}

/// Soft rings around the face while the visitor is being rung.
private struct CallPulse: View {
    @State private var expanded = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        ZStack {
            Circle()
                .fill(Color(hex: 0x5A94FF).opacity(0.05))
                .frame(width: 156, height: 156)
                .scaleEffect(expanded ? 1.1 : 0.92)
            Circle()
                .fill(Color(hex: 0x5A94FF).opacity(0.10))
                .frame(width: 132, height: 132)
                .scaleEffect(expanded ? 1.06 : 0.96)
        }
        .onAppear {
            guard !reduceMotion else { return }
            withAnimation(.easeInOut(duration: 0.9).repeatForever(autoreverses: true)) {
                expanded = true
            }
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}
