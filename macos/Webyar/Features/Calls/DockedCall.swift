import AVFoundation
import SwiftUI

/// The call inside the page it belongs to: slid down under the conversation's
/// header, or over the call on the call-center desk. A video call shows the
/// picture with the controls laid over it; a voice call is a single row. The
/// buttons in the corner take it out into a window of its own, or full screen.
struct DockedCallPanel: View {
    let call: LiveCall
    @Environment(AppModel.self) private var app
    @State private var showNotes = false
    @State private var showTransfer = false

    var body: some View {
        let s = app.strings
        Group {
            if call.isVideo { videoCard(s) } else { voiceCard(s) }
        }
        .environment(\.colorScheme, .dark)
        .foregroundStyle(Color(hex: 0xE8ECF4))
        .background(Color(hex: 0x0C0E14))
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(Color.white.opacity(0.07), lineWidth: 1))
        .shadow(color: .black.opacity(0.16), radius: 14, y: 6)
        .padding(.horizontal, 12)
        .padding(.top, 8)
        .padding(.bottom, 4)
        .onAppear { CallCoordinator.shared.panelAppeared() }
        .onDisappear { CallCoordinator.shared.panelDisappeared() }
        .callDebugHooks(call) { what in
            if what == "notes" { showNotes.toggle() } else if what == "transfer" { showTransfer.toggle() }
        }
        #if DEBUG
        .onChange(of: showNotes) { _, on in
            Log.write("[call] panel notes \(on)\n" + Thread.callStackSymbols.prefix(30).joined(separator: "\n"))
        }
        #endif
    }

    // MARK: Video: the picture, the controls over it

    private func videoCard(_ s: Strings) -> some View {
        CallVideoStage(call: call, previewBottom: 64, previewMaxWidth: 168)
            .frame(height: 300)
            .overlay(alignment: .topLeading) {
                who(avatar: 32)
                    .shadow(color: .black.opacity(0.6), radius: 4, y: 1)
                    .padding(12)
            }
            .overlay(alignment: .topTrailing) { windowButtons(s).padding(10) }
            .overlay(alignment: .bottom) {
                VStack(spacing: 8) {
                    notices(s)
                    controls(s, size: 40)
                }
                .padding(.horizontal, 12)
                .padding(.bottom, 12)
            }
    }

    // MARK: Voice: one row

    private func voiceCard(_ s: Strings) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 12) {
                who(avatar: 40)
                Spacer(minLength: 8)
                controls(s, size: 34)
                windowButtons(s)
            }
            notices(s)
        }
        .padding(12)
    }

    private func who(avatar size: CGFloat) -> some View {
        HStack(spacing: 10) {
            CallAvatar(call: call, size: size)
            VStack(alignment: .leading, spacing: 2) {
                Text(call.name)
                    .appFont(14, .semibold)
                    .lineLimit(1)
                CallStatusText(call: call)
                    .appFont(12)
            }
        }
    }

    // MARK: Notices

    @ViewBuilder
    private func notices(_ s: Strings) -> some View {
        if call.phase.isLive {
            if let to = call.transferredTo {
                notice(call.handoverJoined ? s.get("callHandoverJoined", "name", to) : s.get("callTransferredWaiting", "name", to),
                       icon: "arrow.left.arrow.right", tint: Palette.brand)
            }
            if let key = call.warningKey {
                notice(s[key], icon: "exclamationmark.triangle.fill", tint: Palette.warning)
            }
            if let blocked = call.mediaBlocked {
                HStack(spacing: 8) {
                    notice(s["mediaPermission"], icon: "mic.slash.fill", tint: Palette.warning)
                    Button(s["openWindowsSettings"]) { CallVideoStage.openPrivacySettings(blocked) }
                        .controlSize(.small)
                        .glassButton()
                }
            }
        }
    }

    private func notice(_ text: String, icon: String, tint: Color) -> some View {
        Label(text, systemImage: icon)
            .appFont(11.5)
            .lineLimit(2)
            .foregroundStyle(tint == Palette.brand ? Color(hex: 0xE8ECF4) : tint)
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
            .background(tint.opacity(0.18), in: Capsule())
    }

    // MARK: Controls

    private func controls(_ s: Strings, size: CGFloat) -> some View {
        let live = call.phase == .connected
        return GlassGroup(spacing: 8) {
            HStack(spacing: 8) {
                CallControlButton(icon: call.isMuted ? "mic.slash.fill" : "mic.fill", help: s[call.isMuted ? "unmute" : "mute"],
                                  solid: call.isMuted ? Color.white : nil, size: size) {
                    call.toggleMute()
                }
                .keyboardShortcut("m", modifiers: [.command, .shift])
                .disabled(!live)
                if call.isVideo {
                    CallControlButton(icon: call.isCameraOn ? "video.fill" : "video.slash.fill", help: s["camera"],
                                      solid: call.isCameraOn ? nil : Color.white, size: size) {
                        call.toggleCamera()
                    }
                    .disabled(!live)
                }
                if call.hasNotes {
                    CallControlButton(icon: "note.text", help: s["callNotes"], solid: showNotes ? Color.white : nil, size: size) {
                        showNotes.toggle()
                    }
                    .popover(isPresented: $showNotes, arrowEdge: .bottom) {
                        CallNotesPanel(call: call, s: s) { showNotes = false }
                            .frame(height: 420)
                            .padding(6)
                            .environment(\.colorScheme, .dark)
                    }
                }
                if call.canTransfer && call.transferredTo == nil {
                    CallControlButton(icon: "arrow.left.arrow.right", help: s["callTransfer"], solid: showTransfer ? Color.white : nil, size: size) {
                        showTransfer.toggle()
                    }
                    .disabled(!live)
                    .popover(isPresented: $showTransfer, arrowEdge: .bottom) {
                        CallTransferPanel(call: call) { showTransfer = false }
                            .environment(\.colorScheme, .dark)
                    }
                }
                if call.transferredTo != nil {
                    // Handed on: hanging up here would end the call for the colleague too.
                    CallControlButton(icon: "rectangle.portrait.and.arrow.forward", help: s["callLeave"], solid: Palette.warning, size: size) {
                        call.leave()
                    }
                    .disabled(!call.phase.isLive)
                } else {
                    CallControlButton(icon: "phone.down.fill", help: s["hangUpCall"], solid: Palette.danger, size: size) {
                        call.hangUp()
                    }
                    .disabled(!call.phase.isLive)
                }
            }
        }
        .opacity(call.phase.isLive ? 1 : 0.4)
    }

    /// Out into a window of its own, or full screen.
    private func windowButtons(_ s: Strings) -> some View {
        HStack(spacing: 6) {
            if call.isVideo {
                CallCornerButton(icon: "arrow.up.left.and.arrow.down.right", help: s["callFullScreen"]) {
                    CallCoordinator.shared.toggleFullScreen()
                }
            }
            CallCornerButton(icon: "pip.exit", help: s["callPopOut"]) {
                CallCoordinator.shared.popOut()
            }
        }
        .disabled(!call.phase.isLive)
    }
}

