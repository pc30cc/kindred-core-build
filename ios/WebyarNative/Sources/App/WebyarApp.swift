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
    @Environment(\.scenePhase) private var scenePhase

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
        .task(id: pushSessionKey) {
            await PushController.shared.sessionChanged(
                signedIn: appState.session.user != nil,
                workspaceID: appState.selectedWorkspace?.id
            )
        }
        // Realtime runs only while the app is in front of the operator.
        //
        // Active: the saved copy is already on screen; realtime connects and
        // whatever changed while away is read (a delta, a revalidated list).
        // Background: the socket closes at once and nothing polls — APNs is
        // how the operator is reached from there, and iOS would suspend a
        // socket kept open anyway. Inactive (Control Centre, the app
        // switcher) changes nothing: it is usually over in a second.
        .onChange(of: scenePhase) { _, phase in
            switch phase {
            case .active:
                SyncCoordinator.shared.appBecameActive()
                Task { await appState.refreshIfStale() }
            case .background:
                SyncCoordinator.shared.appEnteredBackground()
            default:
                break
            }
        }
    }

    /// Changes when a different operator signs in, or the same one moves to
    /// another workspace. Written as one string for the same reason
    /// `InboxView.reloadKey` is: `.task(id:)` wants a single value, and a
    /// view's own computed property can read the environment where a separate
    /// type's initializer cannot.
    private var pushSessionKey: String {
        "\(appState.session.user?.id ?? "-")|\(appState.selectedWorkspace?.id ?? "-")"
    }
}

/// The brief moment before we know whether there is a session.
///
/// It takes over from the system's own launch image, which is a flat fill and
/// nothing else, so the job is to continue that image rather than to replace
/// it: same colour underneath, and everything this screen adds arrives by
/// fading in on top of it. Anything already drawn at the first frame is a cut
/// between two screens instead of one screen becoming another.
///
/// What it adds is the brand's own mark, not its name: the icon the operator
/// has just tapped, carried from the home screen into the app, with a ring of
/// the icon's two blues running round it. The name set in type read as a
/// placeholder; the mark reads as the product, and the ring says "loading"
/// without a second element saying it again underneath.
struct LaunchView: View {
    @Environment(AppState.self) private var appState

    @State private var hasAppeared = false

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
            // Not `.systemBackground`, which is pure white and pure black:
            // this asset is neither (#F4F6F9 and #0C0E14), and the difference
            // would be a one-frame change of background on every launch.
            Color("LaunchBackground")
                .ignoresSafeArea()

            LaunchGlow()
                .opacity(hasAppeared ? 1 : 0)

            LaunchLoader()
                .accessibilityElement()
                .accessibilityLabel(Str.appName(appState.language))
                .accessibilityAddTraits(.updatesFrequently)
        }
        .task {
            withAnimation(.easeOut(duration: 0.6)) { hasAppeared = true }
        }
    }
}

/// The icon's two blues, as the loader draws them: the deep blue of its
/// lower edge and the cyan of its highlight.
private enum LaunchPalette {
    static let deep = Color(red: 0.047, green: 0.314, blue: 0.914)
    static let cyan = Color(red: 0.180, green: 0.839, blue: 1.000)
}

/// Light behind the mark: two soft pools, the icon's blue and its cyan, that
/// breathe slowly. A launch screen has one thing on it and a lot of empty
/// space; lighting the space is what keeps the mark from looking dropped onto
/// a blank page.
private struct LaunchGlow: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var breathe = false

    var body: some View {
        ZStack {
            RadialGradient(
                colors: [LaunchPalette.deep.opacity(0.18), .clear],
                center: .center, startRadius: 0, endRadius: 280
            )
            RadialGradient(
                colors: [LaunchPalette.cyan.opacity(0.16), .clear],
                center: UnitPoint(x: 0.62, y: 0.42), startRadius: 0, endRadius: 200
            )
            .opacity(breathe ? 1 : 0.45)
            .animation(
                reduceMotion ? nil : .easeInOut(duration: 2.4).repeatForever(autoreverses: true),
                value: breathe
            )
        }
        .ignoresSafeArea()
        .accessibilityHidden(true)
        .task { if !reduceMotion { breathe = true } }
    }
}

