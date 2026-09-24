import SwiftUI

/// The one window: a splash while the session is restored, then the sign-in
/// page or the shell.
struct RootView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.controlActiveState) private var active

    var body: some View {
        Group {
            switch app.phase {
            case .launching:
                SplashView()
            case .signedOut:
                LoginView()
            case .signedIn:
                ShellView()
                    .id(app.workspace?.id ?? "none")
            }
        }
        .frame(minWidth: 960, minHeight: 600)
        .animation(.smooth(duration: 0.25), value: app.phase)
        .onAppear { Typeface.persian = app.strings.language == .fa }
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
