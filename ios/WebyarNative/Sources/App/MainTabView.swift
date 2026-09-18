import SwiftUI

/// The signed-in shell.
///
/// A plain `TabView` with `NavigationStack` per tab is used rather than
/// anything custom: it gives real UIKit tab-bar behaviour — the translucent
/// blur over scrolled content, tap-to-pop-to-root, correct safe-area insets
/// and RTL mirroring — none of which is worth reimplementing.
struct MainTabView: View {
    @Environment(AppState.self) private var appState
    @State private var selection: Tab = .inbox

    enum Tab: Hashable { case inbox, contacts, settings }

    private var language: Language { appState.language }

    var body: some View {
        TabView(selection: $selection) {
            NavigationStack {
                InboxView()
            }
            .tabItem {
                Label(Str.tabInbox(language), systemImage: "tray.full")
            }
            .tag(Tab.inbox)

            NavigationStack {
                ContactsView()
            }
            .tabItem {
                Label(Str.tabContacts(language), systemImage: "person.2")
            }
            .tag(Tab.contacts)

            NavigationStack {
                SettingsView()
            }
            .tabItem {
                Label(Str.tabSettings(language), systemImage: "gearshape")
            }
            .tag(Tab.settings)
        }
    }
}
