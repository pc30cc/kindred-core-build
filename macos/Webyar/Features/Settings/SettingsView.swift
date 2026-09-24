import AppKit
import SwiftUI

/// This Mac's preferences, in the standard Settings window (⌘,). Who gets
/// notified about what is the operator's account setting and lives on the
/// server (edited in the web console); only "show notifications here" and
/// the sound are local — as on the Windows app's settings page, whose
/// sections become the tabs: General, Account, Notifications, Desktop,
/// Updates and Storage.
struct SettingsView: View {
    enum Pane: Hashable { case general, account, notifications, desktop, updates, storage }

    @Environment(AppModel.self) private var app
    @State private var pane: Pane = .general

    var body: some View {
        let s = app.strings
        TabView(selection: $pane) {
            GeneralSettingsTab()
                .tabItem { Label(s["settingsGeneral"], systemImage: "gearshape") }
                .tag(Pane.general)
            // Who is signed in only exists while someone is.
            if app.phase == .signedIn {
                AccountSettingsTab()
                    .tabItem { Label(s["settingsAccount"], systemImage: "person.crop.circle") }
                    .tag(Pane.account)
            }
            NotificationSettingsTab()
                .tabItem { Label(s["notifications"], systemImage: "bell.badge") }
                .tag(Pane.notifications)
            DesktopSettingsTab()
                .tabItem { Label(s["desktop"], systemImage: "macwindow") }
                .tag(Pane.desktop)
            UpdateSettingsTab()
                .tabItem { Label(s["updates"], systemImage: "arrow.triangle.2.circlepath") }
                .tag(Pane.updates)
            StorageSettingsTab()
                .tabItem { Label(s["settingsStorage"], systemImage: "internaldrive") }
                .tag(Pane.storage)
        }
        .frame(width: 620)
        // The window is rebuilt in the new language and direction at once.
        .environment(\.layoutDirection, s.isRightToLeft ? .rightToLeft : .leftToRight)
        .environment(\.locale, s.language.locale)
        .onChange(of: app.phase) { _, phase in
            if phase != .signedIn && pane == .account { pane = .general }
        }
    }
}

// MARK: - Shared pieces

/// A setting's icon, title and the line under it — the Windows SettingsCard's header and description.
struct SettingLabel: View {
    var title: String
    var hint: String? = nil
    var systemImage: String

    var body: some View {
        Label {
            VStack(alignment: .leading, spacing: 2) {
                Text(title).appFont(13)
                if let hint, !hint.isEmpty {
                    Text(hint)
                        .appFont(11.5)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        } icon: {
            Image(systemName: systemImage).foregroundStyle(Palette.brand)
        }
    }
}

/// A section title over a group of settings.
struct SettingsHeader: View {
    var text: String
    init(_ text: String) { self.text = text }
    var body: some View { Text(text).appFont(13, .semibold) }
}

extension View {
    /// One tab's grouped form, a fixed height tall enough for its rows; anything longer scrolls.
    func settingsForm(height: CGFloat) -> some View {
        formStyle(.grouped)
            .scrollBounceBehavior(.basedOnSize)
            .frame(height: height)
    }
}

// MARK: - General

/// Language and appearance.
struct GeneralSettingsTab: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        Form {
            Section {
                languagePicker
                appearancePicker
            } header: {
                SettingsHeader(app.strings["general"])
            }
        }
        .settingsForm(height: 200)
    }

    private var languageBinding: Binding<Language> {
        Binding<Language>(
            get: { app.strings.language },
            set: { language in
                // The whole app, this window included, redraws in the new language.
                if language != app.strings.language { app.setLanguage(language) }
            })
    }

    private var languagePicker: some View {
        Picker(selection: languageBinding) {
            ForEach(Language.allCases) { language in
                Text(language.nativeName).tag(language)
            }
        } label: {
            SettingLabel(title: app.strings["language"], systemImage: "globe")
        }
    }

    private var appearanceBinding: Binding<Appearance> {
        Binding<Appearance>(
            get: { app.settings.appearance },
            set: { appearance in app.setAppearance(appearance) })
    }

    private var appearancePicker: some View {
        Picker(selection: appearanceBinding) {
            ForEach(Appearance.allCases, id: \.self) { appearance in
                Text(appearanceName(appearance)).tag(appearance)
            }
        } label: {
            SettingLabel(title: app.strings["appearance"], hint: app.strings["appearanceHint"], systemImage: "circle.lefthalf.filled")
        }
    }

    private func appearanceName(_ appearance: Appearance) -> String {
        switch appearance {
        case .system: return app.strings["appearanceSystem"]
        case .light: return app.strings["appearanceLight"]
        case .dark: return app.strings["appearanceDark"]
        }
    }
}
