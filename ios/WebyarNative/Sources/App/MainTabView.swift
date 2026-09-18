import SwiftUI

/// The signed-in shell.
///
/// A plain `TabView` with `NavigationStack` per tab is used rather than
/// anything custom: it gives real UIKit tab-bar behaviour — the translucent
/// blur over scrolled content, tap-to-pop-to-root, correct safe-area insets
/// and RTL mirroring — none of which is worth reimplementing.
struct MainTabView: View {
    @Environment(AppState.self) private var appState
    @State private var selection: Tab
    @State private var inboxPath = NavigationPath()
    @State private var contactsPath = NavigationPath()

    enum Tab: Hashable { case inbox, contacts, settings }

    init() {
        _selection = State(initialValue: Self.initialTab)
    }

    /// Sample mode may name a starting tab; a real launch always opens Inbox.
    private static var initialTab: Tab {
        switch SampleRoute.current {
        case .contacts, .contact: .contacts
        case .settings: .settings
        case .inbox, .chat, .none: .inbox
        }
    }

    private var language: Language { appState.language }

    var body: some View {
        TabView(selection: $selection) {
            NavigationStack(path: $inboxPath) {
                InboxView()
            }
            .tabItem {
                Label(Str.tabInbox(language), systemImage: "tray.full")
            }
            .tag(Tab.inbox)

            NavigationStack(path: $contactsPath) {
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
        .task {
            await pushSampleDetailIfRequested()
        }
    }

    /// Opens a detail screen on launch when sample mode asked for one, so a
    /// screenshot run can capture the chat and contact screens too.
    private func pushSampleDetailIfRequested() async {
        switch SampleRoute.current {
        case .chat:
            guard let workspace = appState.selectedWorkspace,
                  let conversation = try? await Backend.current
                      .conversations(workspaceID: workspace.id, filter: .open)
                      .first
            else { return }
            inboxPath.append(conversation)

        case .contact:
            guard let workspace = appState.selectedWorkspace,
                  let contact = try? await Backend.current.contacts(workspaceID: workspace.id).first
            else { return }
            contactsPath.append(contact)

        case .inbox, .contacts, .settings, .none:
            break
        }
    }
}
