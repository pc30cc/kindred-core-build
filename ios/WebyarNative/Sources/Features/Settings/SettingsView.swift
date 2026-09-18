import SwiftUI

/// What the app shows regardless of the device's own setting.
enum AppearancePreference: String, CaseIterable, Identifiable, Sendable {
    case system, light, dark

    var id: String { rawValue }

    var colorScheme: ColorScheme? {
        switch self {
        case .system: nil
        case .light: .light
        case .dark: .dark
        }
    }

    func title(_ language: Language) -> String {
        switch self {
        case .system: Str.appearanceSystem(language)
        case .light: Str.appearanceLight(language)
        case .dark: Str.appearanceDark(language)
        }
    }
}

struct SettingsView: View {
    @Environment(AppState.self) private var appState
    @Environment(\.openURL) private var openURL

    @State private var isConfirmingSignOut = false
    @State private var isSigningOut = false
    @State private var signOutFailed = false
    @State private var profile: AccountProfile?

    private var language: Language { appState.language }

    private var appVersion: String {
        let info = Bundle.main.infoDictionary
        let short = info?["CFBundleShortVersionString"] as? String ?? "—"
        let build = info?["CFBundleVersion"] as? String ?? "—"
        return "\(short) (\(build))"
    }

    var body: some View {
        @Bindable var appState = appState

        List {
            // The account header doubles as the way into the profile editor —
            // tapping your own name and photo to change them is where anyone
            // looks first.
            Section {
                NavigationLink {
                    ProfileView()
                } label: {
                    HStack(spacing: Theme.Space.md) {
                        Avatar(
                            name: profile?.fullName ?? appState.session.user?.displayName ?? "—",
                            imageURL: profile?.avatarURL,
                            size: Theme.Size.avatarMedium + 6
                        )

                        VStack(alignment: .leading, spacing: Theme.Space.xxs) {
                            Text(profile?.fullName ?? appState.session.user?.displayName ?? "—")
                                .font(Theme.Typo.rowTitle)
                                .foregroundStyle(Theme.Palette.label)
                                .lineLimit(1)

                            if let email = appState.session.user?.email, !email.isEmpty {
                                Text(email)
                                    .font(.subheadline)
                                    .foregroundStyle(Theme.Palette.labelSecondary)
                                    .lineLimit(1)
                                    .environment(\.layoutDirection, .leftToRight)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                            }
                        }
                    }
                    .padding(.vertical, Theme.Space.xs)
                }
            } header: {
                Text(Str.account(language))
            }

            // Workspace, plan and language are all "what am I working in"
            // questions, so they share one section without a repeated header.
            Section {
                if appState.workspaces.count > 1 {
                    Picker(Str.workspace(language), selection: workspaceBinding) {
                        ForEach(appState.workspaces) { workspace in
                            Text(workspace.name).tag(workspace.id)
                        }
                    }
                } else if let workspace = appState.selectedWorkspace {
                    DetailRow(label: Str.workspace(language), value: workspace.name)
                }

                // Only shown once the plan has actually resolved — a blank or
                // guessed plan name is worse than none.
                if let plan = appState.entitlements.value?.plan,
                   let name = plan.name ?? plan.slug {
                    DetailRow(label: Str.plan(language), value: name)
                }

                Picker(Str.language(language), selection: $appState.language) {
                    ForEach(Language.allCases) { option in
                        Text(option.endonym).tag(option)
                    }
                }

                Picker(Str.appearance(language), selection: $appState.appearance) {
                    ForEach(AppearancePreference.allCases) { option in
                        Text(option.title(language)).tag(option)
                    }
                }
            }

            Section {
                NavigationLink {
                    SecurityView()
                } label: {
                    Label(Str.security(language), systemImage: "lock.shield")
                }
            }

            Section {
                DetailRow(label: Str.version(language), value: appVersion, isLatin: true)

                if let support = GeneratedConfig.supportURL {
                    Button {
                        openURL(support)
                    } label: {
                        HStack {
                            Text(supportLabel)
                                .foregroundStyle(Theme.Palette.brand)
                            Spacer()
                            Image(systemName: "arrow.up.right")
                                .font(.footnote)
                                .foregroundStyle(Theme.Palette.labelTertiary)
                        }
                        .frame(minHeight: Theme.Size.minTouchTarget - 10)
                    }
                }
            } header: {
                Text(Str.about(language))
            }

            Section {
                Button(role: .destructive) {
                    isConfirmingSignOut = true
                } label: {
                    HStack {
                        Spacer()
                        if isSigningOut {
                            ProgressView()
                        } else {
                            Text(Str.signOut(language))
                        }
                        Spacer()
                    }
                    .frame(minHeight: Theme.Size.minTouchTarget - 10)
                }
                .disabled(isSigningOut)
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle(Str.tabSettings(language))
        .navigationBarTitleDisplayMode(.inline)
        .floatingTabBarInset()
        .task { await loadProfile() }
        .confirmationDialog(
            Str.signOutConfirm(language),
            isPresented: $isConfirmingSignOut,
            titleVisibility: .visible
        ) {
            Button(Str.signOut(language), role: .destructive) { signOut() }
            Button(Str.cancel(language), role: .cancel) {}
        }
        .alert(Str.signOutFailed(language), isPresented: $signOutFailed) {
            Button(Str.cancel(language), role: .cancel) {}
        }
    }

    private var supportLabel: String {
        switch language {
        case .en: "Support"
        case .fa: "پشتیبانی"
        case .tr: "Destek"
        }
    }

    private var workspaceBinding: Binding<String> {
        Binding(
            get: { appState.selectedWorkspace?.id ?? "" },
            set: { id in
                if let match = appState.workspaces.first(where: { $0.id == id }) {
                    appState.select(match)
                }
            }
        )
    }

    /// The header needs the photo, which the session user does not carry.
    private func loadProfile() async {
        profile = try? await Backend.current.account().profile
    }

    private func signOut() {
        isSigningOut = true
        Task {
            let succeeded = await appState.signOut()
            isSigningOut = false
            // Only report failure — on success the whole screen is replaced by
            // the login view, so there is nothing left to say.
            if !succeeded { signOutFailed = true }
        }
    }
}
