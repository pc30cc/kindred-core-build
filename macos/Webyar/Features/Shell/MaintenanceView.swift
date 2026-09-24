import AppKit
import SwiftUI

/// Super Admin's maintenance notice, over the whole window — the shell and
/// the sign-in page alike — while the platform says it is down: what is
/// going on in the operator's language, until when, the status page, and a
/// way to ask again at once. Nothing beneath takes a click meanwhile.
struct MaintenanceOverlay: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        let s = app.strings
        let maintenance = app.config.maintenance
        ZStack {
            // The app stays in view, blurred, so it is plain it will be back as it was.
            Rectangle().fill(.ultraThinMaterial)
            Palette.appBackground.opacity(0.25)
            VStack(spacing: 14) {
                Image(systemName: "wrench.and.screwdriver.fill")
                    .font(.system(size: 28, weight: .medium))
                    .foregroundStyle(Palette.warning)
                    .frame(width: 68, height: 68)
                    .background(Palette.warning.opacity(0.14), in: RoundedRectangle(cornerRadius: 20, style: .continuous))
                Text(s["maintenanceTitle"])
                    .appFont(20, .semibold)
                    .multilineTextAlignment(.center)
                Text(maintenance.message(in: s.language) ?? s["maintenanceBody"])
                    .appFont(13.5)
                    .foregroundStyle(Palette.text2)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
                if let until = maintenance.until {
                    Label(s.get("maintenanceUntil", "time", Self.when(until, s)), systemImage: "clock")
                        .appFont(12.5, .semibold)
                        .foregroundStyle(Palette.warning)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 5)
                        .background(Palette.warningSoft, in: Capsule())
                }
                buttons
                    .padding(.top, 6)
            }
            .padding(.horizontal, 32)
            .padding(.vertical, 28)
            .frame(width: 460)
            .glassCard(26, tint: Palette.warning.opacity(0.06))
            .shadow(color: .black.opacity(0.18), radius: 30, y: 12)
        }
        .ignoresSafeArea()
        // Every click lands here, never on the app beneath.
        .contentShape(Rectangle())
        .onTapGesture {}
        .accessibilityElement(children: .contain)
        .accessibilityAddTraits(.isModal)
    }

    private var buttons: some View {
        let s = app.strings
        return GlassGroup(spacing: 8) {
            HStack(spacing: 8) {
                Button(s["quitApp"]) { NSApp.terminate(nil) }
                    .glassButton()
                Spacer(minLength: 8)
                if let status = app.config.links.status {
                    Button {
                        NSWorkspace.shared.openHttps(status)
                    } label: {
                        Label(s["helpStatus"], systemImage: "arrow.up.forward")
                    }
                    .glassButton()
                }
                Button {
                    Task { await app.refreshPlatform() }
                } label: {
                    HStack(spacing: 6) {
                        if app.checkingPlatform { ProgressView().controlSize(.small).tint(.white) }
                        Text(s["retry"])
                    }
                }
                .prominentButton()
                .keyboardShortcut(.defaultAction)
                .disabled(app.checkingPlatform)
            }
            .controlSize(.large)
        }
    }

    /// The time alone when it is today, the date and time otherwise — Persian calendar and digits in Persian.
    static func when(_ date: Date, _ s: Strings) -> String {
        Calendar.current.isDateInToday(date) ? Display.clockTime(date, s.language) : Display.dateTime(date, s)
    }
}
