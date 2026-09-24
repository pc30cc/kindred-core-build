import SwiftUI
import Observation

@MainActor
@Observable
final class SecurityViewModel {
    private(set) var sessions: [AccountSession] = []
    private(set) var isLoading = true
    private(set) var isChangingPassword = false
    private(set) var revoking: Set<String> = []

    var currentPassword = ""
    var newPassword = ""
    var banner: ProfileViewModel.Banner?

    private let api: any WebyarAPI

    init(api: any WebyarAPI = Backend.current) {
        self.api = api
    }

    var canChangePassword: Bool {
        !currentPassword.isEmpty && newPassword.count >= 8 && !isChangingPassword
    }

    func load(appState: AppState) async {
        do {
            sessions = try await api.sessions().sessions
        } catch APIError.unauthorized {
            await appState.handleUnauthorized()
        } catch {
            // The section shows nothing rather than a wrong list.
        }
        isLoading = false
    }

    func changePassword(appState: AppState) async {
        guard newPassword.count >= 8 else {
            banner = .init(text: Str.passwordTooShort(appState.language), tone: .failure)
            return
        }

        isChangingPassword = true
        do {
            try await api.changePassword(current: currentPassword, new: newPassword)
            currentPassword = ""
            newPassword = ""
            banner = .init(text: Str.passwordChanged(appState.language), tone: .success)
            Haptics.success()
            // Changing a password can end other sessions server-side, so the
            // device list is no longer trustworthy until it is re-read.
            await load(appState: appState)
        } catch APIError.unauthorized {
            // Here a 401 means the *current* password was wrong, not that the
            // session died — signing the operator out over a typo would be
            // wrong.
            banner = .init(text: Str.loginFailed(appState.language), tone: .failure)
        } catch let APIError.server(_, message) {
            banner = .init(text: message ?? Str.saveFailed(appState.language), tone: .failure)
        } catch {
            banner = .init(text: Str.saveFailed(appState.language), tone: .failure)
        }
        isChangingPassword = false
    }

    /// The signed-in devices, one row each.
    ///
    /// `auth_sessions` holds a row per SIGN-IN, not per device, and a mobile
    /// session lasts sixty days — so a phone that has been signed into a few
    /// times over a couple of months is a few rows, all of them live, all of
    /// them saying the same thing. The list was long for that reason and for
    /// no other: the server already excludes everything revoked or expired.
    ///
    /// Grouped by what actually identifies a device — its browser, OS and
    /// kind — with the newest sign-in supplying what is shown, and signing
    /// one out taking every session behind it.
    func devices(language: Language) -> [SignedInDevice] {
        var order: [String] = []
        var grouped: [String: [AccountSession]] = [:]
        for session in sessions {
            let key = [session.device, session.os, session.browser]
                .map { ($0 ?? "").lowercased() }
                .joined(separator: "|")
            if grouped[key] == nil { order.append(key) }
            grouped[key, default: []].append(session)
        }

        return order.compactMap { key in
            guard let group = grouped[key], let newest = group.first else { return nil }
            return SignedInDevice(
                id: newest.id,
                label: newest.deviceLabel(language),
                location: newest.locationLabel,
                lastActiveAt: newest.lastActiveAt,
                isCurrent: group.contains { $0.isCurrent == true },
                sessionIDs: group.map(\.id)
            )
        }
    }

    /// Signs a device out — every session it holds, not just the newest.
    ///
    /// Leaving the older ones live would revoke the row the operator can see
    /// and keep the ones they cannot, which is worse than doing nothing.
    func signOut(_ device: SignedInDevice, appState: AppState) async {
        revoking.formUnion(device.sessionIDs)
        var failed = false
        for id in device.sessionIDs {
            do {
                try await api.revokeSession(id: id)
                sessions.removeAll { $0.id == id }
            } catch APIError.unauthorized {
                await appState.handleUnauthorized()
                revoking.subtract(device.sessionIDs)
                return
            } catch {
                failed = true
            }
        }
        revoking.subtract(device.sessionIDs)
        if failed {
            banner = .init(text: Str.saveFailed(appState.language), tone: .failure)
            await load(appState: appState)
        } else {
            Haptics.success()
        }
    }

    func revoke(_ session: AccountSession, appState: AppState) async {
        revoking.insert(session.id)
        do {
            try await api.revokeSession(id: session.id)
            sessions.removeAll { $0.id == session.id }
        } catch APIError.unauthorized {
            await appState.handleUnauthorized()
        } catch {
            banner = .init(text: Str.saveFailed(appState.language), tone: .failure)
        }
        revoking.remove(session.id)
    }
}

struct SecurityView: View {
    @Environment(AppState.self) private var appState
    @Environment(\.locale) private var locale
    @State private var model = SecurityViewModel()

    private var language: Language { appState.language }

