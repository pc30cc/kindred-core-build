import SwiftUI
import UIKit

/// The signed-in app, or — when the workspace's plan has the mobile app
/// switched off — the app as it stood, faded, under one card
/// (docs/operations/MOBILE_APP_PLAN.md, "The apps").
///
/// Locked, the live shell is taken off screen and a picture of it, taken at
/// that instant, is drawn blurred and dimmed in its place. That is what
/// makes "nothing in it works" true all at once: every tab, button, pull to
/// refresh and pushed screen is gone with the shell, and with them every
/// screen's own polling — their tasks end when their views do — while
/// `AppState` stops realtime and the notifications' taps
/// (`AppState.lockChanged`). What the member sees is still their app, where
/// they left it. Unlocked again — another workspace, or the plan switched
/// back on — the shell comes back on the tab it was on.
///
/// A call already on is never cut by a lock. The colleague call's screen is
/// in a window of its own above this one (`TeamCallWindow`), so it goes on
/// whatever happens here. A visitor call's screen is presented from the
/// conversation it was placed in — inside the shell — so the lock waits
/// until it closes (`VisitorCallScreens`); the call screen covers the whole
/// app meanwhile, and realtime, upkeep and the notifications' taps are
/// already stopped (`AppState.lockChanged`).
struct SignedInRoot: View {
    @Environment(AppState.self) private var appState
    @State private var visitorCalls = VisitorCallScreens.shared
    /// What is on screen: the lock follows `showsLock(…)`, one step behind
    /// it, so the picture is taken while the shell is still there.
    @State private var locked = false
    @State private var picture: UIImage?

    /// Whether the card takes the app's place now: the plan locks it, and no
    /// visitor call is on screen to be cut by it.
    static func showsLock(appLocked: Bool, visitorCallOnScreen: Bool) -> Bool {
        appLocked && !visitorCallOnScreen
    }

    private var wantsLock: Bool {
        Self.showsLock(appLocked: appState.isAppLocked, visitorCallOnScreen: visitorCalls.isOn)
    }

    var body: some View {
        ZStack {
            if locked {
                AppLockView(picture: picture)
                    .transition(.opacity)
            } else {
                MainTabView(initial: appState.selectedTab)
                    .transition(.opacity)
            }
        }
        .animation(Theme.Motion.standard, value: locked)
        .onChange(of: wantsLock, initial: true) { _, isLocked in
            guard isLocked != locked else { return }
            picture = isLocked ? AppScreenshot.capture() : nil
            locked = isLocked
        }
    }
}

/// The one card over the faded app.
///
/// The brand mark, the workspace it is about, why nothing answers, and the
/// only two ways on: another workspace, for a member of more than one, and
/// sign out. On the iPhone nothing here links to, names or hints at a
/// website or a purchase (App Store Review Guidelines 3.1.1 and 3.1.3(f);
/// owner's choice, 2026-11-02) — a member who is not the owner is asked to
/// contact the owner, and that is all.
struct AppLockView: View {
    @Environment(AppState.self) private var appState
    let picture: UIImage?

    @State private var choosingWorkspace = false
    @State private var confirmingSignOut = false
    @State private var signingOut = false
    @State private var signOutFailed = false

    @ScaledMetric(relativeTo: .title) private var markSize: CGFloat = 60

    private var language: Language { appState.language }

    var body: some View {
        ZStack {
            AppLockBackdrop(picture: picture)

            GeometryReader { proxy in
                ScrollView {
                    card
                        .frame(maxWidth: 420)
                        .padding(.horizontal, Theme.Space.xl)
                        .padding(.vertical, Theme.Space.huge)
                        .frame(maxWidth: .infinity, minHeight: proxy.size.height)
                }
                .scrollBounceBehavior(.basedOnSize)
            }
        }
        .onAppear {
            // VoiceOver moves to the card instead of staying on a control
            // that has just gone.
            UIAccessibility.post(notification: .screenChanged, argument: nil)
        }
        .sheet(isPresented: $choosingWorkspace) {
            AppLockWorkspacePicker()
        }
        .confirmationDialog(
            BrandStr.signOutConfirm(language),
            isPresented: $confirmingSignOut,
            titleVisibility: .visible
        ) {
            Button(Str.signOut(language), role: .destructive) { signOut() }
            Button(Str.cancel(language), role: .cancel) {}
        }
        .alert(Str.signOutFailed(language), isPresented: $signOutFailed) {
            Button(Str.cancel(language), role: .cancel) {}
        }
    }

