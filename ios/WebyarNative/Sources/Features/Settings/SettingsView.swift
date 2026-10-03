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

/// The sub-screens Settings can push to.
enum SettingsRoute: Hashable {
    case profile
    case notifications
    case security
    /// What the app keeps on this phone, and Clear Cache.
    case storage
    /// Pushed from Security rather than from here — it is the far end of the
    /// account section, not a top-level setting — but it is on this type so
    /// that the whole stack travels through one path.
    case deleteAccount
    /// Online support: the open conversation with the platform's team, or a
    /// fresh start. Also where a `support_reply` notification lands.
    case support
    /// Online support's conversations that ended, the newest first.
    case supportClosed
    /// One of them, read back.
    case supportClosedConversation(String)
}

struct SettingsView: View {
    @Environment(AppState.self) private var appState
    @Environment(\.openURL) private var openURL
    @Environment(\.scenePhase) private var scenePhase

    @State private var isConfirmingSignOut = false
    @State private var isSigningOut = false
    @State private var signOutFailed = false
    @State private var profile: AccountProfile?
    /// Online support: whether the platform's team is there, and what it
    /// wrote that is still unread.
    @State private var support = SupportStatusModel()

    private var language: Language { appState.language }

    /// The version and the build as this binary carries them — the numbers
    /// App Store Connect and TestFlight show for it, read from the bundle
    /// rather than written here, so they can never disagree.
    private var appVersion: String {
        Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "—"
    }

    private var appBuild: String {
        Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "—"
    }

    /// A row in About that opens a page in the browser.
    private func linkRow(_ title: String, icon: String, url: URL) -> some View {
        Button {
            openURL(url)
        } label: {
            HStack(spacing: Theme.Space.sm) {
                Image(systemName: icon)
                    .font(.system(size: 15, weight: .medium))
                    .foregroundStyle(Theme.Palette.brand)
                Text(title)
                    .foregroundStyle(Theme.Palette.brand)
                Spacer()
                Image(systemName: "arrow.up.right")
                    .font(.app(.footnote))
                    .foregroundStyle(Theme.Palette.labelTertiary)
            }
            .frame(minHeight: Theme.Size.minTouchTarget - 10)
        }
    }

