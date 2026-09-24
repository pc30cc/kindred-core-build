import SwiftUI
import UserNotifications
import Observation

@MainActor
@Observable
final class NotificationSettingsModel {
    private(set) var prefs = NotificationPrefs()
    private(set) var isLoading = true
    private(set) var isSaving = false
    private(set) var loadFailed = false
    /// The last save that did not land, so a switch that sprang back has a
    /// reason next to it rather than just moving on its own.
    private(set) var saveFailed = false

    private let api: any WebyarAPI

    init(api: any WebyarAPI = Backend.current) {
        self.api = api
    }

    func load(appState: AppState) async {
        do {
            prefs = try await api.notificationPrefs()
            loadFailed = false
        } catch APIError.unauthorized {
            await appState.handleUnauthorized()
        } catch {
            loadFailed = true
        }
        isLoading = false
    }

    /// Applies a change optimistically and puts it back if the server
    /// refuses.
    ///
    /// Optimistic because a switch that waits for a round trip before moving
    /// feels broken, and reverting on failure because a switch that stays
    /// where it was put while the server disagrees is a lie about what will
    /// reach this phone tonight.
    func change(appState: AppState, _ edit: (inout NotificationPrefs) -> Void) {
        let previous = prefs
        var next = prefs
        edit(&next)
        guard next != previous else { return }
        prefs = next
        saveFailed = false

        Task {
            isSaving = true
            do {
                prefs = try await api.updateNotificationPrefs(next)
            } catch APIError.unauthorized {
                await appState.handleUnauthorized()
            } catch {
                prefs = previous
                saveFailed = true
                Haptics.warning()
            }
            isSaving = false
        }
    }
}

/// Which notifications reach this operator, and whether this phone can carry
/// them at all.
///
/// Two different questions on one screen, deliberately. "Has iOS given this
/// app permission" is about this device and is answered by the system; "what
/// should be sent" is about the account and is answered by the server, which
/// reads the same row before every send. Showing them apart is what makes it
/// possible to explain the case where the second says yes and the first says
/// no — which is otherwise just an app that does not work.
struct NotificationSettingsView: View {
    @Environment(AppState.self) private var appState
    @Environment(\.scenePhase) private var scenePhase
    @State private var model = NotificationSettingsModel()
    @State private var push = PushController.shared

    private var language: Language { appState.language }

