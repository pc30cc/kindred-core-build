import SwiftUI

@main
struct WebyarApp: App {
    @State private var appState = AppState()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(appState)
                // The two lines that make the app actually speak the
                // operator's language rather than merely contain its words.
                //
                // `\.locale` is what every date, time and number on every
                // screen is formatted against — without it a Persian operator
                // reads "yesterday" and "11:26 PM" under Persian labels.
                // `\.layoutDirection` is what turns the whole interface
                // around: rows, stacks, alignment, list swipes, navigation
                // transitions and the leading/trailing edge of every padding
                // in the app. Persian text rendered inside a left-to-right
                // layout still *reads* right-to-left, which is why this was
                // easy to miss — but every row was built the wrong way round.
                .environment(\.locale, appState.language.locale)
                .environment(\.layoutDirection, appState.language.layoutDirection)
                // Changing the language rebuilds the interface instead of
                // re-draping the one on screen.
                //
                // SwiftUI turns a right-to-left interface around partly by
                // mirroring the container and counter-mirroring the text
                // inside it. Built that way from the start it is flawless —
                // a Persian launch is perfect. Changed while the views are
                // alive, the two halves come apart: switching back to
                // English left the layout correctly left-to-right but the
                // whole screen drawn in a mirror, so "Language" read
                // "egaugnaL" and the operator's own name was inside out.
                //
                // Keying the root on the language gives the new direction a
                // new hierarchy, which is the same fresh start a relaunch
                // would give it. The cost is that navigation returns to the
                // inbox — a fair price, and the behaviour most apps have
                // when their language changes.
                .id(appState.language)
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
            switch LaunchView.isHeld ? .restoring : appState.session {
            case .restoring:
                LaunchView()
                    .transition(.opacity)

            case .signedOut:
                LoginView()
                    .transition(.opacity)

            case .signedIn:
                MainTabView(initial: appState.selectedTab)
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
            // First thing, while the launch view — a centred mark on a plain
            // background — is the only thing on screen and has no side to be
            // on. Every screen after this is built with the window already
            // facing the right way.
            WindowDirection.apply(appState.language)
            // Counted once per launch, before any screen can ask for a
            // promotion, so "skip the first launches" counts launches rather
            // than the first time something asked.
            PromotionCenter.noteLaunch()
            // Before anything else talks to the server: the platform names its
            // own hosts in Super Admin, and an app that ignored that would keep
            // calling the old one for as long as it stayed installed.
            await Backend.current.refreshOrigin()
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
    @Environment(AppState.self) private var appState

    /// Whether this run was asked to stay on the launch screen.
    ///
    /// Restoring a session takes a few hundred milliseconds, which is the
    /// right amount of time for an operator and far too little to look at:
    /// every attempt to screenshot this caught either the system's own launch
    /// image or the inbox behind it. Same shape as `-WebyarNoPromotions`, and
    /// Debug-only for the same reason — nothing in a shipped build should be
    /// able to hold the app on a splash screen.
    static var isHeld: Bool {
        #if DEBUG
        ProcessInfo.processInfo.arguments.contains("-WebyarHoldLaunch")
        #else
        false
        #endif
    }

    var body: some View {
        ZStack {
            Color(uiColor: .systemBackground)
                .ignoresSafeArea()

            // The wordmark is the loading indicator. A spinner under it would
            // be a second thing saying the same thing, and the pair is what
            // makes a launch screen look assembled rather than designed.
            BrandWordmark(language: appState.language, size: 40, isLoading: true)
        }
    }
}

/// A square mark for the places that need one: the icon-shaped fallback
/// behind a promotion with no artwork of its own.
///
/// Not the launch screen and not the login screen any more — both show the
/// name itself, which says more than a letter in a box.
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