    private var card: some View {
        VStack(spacing: 0) {
            BrandMark(size: min(markSize, 88))
                .shadow(color: BrandPalette.bright.opacity(0.30), radius: 16, x: 0, y: 6)

            if let workspace = appState.selectedWorkspace {
                workspaceChip(workspace)
                    .padding(.top, Theme.Space.lg)
            }

            Text(Str.appLockedTitle(language))
                .font(.app(.title3, .bold))
                .foregroundStyle(Theme.Palette.label)
                .padding(.top, Theme.Space.lg)
                .accessibilityAddTraits(.isHeader)

            Text(Str.appLockedBody(language))
                .font(.app(.subheadline))
                .foregroundStyle(Theme.Palette.labelSecondary)
                .padding(.top, Theme.Space.sm)

            if !appState.isWorkspaceOwner {
                Text(Str.appLockedAskOwner(language))
                    .font(.app(.footnote))
                    .foregroundStyle(Theme.Palette.labelSecondary)
                    .padding(.top, Theme.Space.sm)
            }

            VStack(spacing: Theme.Space.xs) {
                if appState.workspaces.count > 1 {
                    PrimaryButton(title: Str.appLockedSwitchWorkspace(language)) {
                        choosingWorkspace = true
                    }
                    .accessibilityIdentifier(A11y.appLockSwitchWorkspace)
                }

                Button {
                    confirmingSignOut = true
                } label: {
                    ZStack {
                        Text(Str.signOut(language))
                            .font(Theme.Typo.button)
                            .opacity(signingOut ? 0 : 1)
                        if signingOut {
                            ProgressView()
                        }
                    }
                    .foregroundStyle(Theme.Palette.danger)
                    .frame(maxWidth: .infinity, minHeight: Theme.Size.minTouchTarget)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(signingOut)
                .accessibilityIdentifier(A11y.appLockSignOut)
            }
            .padding(.top, Theme.Space.xl)
        }
        .multilineTextAlignment(.center)
        .fixedSize(horizontal: false, vertical: true)
        .padding(.horizontal, Theme.Space.xl)
        .padding(.top, Theme.Space.xxl)
        .padding(.bottom, Theme.Space.lg)
        .background(
            RoundedRectangle(cornerRadius: Theme.Radius.xl, style: .continuous)
                .fill(Theme.Palette.surface)
        )
        .overlay(
            RoundedRectangle(cornerRadius: Theme.Radius.xl, style: .continuous)
                .strokeBorder(Theme.Palette.separator.opacity(0.5), lineWidth: 0.5)
        )
        .shadow(color: .black.opacity(0.18), radius: 30, x: 0, y: 14)
        .accessibilityElement(children: .contain)
        .accessibilityAddTraits(.isModal)
        .accessibilityIdentifier(A11y.appLockCard)
    }

    /// Which workspace this is about: its logo (the workspace mark without
    /// one, never a letter) and its name.
    private func workspaceChip(_ workspace: Workspace) -> some View {
        HStack(spacing: Theme.Space.sm) {
            Avatar(name: workspace.name, imageURL: workspace.logoURL, size: 22, subject: .organisation)
            Text(workspace.name)
                .font(.app(.subheadline, .semibold))
                .foregroundStyle(Theme.Palette.label)
                .lineLimit(1)
        }
        .padding(.vertical, Theme.Space.xs + 2)
        .padding(.leading, Theme.Space.xs + 2)
        .padding(.trailing, Theme.Space.md)
        .background(Capsule().fill(Theme.Palette.surfaceElevated))
        .accessibilityElement(children: .combine)
    }

    private func signOut() {
        signingOut = true
        Task {
            let succeeded = await appState.signOut()
            signingOut = false
            // On success the whole app gives way to sign in.
            if !succeeded { signOutFailed = true }
        }
    }
}

/// The app behind the card: its picture, blurred and dimmed, or the plain
/// page colour when there was none to take.
private struct AppLockBackdrop: View {
    let picture: UIImage?

    /// Deeper in dark mode, where a light veil would read as fog.
    private static let scrim = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(white: 0, alpha: 0.50)
            : UIColor(white: 0, alpha: 0.24)
    })

    var body: some View {
        ZStack {
            Theme.Palette.background

            if let picture {
                Image(uiImage: picture)
                    .resizable()
                    .scaledToFill()
                    .blur(radius: 22, opaque: true)
            }

            Self.scrim
        }
        .clipped()
        .ignoresSafeArea()
        .accessibilityHidden(true)
    }
}

/// The workspace picker, for a member of more than one: the same rows as
/// Settings', whose list is behind the lock.
private struct AppLockWorkspacePicker: View {
    @Environment(AppState.self) private var appState
    @Environment(\.dismiss) private var dismiss

    private var language: Language { appState.language }

    var body: some View {
        NavigationStack {
            List {
                ForEach(appState.workspaces) { workspace in
                    WorkspaceRow(
                        workspace: workspace,
                        isCurrent: workspace.id == appState.selectedWorkspace?.id,
                        isOnly: false,
                        label: Str.workspace(language)
                    ) {
                        dismiss()
                        guard workspace.id != appState.selectedWorkspace?.id else { return }
                        appState.select(workspace)
                    }
                }
            }
            .listStyle(.insetGrouped)
            .navigationTitle(Str.appLockedSwitchWorkspace(language))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(Str.cancel(language)) { dismiss() }
                }
            }
        }
        .presentationDetents([.medium, .large])
    }
}

/// A picture of the app's own window as it is on screen right now — never
/// the colleague call's, which floats above it in a window of its own.
@MainActor
enum AppScreenshot {
    static func capture() -> UIImage? {
        let window = UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .filter { $0.activationState != .background && $0.activationState != .unattached }
            .flatMap(\.windows)
            .first { $0.windowLevel == .normal && !$0.isHidden }
        guard let window, window.bounds.width > 0, window.bounds.height > 0 else { return nil }
        // It is drawn blurred: one point per pixel is plenty, and a twelfth
        // of the memory of a full-resolution copy.
        let format = UIGraphicsImageRendererFormat.preferred()
        format.scale = 1
        format.opaque = true
        return UIGraphicsImageRenderer(bounds: window.bounds, format: format).image { _ in
            _ = window.drawHierarchy(in: window.bounds, afterScreenUpdates: false)
        }
    }
}
