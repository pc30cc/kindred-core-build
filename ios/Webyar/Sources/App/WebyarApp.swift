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
                // The type every text without a font of its own is set in —
                // the Persian font in Persian (see `Typeface`). `appState.language`
                // is read above, so this is re-resolved when it changes.
                .font(.app(.body))
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
            // A returning operator is shown their saved inbox now, not after
            // the three requests below have come back; `restore()` then asks
            // the server whether the session still stands.
            await appState.resumeSavedSession()
            // As early as possible — before anything at all on a first launch:
            // the platform names its own hosts in Super Admin, and an app that ignored that would keep
            // calling the old one for as long as it stayed installed.
            await Backend.current.refreshOrigin()
            // The privacy policy and terms, and the language Super Admin
            // chose for the iOS app until the operator picks one. When it
            // changes the language, the root is rebuilt in it and this runs
            // again there — the session is restored by that run, not this one.
            if await appState.adoptPublicConfig() { return }
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
                // Notifications may have been turned off — or back on — in
                // iOS Settings while the app was away.
                Task { await PushController.shared.refreshAuthorization() }
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
/// Deliberately quiet: a small loader in the middle, and the product's name
/// set small at the foot of the screen — no logo, no glow. A launch screen is
/// on screen for a few hundred milliseconds; anything bigger than this is the
/// app talking about itself while the operator waits to work.
///
/// And there from the first instant. The system's launch image is the
/// loader's own first frame (`LaunchLoader` in the asset catalog, named by
/// `UILaunchScreen.UIImageName`), centred on the whole screen as this loader
/// is, so the loader is on screen the moment the icon is tapped and this view
/// takes over in the same place, drawn at once and already turning — nothing
/// here fades in.
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
            // The exact colour the system's launch image is filled with —
            // `UILaunchScreen.UIColorName` in Info.plist names this asset.
            //
            // Not `.systemBackground`, which is pure white and pure black:
            // this asset is neither (#F4F6F9 and #0C0E14), and the difference
            // would be a one-frame change of background on every launch.
            Color("LaunchBackground")
                .ignoresSafeArea()

            // Centred on the whole screen, not on the safe area: that is
            // where the system centres the launch image it takes over from.
            LaunchLoader()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .ignoresSafeArea()
        }
        // The name at the foot, where sign in and password reset have it too.
        .brandFooter()
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(BrandStr.appName(appState.language))
        .accessibilityAddTraits(.updatesFrequently)
    }
}

/// Two arcs turning against each other: an outer comet of the brand's deep
/// colour running into its bright one, with a bright bead at its head, and a
/// fainter inner one going the other way. Small — the size of a large
/// spinner, not of a logo. The colours are the brand kit's (`BrandPalette`):
/// WebYar's turquoise, RESPOK's Signal and Ink.
///
/// Its resting pose — `spin` still false — is exactly the `LaunchLoader`
/// launch image (`scripts/ios/render-launch-loader.py` draws it from these
/// numbers), so the handoff from the system's launch screen shows nothing but
/// the loader starting to turn. Change a size, a colour or a starting angle
/// here and run the script again, for both brands.
private struct LaunchLoader: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var spin = false

    private let outer: CGFloat = 40
    private let inner: CGFloat = 24
    private let outerLine: CGFloat = 2.5
    private let innerLine: CGFloat = 2

    var body: some View {
        ZStack {
            // Where the outer arc runs, barely there.
            Circle()
                .stroke(BrandPalette.track.opacity(0.10), lineWidth: outerLine)
                .frame(width: outer, height: outer)

            comet
                .frame(width: outer, height: outer)
                // Parked at the top for anyone who has asked the system to
                // reduce motion: still a loader, just not a moving one.
                .rotationEffect(.degrees(spin ? 270 : -90))
                .animation(
                    reduceMotion ? nil : .linear(duration: 1.0).repeatForever(autoreverses: false),
                    value: spin
                )

            Circle()
                .trim(from: 0, to: 0.22)
                .stroke(
                    BrandPalette.second.opacity(0.55),
                    style: StrokeStyle(lineWidth: innerLine, lineCap: .round)
                )
                .frame(width: inner, height: inner)
                .rotationEffect(.degrees(spin ? -450 : 90))
                .animation(
                    reduceMotion ? nil : .linear(duration: 1.6).repeatForever(autoreverses: false),
                    value: spin
                )
        }
        // It turns the same way in every language: it is a clock, not text.
        .environment(\.layoutDirection, .leftToRight)
        // Turning from the first frame. Each loop is scoped to the one
        // modifier it drives, so nothing else on the screen repeats with it.
        .onAppear {
            guard !reduceMotion else { return }
            spin = true
        }
    }

    /// The bright colour at its head, fading to nothing at its tail, with a
    /// small glowing bead leading it.
    private var comet: some View {
        let arc: CGFloat = 0.32
        return ZStack {
            Circle()
                .trim(from: 0, to: arc)
                .stroke(
                    AngularGradient(
                        gradient: Gradient(stops: [
                            .init(color: BrandPalette.deep.opacity(0), location: 0),
                            .init(color: BrandPalette.deep, location: 0.55),
                            .init(color: BrandPalette.bright, location: 1),
                        ]),
                        center: .center,
                        startAngle: .degrees(0),
                        endAngle: .degrees(arc * 360)
                    ),
                    style: StrokeStyle(lineWidth: outerLine, lineCap: .round)
                )

            Circle()
                .fill(BrandPalette.bright)
                .frame(width: outerLine * 1.9, height: outerLine * 1.9)
                .shadow(color: BrandPalette.bright.opacity(0.9), radius: 3)
                .offset(x: outer / 2)
                .rotationEffect(.degrees(arc * 360))
        }
    }
}

/// A square mark for the places that need one: the icon-shaped fallback
/// behind a promotion with no artwork of its own.
///
/// The brand kit's symbol on the app icon's own ground, drawn from vector:
/// the asset catalog's `BrandMark` (WebYar's white speech bubble, whose dots
/// show the turquoise through; RESPOK's Thread pills, white and Ink) over
/// `BrandPalette.tile`, at the size the icon gives it — so the fallback is
/// the icon the operator tapped, not a letter in a box.
///
/// Not the launch screen and not the login screen any more — both show the
/// name itself, which says more than a mark.
struct BrandMark: View {
    var size: CGFloat = 64

    var body: some View {
        RoundedRectangle(cornerRadius: size * 0.28, style: .continuous)
            .fill(BrandPalette.tile)
            .frame(width: size, height: size)
            .overlay(
                Image("BrandMark")
                    .resizable()
                    .renderingMode(.original)
                    .scaledToFit()
                    .frame(width: size * BrandPalette.markScale.width, height: size * BrandPalette.markScale.height)
            )
            .accessibilityHidden(true)
    }
}
