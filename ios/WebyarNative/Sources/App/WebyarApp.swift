import SwiftUI

@main
struct WebyarApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @State private var appState = AppState()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(appState)
                .environment(delegate.calls)
                // The call service needs to know who is signed in before it
                // can tell the server where to ring, and it is created before
                // any of that exists — so the wiring happens here, once.
                .task {
                    delegate.calls.appState = appState
                    await delegate.calls.registerDevice()
                }
                // The VoIP token usually arrives before anybody has signed
                // in, and the server can only route a ring to a known
                // operator — so registration is retried the moment there is
                // one. Without this the phone would stay silent until the
                // next cold launch.
                .onChange(of: appState.session) { _, session in
                    guard case .signedIn = session else { return }
                    Task { await delegate.calls.registerDevice() }
                }
                // A ringing call is answered by the system, not by the app;
                // what the app owns is the screen that comes after.
                .fullScreenCover(item: Binding(
                    get: { delegate.calls.active },
                    set: { if $0 == nil { delegate.calls.hangUp() } }
                )) { call in
                    ActiveCallView(call: call, service: delegate.calls)
                        .environment(appState)
                }
                // Language drives BOTH the copy and the writing direction, and
                // it is applied once at the root so no screen can be left
                // laid out the wrong way round. `locale` additionally makes
                // dates and numbers format per language — Persian dates in the
                // Persian calendar, Turkish month names in Turkish.
                .environment(\.layoutDirection, appState.language.layoutDirection)
                .environment(\.locale, appState.language.locale)
                // nil means "follow the device", which is what `.system` is.
                .preferredColorScheme(appState.appearance.colorScheme)
        }
    }
}

/// Chooses between the login screen and the signed-in app, and holds the
/// launch state until we know which one is correct.
struct RootView: View {
    @Environment(AppState.self) private var appState

    var body: some View {
        ZStack {
            switch appState.session {
            case .restoring:
                LaunchView()
                    .transition(.opacity)

            case .signedOut:
                LoginView()
                    .transition(.opacity)

            case .signedIn:
                MainTabView()
                    // Moving in from the leading edge reads as "forward",
                    // and SwiftUI mirrors it automatically under RTL.
                    .transition(.asymmetric(
                        insertion: .move(edge: .trailing).combined(with: .opacity),
                        removal: .opacity
                    ))
            }
        }
        .animation(Theme.Motion.standard, value: appState.session)
        .task {
            await appState.restore()
        }
    }
}

/// The brief moment before we know whether there is a session.
///
/// It deliberately mirrors the launch screen — same background, same mark —
/// so the handoff from the system launch image is invisible rather than a
/// flash of a different layout.
struct LaunchView: View {
    var body: some View {
        ZStack {
            Color(uiColor: .systemBackground)
                .ignoresSafeArea()

            VStack(spacing: Theme.Space.xl) {
                BrandMark(size: 72)
                ProgressView()
                    .controlSize(.regular)
            }
        }
    }
}

/// The app's logomark: the first letter of the product name in the current
/// language, in a rounded square.
struct BrandMark: View {
    @Environment(AppState.self) private var appState
    var size: CGFloat = 64

    private var letter: String {
        String(Str.appName(appState.language).prefix(1))
    }

    var body: some View {
        RoundedRectangle(cornerRadius: size * 0.28, style: .continuous)
            .fill(Theme.Palette.brand)
            .frame(width: size, height: size)
            .overlay(
                Text(letter)
                    .font(.system(size: size * 0.46, weight: .bold))
                    .foregroundStyle(.white)
            )
            .accessibilityHidden(true)
    }
}
