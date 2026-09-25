import SwiftUI

/// The one window: a splash while the session is restored, then the sign-in
/// page or the shell — under the maintenance notice while the platform is down.
struct RootView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.controlActiveState) private var active
    @Environment(\.openSettings) private var openSettings

    var body: some View {
        let maintenance = app.config.maintenance.enabled
        ZStack {
            Group {
                switch app.phase {
                case .launching:
                    SplashView()
                case .signedOut:
                    LoginView()
                case .signedIn:
                    // Rebuilt for another workspace, and for another language so the
                    // columns change sides with the text direction, as Windows rebuilds its page.
                    ShellView()
                        .id("\(app.workspace?.id ?? "none")-\(app.strings.language.code)")
                }
            }
            // Not a key reaches the app beneath the maintenance notice either.
            .disabled(maintenance)
            // A sibling, not an overlay of the disabled content, so its own buttons stay live.
            if maintenance {
                MaintenanceOverlay()
                    .transition(.opacity)
            }
        }
        .frame(minWidth: 960, minHeight: 600)
        // No implicit animation on the phase: swapping the whole shell in an animated transaction left
        // the rebuilt shell half-drawn after signing out and in again (a thread with no messages, no
        // glass and blank details) until the app was restarted.
        .animation(.smooth(duration: 0.25), value: maintenance)
        .onAppear {
            Typeface.persian = app.strings.language == .fa
            app.showSettings = { openSettings() }
        }
        .onChange(of: app.strings.language) { _, l in Typeface.persian = l == .fa }
        .onContinuousHover { _ in app.noteInteraction() }
        .navigationTitle(app.workspace?.name.isEmpty == false ? app.workspace!.name : app.strings["appName"])
    }
}

struct SplashView: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        VStack(spacing: 18) {
            Image("BrandMark")
                .resizable()
                .frame(width: 72, height: 72)
                .shadow(color: Palette.brand.opacity(0.35), radius: 18, y: 8)
            ProgressView().controlSize(.small)
            Text(app.strings["checkingSession"]).appFont(13).foregroundStyle(Palette.text2)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Palette.appBackground)
    }
}
