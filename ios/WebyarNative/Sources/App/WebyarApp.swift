import SwiftUI

@main
struct WebyarApp: App {
    @State private var appState = AppState()
    // Remote notifications arrive through `UIApplicationDelegate` and
    // `UNUserNotificationCenterDelegate`; SwiftUI has no equivalent. This is
    // what puts `AppDelegate` in the responder chain.
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

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
            // The action buttons on a banner are registered by the app, not
            // sent in the payload, and their titles are in the operator's
            // chosen language — so this runs again whenever that changes,
            // which is exactly what keying the root on `language` gives.
            PushController.shared.registerCategories(language: appState.language)
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
        // Who is signed in, and where.
        //
        // A push token registered before anybody signed in belongs to nobody,
        // and one left by the previous operator has to be re-owned — both are
        // settled by registering again once we know. Keyed rather than called
        // after `restore()` because it also has to catch a sign-in on the
        // login screen and a switch of workspace, and the device row carries
        // the workspace so the server can scope the badge count to it.
        .task(id: PushSessionKey(appState)) {
            await PushController.shared.sessionChanged(
                signedIn: appState.session.user != nil,
                workspaceID: appState.selectedWorkspace?.id
            )
        }
    }
}

/// What "a different operator, or a different workspace" looks like to
/// `.task(id:)`.
///
/// Its own type rather than a tuple because `.task(id:)` wants one `Equatable`
/// value, and a struct says what the two strings are.
private struct PushSessionKey: Equatable {
    let userID: String?
    let workspaceID: String?

    init(_ state: AppState) {
        userID = state.session.user?.id
        workspaceID = state.selectedWorkspace?.id
    }
}

/// The brief moment before we know whether there is a session.
///
/// It takes over from the system's own launch image, which is a flat fill and
/// nothing else, so the job is to continue that image rather than to replace
/// it: same colour underneath, and everything this screen adds arrives by
/// fading in on top of it. Anything already drawn at the first frame is a cut
/// between two screens instead of one screen becoming another.
struct LaunchView: View {
    @Environment(AppState.self) private var appState

    @State private var hasAppeared = false
    /// Set once the restore has gone on long enough to be worth admitting to.
    @State private var isTakingAWhile = false

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
            // The exact colour the system's launch image is filled with —
            // `UILaunchScreen.UIColorName` in Info.plist names this asset.
            //
            // It used to be `.systemBackground`, which is pure white and pure
            // black, and this asset is neither: #F4F6F9 and #0C0E14. So the
            // handoff the comment above claimed to be invisible was in fact a
            // one-frame change of background colour, on every single launch.
            Color("LaunchBackground")
                .ignoresSafeArea()

            // One soft pool of brand colour behind the mark. A launch screen
            // has one thing on it and a lot of empty space; lighting the
            // space is what stops the mark looking dropped onto a blank page.
            RadialGradient(
                colors: [Theme.Palette.brand.opacity(0.14), .clear],
                center: .center,
                startRadius: 0,
                endRadius: 260
            )
            .ignoresSafeArea()
            .opacity(hasAppeared ? 1 : 0)
            .accessibilityHidden(true)

            VStack(spacing: Theme.Space.xl) {
                // The wordmark is the loading indicator. A spinner under it
                // would be a second thing saying the same thing.
                BrandWordmark(language: appState.language, size: 40, isLoading: true)

                // Unless it is genuinely slow. The sweep is a shimmer on a
                // logo: it reads as branding, and after a second or two of it
                // an operator starts to wonder whether anything is happening.
                // A restore that has taken longer than a moment has something
                // to say, so it says it — and a fast launch, which is nearly
                // all of them, never shows this at all.
                LaunchProgress()
                    .opacity(isTakingAWhile ? 1 : 0)
            }
        }
        .task {
            withAnimation(.easeOut(duration: 0.55)) { hasAppeared = true }
            try? await Task.sleep(for: .seconds(1.2))
            withAnimation(.easeOut(duration: 0.35)) { isTakingAWhile = true }
        }
    }
}

/// A thin travelling segment: "still working", said quietly.
///
/// Pinned left-to-right like the wordmark above it. It sits under a Latin
/// mark whose own sweep runs that way, and a bar running the other way in
/// Persian would have the two moving against each other.
private struct LaunchProgress: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var travel: CGFloat = -0.34

    private let width: CGFloat = 132
    private let height: CGFloat = 3
    private var segment: CGFloat { 0.34 }

    var body: some View {
        Capsule()
            .fill(Theme.Palette.brand.opacity(0.16))
            .frame(width: width, height: height)
            .overlay(alignment: .leading) {
                Capsule()
                    .fill(Theme.Palette.brand.opacity(reduceMotion ? 0.5 : 1))
                    .frame(width: width * segment, height: height)
                    // Parked a third of the way along for anyone who has asked
                    // the system to reduce motion: the shape still reads as a
                    // progress track rather than as a stray line.
                    .offset(x: (reduceMotion ? 0.33 : travel) * width)
            }
            .clipShape(Capsule())
            .environment(\.layoutDirection, .leftToRight)
            .onAppear {
                guard !reduceMotion else { return }
                withAnimation(.easeInOut(duration: 1.25).repeatForever(autoreverses: false)) {
                    travel = 1
                }
            }
            .accessibilityHidden(true)
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

    /// The wordmark's first letter, not the translated name's. Same reason
    /// `BrandWordmark` does not translate: this is the mark, and a "و" in the
    /// box where every other surface shows a "W" is a different logo.
    private var letter: String {
        String(Str.brandWordmark.prefix(1))
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