/// A small round button in a corner of the call.
struct CallCornerButton: View {
    let icon: String
    let help: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: icon)
                .font(.system(size: 11.5, weight: .semibold))
                .foregroundStyle(Color.white.opacity(0.9))
                .frame(width: 28, height: 28)
                .background(Color.black.opacity(0.35), in: Circle())
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .help(help)
        .accessibilityLabel(help)
    }
}

/// The call while the operator is on another page: at the foot of the sidebar,
/// above their own card — who, how long, mute, back to the call, out into a
/// window, hang up.
struct CallBar: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        let co = CallCoordinator.shared
        if co.showsCallBar, let call = co.call {
            let s = app.strings
            VStack(alignment: .leading, spacing: 10) {
                Button { co.showCallPage() } label: {
                    HStack(spacing: 9) {
                        CallAvatar(call: call, size: 30)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(call.name)
                                .appFont(12.5, .semibold)
                                .lineLimit(1)
                            HStack(spacing: 4) {
                                Image(systemName: call.isVideo ? "video.fill" : "phone.fill")
                                    .font(.system(size: 9))
                                    .foregroundStyle(CallStatusText.color(call))
                                CallStatusText(call: call)
                                    .appFont(11)
                                    .lineLimit(1)
                            }
                        }
                        Spacer(minLength: 0)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help(s["callBackToCall"])
                HStack(spacing: 6) {
                    CallControlButton(icon: call.isMuted ? "mic.slash.fill" : "mic.fill", help: s[call.isMuted ? "unmute" : "mute"],
                                      solid: call.isMuted ? Color.white : nil, size: 30) {
                        call.toggleMute()
                    }
                    .disabled(call.phase != .connected)
                    CallControlButton(icon: "arrow.uturn.backward", help: s["callBackToCall"], size: 30) {
                        co.showCallPage()
                    }
                    CallControlButton(icon: "pip.exit", help: s["callPopOut"], size: 30) {
                        co.popOut()
                    }
                    Spacer(minLength: 0)
                    if call.transferredTo != nil {
                        CallControlButton(icon: "rectangle.portrait.and.arrow.forward", help: s["callLeave"], solid: Palette.warning, size: 30) {
                            call.leave()
                        }
                    } else {
                        CallControlButton(icon: "phone.down.fill", help: s["hangUpCall"], solid: Palette.danger, size: 30) {
                            call.hangUp()
                        }
                    }
                }
                .disabled(!call.phase.isLive)
            }
            .padding(10)
            .environment(\.colorScheme, .dark)
            .foregroundStyle(Color(hex: 0xE8ECF4))
            .background(Color(hex: 0x0C0E14), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .transition(.move(edge: .bottom).combined(with: .opacity))
        }
    }
}
