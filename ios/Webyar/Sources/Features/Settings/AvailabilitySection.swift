import SwiftUI
import Observation

/// Whether visitors can see this operator, and the two switches that decide
/// it. The third — the weekly schedule — is shown but not edited here: a
/// seven-day grid of time ranges is a web form, and pretending otherwise on a
/// phone would be worse than saying where it lives.
///
/// The live state is never computed here. Invisible mode, the app-usage rule
/// and the schedule combine on the server, and asking it what the answer is
/// keeps one place deciding who is online.
@MainActor
@Observable
final class AvailabilityModel {
    private(set) var prefs: AvailabilityPrefs?
    private(set) var status: AvailabilityStatus?
    private(set) var isSaving = false
    private(set) var failed = false

    private let api: any WebyarAPI

    init(api: any WebyarAPI = Backend.current) {
        self.api = api
    }

    var isOnline: Bool { status?.isOnline == true }

    func load() async {
        guard let response = try? await api.availability() else { return }
        prefs = response.prefs
        status = response.status
    }

    /// One field per request, because each toggle is one decision and a PATCH
    /// carrying all three could quietly put back a value the operator changed
    /// on another device a second ago.
    func set(_ change: AvailabilityUpdate) async {
        guard !isSaving else { return }
        isSaving = true
        failed = false
        defer { isSaving = false }
        do {
            let response = try await api.updateAvailability(change)
            prefs = response.prefs
            status = response.status
        } catch {
            failed = true
            // Put the switch back where the server still has it.
            await load()
        }
    }
}

struct AvailabilitySection: View {
    let language: Language

    @State private var model = AvailabilityModel()

    var body: some View {
        Section {
            if let prefs = model.prefs {
                statusRow

                Toggle(isOn: forceOffline(prefs)) {
                    VStack(alignment: .leading, spacing: 1) {
                        Text(Str.availabilityForceOffline(language))
                        Text(Str.availabilityForceOfflineHint(language))
                            .font(.app(.caption))
                            .foregroundStyle(Theme.Palette.labelSecondary)
                    }
                }

                Toggle(isOn: whenUsingApp(prefs)) {
                    VStack(alignment: .leading, spacing: 1) {
                        Text(Str.availabilityWhenUsingApp(language))
                        Text(Str.availabilityWhenUsingAppHint(language))
                            .font(.app(.caption))
                            .foregroundStyle(Theme.Palette.labelSecondary)
                    }
                }
                .disabled(prefs.forceOffline)

                Toggle(isOn: scheduleEnabled(prefs)) {
                    VStack(alignment: .leading, spacing: 1) {
                        Text(Str.availabilitySchedule(language))
                        Text(Str.availabilityScheduleHint(language))
                            .font(.app(.caption))
                            .foregroundStyle(Theme.Palette.labelSecondary)
                    }
                }
                .disabled(prefs.forceOffline)

                if model.failed {
                    Text(Str.availabilitySaveFailed(language))
                        .font(Theme.Typo.meta)
                        .foregroundStyle(Theme.Palette.danger)
                }
            } else {
                HStack {
                    Text(Str.availability(language))
                    Spacer()
                    ProgressView()
                }
            }
        } header: {
            Text(Str.availability(language))
        }
        .task { await model.load() }
    }

    /// The answer, in the words the console uses, with the dot everyone reads
    /// before the words.
    private var statusRow: some View {
        HStack {
            Text(Str.availabilitySeenAs(language))
                .foregroundStyle(Theme.Palette.labelSecondary)
            Spacer(minLength: Theme.Space.sm)
            HStack(spacing: Theme.Space.xs) {
                Circle()
                    .fill(model.isOnline ? Color.green : Theme.Palette.labelTertiary)
                    .frame(width: 8, height: 8)
                Text(model.isOnline
                     ? Str.availabilityOnline(language)
                     : Str.availabilityOffline(language))
                    .foregroundStyle(Theme.Palette.label)
            }
        }
    }

    // Each toggle writes its own field and nothing else.

    private func forceOffline(_ prefs: AvailabilityPrefs) -> Binding<Bool> {
        Binding(
            get: { prefs.forceOffline },
            set: { value in Task { await model.set(AvailabilityUpdate(force_offline: value)) } }
        )
    }

    private func whenUsingApp(_ prefs: AvailabilityPrefs) -> Binding<Bool> {
        Binding(
            get: { prefs.availableWhenUsingApp },
            set: { value in
                Task { await model.set(AvailabilityUpdate(available_when_using_app: value)) }
            }
        )
    }

    private func scheduleEnabled(_ prefs: AvailabilityPrefs) -> Binding<Bool> {
        Binding(
            get: { prefs.scheduleEnabled },
            set: { value in
                Task { await model.set(AvailabilityUpdate(schedule_enabled: value)) }
            }
        )
    }
}