/// The icon, breathing, inside a ring whose bright head runs round it.
///
/// Every loop is started once the mark has arrived, and each is scoped to the
/// one modifier it drives: a repeating animation begun in the same
/// transaction as the entrance would otherwise pick the entrance up too, and
/// the mark would bob in and out for as long as the screen is up.
private struct LaunchLoader: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var hasAppeared = false
    @State private var spin = false
    @State private var breathe = false

    private let markSize: CGFloat = 92
    private let ringSize: CGFloat = 138
    private let lineWidth: CGFloat = 3
    /// How much of the circle the lit arc covers.
    private let arc: CGFloat = 0.3

    var body: some View {
        ZStack {
            // Where the arc runs, barely there: the ring reads as a ring even
            // where the light is not.
            Circle()
                .stroke(Theme.Palette.brand.opacity(0.10), lineWidth: lineWidth)
                .frame(width: ringSize, height: ringSize)

            runner
                .frame(width: ringSize, height: ringSize)
                // Parked at the top for anyone who has asked the system to
                // reduce motion: still a loading ring, just not a moving one.
                .rotationEffect(.degrees(spin ? 270 : -90))
                .animation(
                    reduceMotion ? nil : .linear(duration: 1.15).repeatForever(autoreverses: false),
                    value: spin
                )

            mark
                .scaleEffect(breathe ? 1.035 : 1)
                .animation(
                    reduceMotion ? nil : .easeInOut(duration: 1.3).repeatForever(autoreverses: true),
                    value: breathe
                )
        }
        .opacity(hasAppeared ? 1 : 0)
        .scaleEffect(hasAppeared ? 1 : 0.9)
        // The ring turns the same way in every language: it is a clock, not text.
        .environment(\.layoutDirection, .leftToRight)
        .onAppear {
            withAnimation(.spring(response: 0.6, dampingFraction: 0.82)) { hasAppeared = true }
        }
        .task {
            guard !reduceMotion else { return }
            // After the entrance has been handed its own transaction.
            try? await Task.sleep(for: .milliseconds(60))
            spin = true
            breathe = true
        }
    }

    /// The lit arc — a comet, bright cyan at its head and fading to nothing
    /// at its tail — and a small glowing bead on its head.
    private var runner: some View {
        ZStack {
            Circle()
                .trim(from: 0, to: arc)
                .stroke(
                    AngularGradient(
                        gradient: Gradient(stops: [
                            .init(color: LaunchPalette.deep.opacity(0), location: 0),
                            .init(color: LaunchPalette.deep, location: 0.55),
                            .init(color: LaunchPalette.cyan, location: 1),
                        ]),
                        center: .center,
                        startAngle: .degrees(0),
                        endAngle: .degrees(arc * 360)
                    ),
                    style: StrokeStyle(lineWidth: lineWidth, lineCap: .round)
                )

            Circle()
                .fill(LaunchPalette.cyan)
                .frame(width: lineWidth * 2.4, height: lineWidth * 2.4)
                .shadow(color: LaunchPalette.cyan.opacity(0.9), radius: 5)
                .offset(x: ringSize / 2)
                .rotationEffect(.degrees(arc * 360))
        }
    }

    /// The home-screen icon, cut to the same continuous corner iOS gives it,
    /// so the thing tapped is the thing that appears.
    private var mark: some View {
        let shape = RoundedRectangle(cornerRadius: markSize * 0.2237, style: .continuous)
        return Image("LaunchMark")
            .resizable()
            .interpolation(.high)
            .frame(width: markSize, height: markSize)
            .clipShape(shape)
            .overlay(shape.strokeBorder(.white.opacity(0.22), lineWidth: 0.5))
            .shadow(color: LaunchPalette.deep.opacity(0.32), radius: 18, y: 8)
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