    var body: some View {
        List {
            permissionSection

            if push.isAllowed {
                Section {
                    Toggle(Str.pushMuteAll(language), isOn: Binding(
                        get: { model.prefs.disableAll },
                        set: { value in model.change(appState: appState) { $0.disableAll = value } }
                    ))
                } footer: {
                    Text(Str.pushMuteAllFooter(language))
                }

                if !model.prefs.disableAll {
                    scopeSection
                    contentSection
                    presenceSection
                    quietHoursSection
                }

                deviceSection
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle(Str.notifications(language))
        .navigationBarTitleDisplayMode(.inline)
        .disabled(model.isLoading)
        .task {
            await push.refreshAuthorization()
            await model.load(appState: appState)
        }
        // The operator can grant or revoke permission in iOS Settings while
        // this screen is open, and iOS never tells an app that happened.
        .onChange(of: scenePhase) { _, phase in
            guard phase == .active else { return }
            Task { await push.refreshAuthorization() }
        }
        .overlay(alignment: .top) {
            if model.saveFailed {
                Text(Str.saveFailed(language))
                    .font(.app(.footnote))
                    .foregroundStyle(Theme.Palette.danger)
                    .padding(.horizontal, Theme.Space.md)
                    .padding(.vertical, Theme.Space.sm)
                    .background(
                        Capsule().fill(Theme.Palette.danger.opacity(0.12))
                    )
                    .padding(.top, Theme.Space.sm)
                    .transition(.move(edge: .top).combined(with: .opacity))
            }
        }
        .animation(Theme.Motion.standard, value: model.saveFailed)
        .animation(Theme.Motion.standard, value: model.prefs.disableAll)
        .animation(Theme.Motion.standard, value: push.authorization)
    }

    // MARK: - Permission

    @ViewBuilder
    private var permissionSection: some View {
        if push.isAllowed {
            EmptyView()
        } else {
            Section {
                VStack(alignment: .leading, spacing: Theme.Space.sm) {
                    Text(push.authorization == .denied
                         ? Str.pushDeniedTitle(language)
                         : Str.pushPrimerTitle(language))
                        .font(.app(.headline))
                        .foregroundStyle(Theme.Palette.label)

                    Text(push.authorization == .denied
                         ? Str.pushDeniedBody(language)
                         : Str.pushPrimerBody(language))
                        .font(.app(.footnote))
                        .foregroundStyle(Theme.Palette.labelSecondary)
                        .fixedSize(horizontal: false, vertical: true)

                    // iOS asks once and only once. After a refusal the system
                    // prompt is spent for good, so the button has to lead
                    // somewhere that still works.
                    Button(push.authorization == .denied
                           ? Str.pushOpenSettings(language)
                           : Str.pushTurnOn(language)) {
                        Task {
                            if push.authorization == .denied {
                                push.openSystemSettings()
                            } else {
                                await push.requestAuthorization()
                            }
                        }
                    }
                    .font(.app(.subheadline, weight: .semibold))
                    .frame(minHeight: Theme.Size.minTouchTarget - 8)
                }
                .padding(.vertical, Theme.Space.xs)
            }
        }
    }

    // MARK: - What to send

    private var scopeSection: some View {
        Section {
            ForEach(NotificationPrefs.Scope.allCases) { scope in
                Button {
                    model.change(appState: appState) { $0.pushScope = scope }
                } label: {
                    HStack {
                        Text(title(for: scope))
                            .foregroundStyle(Theme.Palette.label)
                        Spacer(minLength: Theme.Space.sm)
                        if model.prefs.pushScope == scope {
                            Image(systemName: "checkmark")
                                .font(.system(size: 14, weight: .semibold))
                                .foregroundStyle(Theme.Palette.brand)
                        }
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(model.prefs.pushScope == scope ? [.isButton, .isSelected] : .isButton)
            }
        } header: {
            Text(Str.pushScopeTitle(language))
        } footer: {
            Text(Str.pushScopeFooter(language))
        }
    }

    private func title(for scope: NotificationPrefs.Scope) -> String {
        switch scope {
        case .all: Str.pushScopeAll(language)
        case .assigned: Str.pushScopeAssigned(language)
        case .mentions: Str.pushScopeMentions(language)
        case .none: Str.pushScopeNone(language)
        }
    }

    private var contentSection: some View {
        Section {
            Toggle(Str.pushInternalNotes(language), isOn: Binding(
                get: { model.prefs.pushInternalNotes },
                set: { value in model.change(appState: appState) { $0.pushInternalNotes = value } }
            ))

            Toggle(Str.pushShowPreview(language), isOn: Binding(
                get: { model.prefs.pushPreview },
                set: { value in model.change(appState: appState) { $0.pushPreview = value } }
            ))

            Toggle(Str.pushSound(language), isOn: Binding(
                get: { model.prefs.playSound },
                set: { value in model.change(appState: appState) { $0.playSound = value } }
            ))
        } footer: {
            Text(Str.pushShowPreviewFooter(language))
        }
    }

    // MARK: - Where the operator is

    /// The one question this screen asks that the phone cannot answer for
    /// itself: whether the operator is also sitting in front of the web
    /// console right now. The server can see that — it is the same presence
    /// the team list is drawn from — so it is the server that decides, and
    /// these two switches are how the operator tells it what to do with the
    /// answer.
    private var presenceSection: some View {
        Section {
            Toggle(Str.pushWhenOnline(language), isOn: Binding(
                get: { model.prefs.pushWhenOnline },
                set: { value in model.change(appState: appState) { $0.pushWhenOnline = value } }
            ))

            Toggle(Str.pushWhenOffline(language), isOn: Binding(
                get: { model.prefs.pushWhenOffline },
                set: { value in model.change(appState: appState) { $0.pushWhenOffline = value } }
            ))
        } footer: {
            Text(Str.pushPresenceFooter(language))
        }
    }

    // MARK: - Quiet hours

    private var quietHoursSection: some View {
        Section {
            Toggle(Str.pushQuietHours(language), isOn: Binding(
                get: { model.prefs.quietHoursEnabled },
                set: { value in
                    model.change(appState: appState) {
                        $0.quietHoursEnabled = value
                        if value {
                            // A window the operator has not chosen yet still
                            // has to be a window, and the phone is the only
                            // side that knows where it is standing.
                            $0.quietHoursStart = $0.quietHoursStart ?? "22:00"
                            $0.quietHoursEnd = $0.quietHoursEnd ?? "08:00"
                            $0.quietHoursTimezone = TimeZone.current.identifier
                        }
                    }
                }
            ))

            if model.prefs.quietHoursEnabled {
                timeRow(Str.pushQuietFrom(language), value: model.prefs.quietHoursStart ?? "22:00") { text in
                    model.change(appState: appState) { $0.quietHoursStart = text }
                }
                timeRow(Str.pushQuietTo(language), value: model.prefs.quietHoursEnd ?? "08:00") { text in
                    model.change(appState: appState) { $0.quietHoursEnd = text }
                }
            }
        } footer: {
            if model.prefs.quietHoursEnabled {
                Text(Str.pushQuietFooter(language))
            }
        }
    }

    private func timeRow(_ label: String, value: String, onChange: @escaping (String) -> Void) -> some View {
        DatePicker(
            label,
            selection: Binding(
                get: { Self.date(from: value) },
                set: { onChange(Self.text(from: $0)) }
            ),
            displayedComponents: .hourAndMinute
        )
    }

    /// "HH:mm" is the server's own regex, and it is 24-hour whatever the
    /// phone's clock is set to — so the formatter is pinned to a fixed locale
    /// rather than the operator's, which would produce "10:00 PM" on a US
    /// device and be rejected.
    private static let wireFormatter: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = .current
        f.dateFormat = "HH:mm"
        return f
    }()

    private static func date(from text: String) -> Date {
        wireFormatter.date(from: text) ?? wireFormatter.date(from: "22:00") ?? Date()
    }

    private static func text(from date: Date) -> String {
        wireFormatter.string(from: date)
    }

    // MARK: - This device

    private var deviceSection: some View {
        Section {
            HStack {
                Text(Str.pushThisDevice(language))
                    .foregroundStyle(Theme.Palette.label)
                Spacer(minLength: Theme.Space.sm)
                Text(push.isRegistered
                     ? Str.pushDeviceRegistered(language)
                     : Str.pushDeviceNotRegistered(language))
                    .font(.app(.footnote))
                    .foregroundStyle(push.isRegistered
                                     ? Theme.Palette.labelSecondary
                                     : Theme.Palette.warning)
                    .multilineTextAlignment(.trailing)
            }
        } footer: {
            // The one case an operator cannot do anything about, and the one
            // they are most likely to blame the app for.
            if push.platformCanSend == false {
                Text(Str.pushUnavailable(language))
                    .foregroundStyle(Theme.Palette.warning)
            }
        }
    }
}