    var body: some View {
        @Bindable var model = model

        List {
            Section {
                SecureField(Str.currentPassword(language), text: $model.currentPassword)
                    .textContentType(.password)
                    .environment(\.layoutDirection, .leftToRight)

                SecureField(Str.newPassword(language), text: $model.newPassword)
                    .textContentType(.newPassword)
                    .environment(\.layoutDirection, .leftToRight)

                Button {
                    Task { await model.changePassword(appState: appState) }
                } label: {
                    HStack(spacing: Theme.Space.sm) {
                        if model.isChangingPassword { ProgressView().controlSize(.small) }
                        Text(Str.changePassword(language))
                    }
                    .font(.app(.subheadline, weight: .semibold))
                    .foregroundStyle(model.canChangePassword ? Theme.Palette.brand : Theme.Palette.labelTertiary)
                    .frame(minHeight: Theme.Size.minTouchTarget - 10)
                }
                .disabled(!model.canChangePassword)
            } header: {
                Text(Str.changePassword(language))
            } footer: {
                Text(Str.passwordTooShort(language))
            }

            Section {
                if model.isLoading {
                    ProgressView()
                        .frame(maxWidth: .infinity)
                        .listRowSeparator(.hidden)
                } else if model.sessions.isEmpty {
                    QuietRow(text: "—")
                } else {
                    ForEach(model.devices(language: language)) { device in
                        SessionRow(
                            device: device,
                            language: language,
                            locale: locale,
                            isRevoking: model.revoking.contains(device.id),
                            onRevoke: { Task { await model.signOut(device, appState: appState) } }
                        )
                    }
                }
            } header: {
                Text(Str.activeSessions(language))
            }

            // Last, and on the security screen rather than the root: it is
            // the other thing you do to your own account, it belongs beside
            // the password and the sessions, and nothing should meet it on
            // the way to something else.
            //
            // A value on the stack's own route type rather than an inline
            // destination: this stack is driven by a path, and a link that
            // pushes outside it leaves the path saying the stack is at its
            // root while a screen is open on top of it.
            Section {
                NavigationLink(value: SettingsRoute.deleteAccount) {
                    SettingsRowLabel(
                        title: Str.deleteAccount(language),
                        systemImage: "trash",
                        tint: Theme.Palette.danger,
                        isDestructive: true
                    )
                    .frame(minHeight: Theme.Size.minTouchTarget - 10)
                }
                .accessibilityIdentifier(A11y.deleteAccountRow)
            }
        }
        .listStyle(.insetGrouped)
        .dismissesKeyboardOnTap()
        .navigationTitle(Str.security(language))
        .navigationBarTitleDisplayMode(.inline)
        .task { await model.load(appState: appState) }
        .alert(
            model.banner?.text ?? "",
            isPresented: Binding(
                get: { model.banner != nil },
                set: { if !$0 { model.banner = nil } }
            )
        ) {
            Button(Str.ok(language), role: .cancel) { model.banner = nil }
        }
    }
}

/// One signed-in device.
///
/// The current device is labelled and cannot be revoked from here — signing
/// yourself out belongs to the Sign out button, and offering it twice in two
/// different shapes invites the accidental one.
/// One signed-in device.
///
/// Every live session behind it, as one row, with a sign-out that is a BUTTON
/// rather than a swipe. The swipe was the only way to reach it, and a control
/// that has to be discovered is a control most people never use — on the one
/// screen where "I do not recognise that device" has to be actionable in the
/// moment somebody notices it.
struct SessionRow: View {
    let device: SignedInDevice
    let language: Language
    let locale: Locale
    let isRevoking: Bool
    let onRevoke: () -> Void

    var body: some View {
        HStack(spacing: Theme.Space.sm) {
            VStack(alignment: .leading, spacing: Theme.Space.xs) {
                HStack(spacing: Theme.Space.sm) {
                    Text(device.label)
                        .font(Theme.Typo.rowTitle)
                        .lineLimit(1)

                    if device.isCurrent {
                        StatusPill(text: Str.thisDevice(language), tint: Theme.Palette.success)
                    }
                }

                HStack(spacing: Theme.Space.sm) {
                    if let location = device.location {
                        Text(location)
                    }
                    if let last = device.lastActiveAt {
                        Text(Format.listTimestamp(last, locale: locale))
                    }
                }
                .font(Theme.Typo.meta)
                .foregroundStyle(Theme.Palette.labelSecondary)
            }

            Spacer(minLength: Theme.Space.sm)

            // Not for this one. Signing the phone in your hand out from a
            // list of other phones is what the Sign Out row above is for, and
            // doing it here would read as an accident.
            if !device.isCurrent {
                Button(action: onRevoke) {
                    if isRevoking {
                        ProgressView().controlSize(.small)
                    } else {
                        Text(Str.signOutDevice(language))
                            .font(.app(.subheadline, weight: .semibold))
                            .foregroundStyle(Theme.Palette.danger)
                    }
                }
                // Borderless, or the whole row becomes the button and tapping
                // anywhere signs a device out.
                .buttonStyle(.borderless)
                .disabled(isRevoking)
            }
        }
        .padding(.vertical, Theme.Space.xxs)
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            if !device.isCurrent {
                Button(role: .destructive, action: onRevoke) {
                    Label(Str.revokeSession(language), systemImage: "xmark.circle")
                }
                .disabled(isRevoking)
            }
        }
    }
}

/// Every live session that belongs to one device.
struct SignedInDevice: Identifiable, Equatable, Sendable {
    /// The newest session's id, which is also what identifies the row.
    let id: String
    let label: String
    let location: String?
    let lastActiveAt: Date?
    let isCurrent: Bool
    /// All of them, so signing out takes the lot.
    let sessionIDs: [String]
}