    var body: some View {
        @Bindable var appState = appState

        List {
            // The account header doubles as the way into the profile editor —
            // tapping your own name and photo to change them is where anyone
            // looks first.
            Section {
                NavigationLink(value: SettingsRoute.profile) {
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
                                    .font(.app(.subheadline))
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
                // Every workspace the operator belongs to, each with its own
                // logo. A Picker put them behind a tap and showed only names,
                // which made a second workspace easy to miss entirely and gave
                // no hint of which company a name belonged to — the logo is
                // how people actually recognise their own workspace.
                ForEach(appState.workspaces) { workspace in
                    WorkspaceRow(
                        workspace: workspace,
                        isCurrent: workspace.id == appState.selectedWorkspace?.id,
                        isOnly: appState.workspaces.count == 1,
                        label: Str.workspace(language)
                    ) {
                        guard workspace.id != appState.selectedWorkspace?.id else { return }
                        appState.select(workspace)
                    }
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

            // Whether visitors can see you is a thing you change between one
            // conversation and the next, so it sits above the account plumbing
            // rather than buried under it.
            AvailabilitySection(language: language)

            // Sign out is a settings row like any other, not a slab of button
            // parked under the last section. It sits with security because
            // that is what it is — the other thing you do to your session —
            // and keeping it in the list is what lets the list end where its
            // content ends.
            Section {
                // Above security rather than buried at the bottom: it is the
                // setting an operator goes looking for, and the one that
                // decides whether the app is any use when it is closed.
                NavigationLink(value: SettingsRoute.notifications) {
                    Label(Str.notifications(language), systemImage: "bell.badge")
                }

                NavigationLink(value: SettingsRoute.security) {
                    Label(Str.security(language), systemImage: "lock.shield")
                }

                // Super Admin can take this row away (Mobile App → iOS →
                // In-app settings); the cache it describes keeps working.
                if appState.storageVisible {
                    NavigationLink(value: SettingsRoute.storage) {
                        Label(Str.storage(language), systemImage: "internaldrive")
                    }
                    .accessibilityIdentifier(A11y.storageRow)
                }

                Button {
                    isConfirmingSignOut = true
                } label: {
                    HStack {
                        Label(Str.signOut(language), systemImage: "rectangle.portrait.and.arrow.right")
                            .foregroundStyle(Theme.Palette.danger)
                        Spacer(minLength: Theme.Space.sm)
                        if isSigningOut {
                            ProgressView()
                        }
                    }
                }
                .disabled(isSigningOut)
            }

            // Online support, when the platform offers it to this operator
            // and Super Admin has not taken it out of the iPhone app.
            if appState.supportAllowed, let status = support.status, status.shown {
                SupportSettingsSection(status: status, language: language)
            }

            Section {
                DetailRow(label: Str.version(language), value: appVersion, isLatin: true)
                    .accessibilityIdentifier(A11y.settingsVersion)
                DetailRow(label: SettingsStr.build(language), value: appBuild, isLatin: true)
                    .accessibilityIdentifier(A11y.settingsBuild)

                // The platform's site — its address and its name are Super
                // Admin's (Mobile App → iOS → In-app settings).
                if let website = appState.websiteURL {
                    Button {
                        openURL(website)
                    } label: {
                        HStack(spacing: Theme.Space.sm) {
                            Image(systemName: "globe")
                                .font(.system(size: 15, weight: .medium))
                                .foregroundStyle(Theme.Palette.brand)
                            Text(appState.websiteLabel)
                                .foregroundStyle(Theme.Palette.brand)
                            Spacer()
                            Text(website.host() ?? "")
                                .font(.app(.footnote))
                                .foregroundStyle(Theme.Palette.labelTertiary)
                                .lineLimit(1)
                                .environment(\.layoutDirection, .leftToRight)
                            Image(systemName: "arrow.up.right")
                                .font(.app(.footnote))
                                .foregroundStyle(Theme.Palette.labelTertiary)
                        }
                        .frame(minHeight: Theme.Size.minTouchTarget - 10)
                    }
                    .accessibilityIdentifier(A11y.settingsWebsite)
                }

                // The App Store record's own privacy policy and terms (Super
                // Admin → Mobile App → App Store record).
                if let privacy = appState.legalLinks.privacyPolicy {
                    linkRow(SettingsStr.privacyPolicy(language), icon: "hand.raised", url: privacy)
                        .accessibilityIdentifier(A11y.settingsPrivacyPolicy)
                }
                if let terms = appState.legalLinks.terms {
                    linkRow(SettingsStr.termsOfUse(language), icon: "doc.text", url: terms)
                        .accessibilityIdentifier(A11y.settingsTerms)
                }
            } header: {
                Text(Str.about(language))
            }
        }
        .listStyle(.insetGrouped)
        .navigationDestination(for: SettingsRoute.self) { route in
            switch route {
            case .profile: ProfileView()
            case .notifications: NotificationSettingsView()
            case .security: SecurityView()
            case .storage: StorageView()
            case .deleteAccount: DeleteAccountView()
            case .support: SupportChatView()
            case .supportClosed: SupportClosedListView()
            case .supportClosedConversation(let id): SupportClosedConversationView(conversationID: id)
            }
        }
        .navigationTitle(Str.tabSettings(language))
        .navigationBarTitleDisplayMode(.inline)
        .floatingTabBarInset()
        .task { await loadProfile() }
        // While Settings is on screen and in front of the operator: the
        // team's presence and unread count, live and every minute.
        .task(id: scenePhase == .active && appState.supportAllowed) {
            guard scenePhase == .active, appState.supportAllowed else { return }
            await support.follow(SyncCoordinator.shared.supportSignals())
        }
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

    /// The header needs the photo, which the session user does not carry.
    ///
    /// Re-read here rather than only at sign-in, because the profile editor is
    /// one tap away and a photograph changed there has to be the one this
    /// header shows on the way back.
    private func loadProfile() async {
        await appState.loadProfile()
        profile = appState.profile
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

/// One workspace in Settings: its logo, its name, and a tick when it is the
/// one being worked in.
///
/// A single workspace is not a choice, so it reads as a plain labelled row
/// rather than something that looks tappable and does nothing.
private struct WorkspaceRow: View {
    let workspace: Workspace
    let isCurrent: Bool
    let isOnly: Bool
    let label: String
    let onSelect: () -> Void

    var body: some View {
        if isOnly {
            content.accessibilityIdentifier(A11y.workspaceRow(workspace.id))
        } else {
            Button(action: onSelect) { content }
                .buttonStyle(.plain)
                .accessibilityAddTraits(isCurrent ? [.isButton, .isSelected] : .isButton)
                .accessibilityIdentifier(A11y.workspaceRow(workspace.id))
        }
    }

    private var content: some View {
        HStack(spacing: Theme.Space.sm) {
            Avatar(name: workspace.name, imageURL: workspace.logoURL, size: Theme.Size.avatarSmall, subject: .organisation)

            VStack(alignment: .leading, spacing: 1) {
                if isOnly {
                    Text(label)
                        .font(Theme.Typo.meta)
                        .foregroundStyle(Theme.Palette.labelSecondary)
                }
                Text(workspace.name)
                    .font(.app(.body))
                    .foregroundStyle(Theme.Palette.label)
                    .lineLimit(1)
            }

            Spacer(minLength: 0)

            if isCurrent && !isOnly {
                Image(systemName: "checkmark")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(Theme.Palette.brand)
            }
        }
        .contentShape(Rectangle())
    }
}
