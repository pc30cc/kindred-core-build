import SwiftUI

struct SettingsView: View {
    @Environment(AppState.self) private var appState
    @Environment(\.openURL) private var openURL

    @State private var isConfirmingSignOut = false
    @State private var isSigningOut = false
    @State private var signOutFailed = false

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
            if let user = appState.session.user {
                Section {
                    HStack(spacing: Theme.Space.md) {
                        Avatar(name: user.displayName, imageURL: nil, size: Theme.Size.avatarMedium + 6)

                        VStack(alignment: .leading, spacing: Theme.Space.xxs) {
                            Text(user.displayName)
                                .font(Theme.Typo.rowTitle)
                                .foregroundStyle(Theme.Palette.label)
                                .lineLimit(1)

                            if let email = user.email, !email.isEmpty {
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
                } header: {
                    Text(Str.account(language))
                }
            }

            // Workspace and language are both preferences, so they share one
            // section. Giving each its own header would repeat the row's own
            // label directly above it, which reads as a mistake.
            Section {
                // A picker is only worth showing when there is a choice.
                if appState.workspaces.count > 1 {
                    Picker(Str.workspace(language), selection: workspaceBinding) {
                        ForEach(appState.workspaces) { workspace in
                            Text(workspace.name).tag(workspace.id)
                        }
                    }
                } else if let workspace = appState.selectedWorkspace {
                    DetailRow(label: Str.workspace(language), value: workspace.name)
                }

                Picker(Str.language(language), selection: $appState.language) {
                    ForEach(Language.allCases) { option in
                        Text(option.endonym).tag(option)
                    }
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
        .navigationBarTitleDisplayMode(.large)
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
