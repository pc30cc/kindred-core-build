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
                    .font(.subheadline.weight(.semibold))
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
                    ForEach(model.sessions) { session in
                        SessionRow(
                            session: session,
                            language: language,
                            locale: locale,
                            isRevoking: model.revoking.contains(session.id),
                            onRevoke: { Task { await model.revoke(session, appState: appState) } }
                        )
                    }
                }
            } header: {
                Text(Str.activeSessions(language))
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
struct SessionRow: View {
    let session: AccountSession
    let language: Language
    let locale: Locale
    let isRevoking: Bool
    let onRevoke: () -> Void

    private var isCurrent: Bool { session.isCurrent == true }

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Space.xs) {
            HStack(spacing: Theme.Space.sm) {
                Text(session.deviceLabel(language))
                    .font(Theme.Typo.rowTitle)
                    .lineLimit(1)

                if isCurrent {
                    StatusPill(text: Str.thisDevice(language), tint: Theme.Palette.success)
                }

                Spacer(minLength: 0)
            }

            HStack(spacing: Theme.Space.sm) {
                if let location = session.locationLabel {
                    Text(location)
                }
                if let last = session.lastActiveAt {
                    Text(Format.listTimestamp(last, locale: locale))
                }
            }
            .font(Theme.Typo.meta)
            .foregroundStyle(Theme.Palette.labelSecondary)
        }
        .padding(.vertical, Theme.Space.xxs)
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            if !isCurrent {
                Button(role: .destructive, action: onRevoke) {
                    Label(Str.revokeSession(language), systemImage: "xmark.circle")
                }
                .disabled(isRevoking)
            }
        }
    }
}
