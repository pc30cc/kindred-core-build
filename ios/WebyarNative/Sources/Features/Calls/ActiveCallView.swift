import SwiftUI

/// The screen an answered call lands on.
///
/// Deliberately not a ringing screen: the ringing happens in CallKit, which
/// owns the lock screen, the ringtone and the answer button. By the time this
/// appears the operator has already said yes, so everything here is about the
/// call in progress — who it is with, how long it has been running, and how to
/// get out of it.
struct ActiveCallView: View {
    let call: IncomingCall
    let service: CallCenterService

    @Environment(AppState.self) private var appState
    @State private var startedAt = Date()

    private var language: Language { appState.language }

    var body: some View {
        ZStack {
            // A dark surface regardless of the app's theme, the way every call
            // screen on the phone is: it is a full-screen mode, not a page.
            LinearGradient(
                colors: [Color(uiColor: .systemIndigo).opacity(0.55), .black],
                startPoint: .top,
                endPoint: .bottom
            )
            .ignoresSafeArea()

            VStack(spacing: Theme.Space.xl) {
                Spacer(minLength: Theme.Space.huge)

                Avatar(
                    name: call.caller,
                    imageURL: call.avatarURL,
                    size: 132
                )
                .shadow(color: .black.opacity(0.35), radius: 24, y: 10)

                VStack(spacing: Theme.Space.sm) {
                    Text(call.caller)
                        .font(.system(.title, weight: .semibold))
                        .foregroundStyle(.white)
                        .multilineTextAlignment(.center)
                        .lineLimit(2)

                    TimelineView(.periodic(from: startedAt, by: 1)) { context in
                        Text(status(at: context.date))
                            .font(.system(.subheadline, design: .rounded))
                            .foregroundStyle(.white.opacity(0.75))
                            .monospacedDigit()
                    }

                    if let workspace = call.workspaceName {
                        Text(workspace)
                            .font(Theme.Typo.meta)
                            .foregroundStyle(.white.opacity(0.55))
                    }
                }

                Spacer()

                HStack(spacing: Theme.Space.xxl) {
                    CallControl(
                        icon: call.hasVideo ? "video.fill" : "phone.fill",
                        title: call.hasVideo ? Str.videoCall(language) : Str.voiceCall(language),
                        tint: .white.opacity(0.18)
                    ) {}
                    .disabled(true)
                    .opacity(0.5)

                    CallControl(
                        icon: "phone.down.fill",
                        title: Str.hangUp(language),
                        tint: Theme.Palette.danger
                    ) {
                        service.hangUp()
                    }
                }
                .padding(.bottom, Theme.Space.huge)
            }
            .padding(.horizontal, Theme.Space.xl)
        }
        .preferredColorScheme(.dark)
    }

    private func status(at now: Date) -> String {
        if service.isConnecting { return Str.connecting(language) }
        let seconds = max(0, Int(now.timeIntervalSince(startedAt)))
        return String(format: "%02d:%02d", seconds / 60, seconds % 60)
    }
}

/// One round button with its label under it, the way a call screen has looked
/// since the first iPhone.
private struct CallControl: View {
    let icon: String
    let title: String
    let tint: Color
    let action: () -> Void

    var body: some View {
        VStack(spacing: Theme.Space.sm) {
            Button(action: action) {
                Image(systemName: icon)
                    .font(.system(size: 26, weight: .medium))
                    .foregroundStyle(.white)
                    .frame(width: 72, height: 72)
                    .background(Circle().fill(tint))
            }
            .buttonStyle(.plain)

            Text(title)
                .font(Theme.Typo.meta)
                .foregroundStyle(.white.opacity(0.8))
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(title)
    }
}
