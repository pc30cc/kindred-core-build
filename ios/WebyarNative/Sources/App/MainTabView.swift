import SwiftUI

/// The signed-in shell.
///
/// `TabView` still does the work — it owns each tab's navigation stack, its
/// state and the switch between them — but its own bar is hidden and replaced
/// by a floating capsule. Keeping the real `TabView` underneath means tab
/// state, deep links and the system's own restoration keep behaving normally;
/// only the chrome is ours.
struct MainTabView: View {
    @Environment(AppState.self) private var appState
    @State private var selection: Tab
    @State private var inboxPath = NavigationPath()
    @State private var contactsPath = NavigationPath()

    enum Tab: Hashable { case inbox, contacts, settings }

    init() {
        _selection = State(initialValue: Self.initialTab)
    }

    /// A real launch always opens Inbox. In Debug, a screenshot run may name
    /// a different starting tab.
    private static var initialTab: Tab {
        #if DEBUG
        switch SampleRoute.current {
        case .contacts, .contact: .contacts
        case .settings: .settings
        case .inbox, .chat, .none: .inbox
        }
        #else
        .inbox
        #endif
    }

    private var language: Language { appState.language }

    /// Whether the floating bar should be on screen.
    ///
    /// A pushed detail screen — a transcript, a contact — is a full-screen
    /// task, so the bar goes away rather than hovering over the composer.
    private var showsTabBar: Bool {
        switch selection {
        case .inbox: inboxPath.isEmpty
        case .contacts: contactsPath.isEmpty
        case .settings: true
        }
    }

    private var items: [FloatingTabBar<Tab>.Item] {
        [
            .init(tab: .inbox, title: Str.tabInbox(language),
                  icon: "tray", selectedIcon: "tray.fill"),
            .init(tab: .contacts, title: Str.tabContacts(language),
                  icon: "person.2", selectedIcon: "person.2.fill"),
            .init(tab: .settings, title: Str.tabSettings(language),
                  icon: "gearshape", selectedIcon: "gearshape.fill"),
        ]
    }

    var body: some View {
        // The default tab style, not `.page`. Page style would also let a
        // horizontal swipe anywhere on a screen flick between Inbox and
        // Settings, which is not something an operator ever means to do — and
        // it conflicts outright with the swipe-to-resolve action on a row.
        // Hiding the bar per tab is what removes the system chrome.
        TabView(selection: $selection) {
            NavigationStack(path: $inboxPath) {
                InboxView()
            }
            .toolbar(.hidden, for: .tabBar)
            .tag(Tab.inbox)

            NavigationStack(path: $contactsPath) {
                ContactsView()
            }
            .toolbar(.hidden, for: .tabBar)
            .tag(Tab.contacts)

            NavigationStack {
                SettingsView()
            }
            .toolbar(.hidden, for: .tabBar)
            .tag(Tab.settings)
        }
        .overlay(alignment: .bottom) {
            if showsTabBar {
                FloatingTabBar(selection: $selection, items: items)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
        .animation(Theme.Motion.standard, value: showsTabBar)
        // Keyed on the workspace: session restore is still in flight when the
        // tab view first appears, so an unkeyed task would run before there is
        // a workspace to fetch anything from and silently do nothing.
        .task(id: appState.selectedWorkspace?.id) {
            await pushSampleDetailIfRequested()
        }
    }

    /// Opens a detail screen on launch when sample mode asked for one, so a
    /// screenshot run can capture the chat and contact screens too. Compiled
    /// out of Release entirely.
    private func pushSampleDetailIfRequested() async {
        #if DEBUG
        guard let workspace = appState.selectedWorkspace else { return }

        switch SampleRoute.current {
        case .chat:
            guard inboxPath.isEmpty,
                  let conversation = try? await Backend.current
                      .conversations(workspaceID: workspace.id, filter: .open)
                      .first
            else { return }
            inboxPath.append(conversation)

        case .contact:
            guard contactsPath.isEmpty,
                  let contact = try? await Backend.current.contacts(workspaceID: workspace.id).first
            else { return }
            contactsPath.append(contact)

        case .inbox, .contacts, .settings, .none:
            break
        }
        #endif
    }
}

/// Reserves room at the bottom of a scrollable screen for the floating bar,
/// so the last row can always be scrolled clear of it.
struct FloatingTabBarInset: ViewModifier {
    func body(content: Content) -> some View {
        content.safeAreaInset(edge: .bottom, spacing: 0) {
            Color.clear.frame(height: Theme.Size.floatingBarClearance)
        }
    }
}

extension View {
    /// Apply to any screen that scrolls under the floating tab bar.
    func floatingTabBarInset() -> some View {
        modifier(FloatingTabBarInset())
    }
}
