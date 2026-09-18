import SwiftUI

/// The signed-in shell.
///
/// Which tabs exist is decided by the plan, not by this file. `TabView` still
/// owns each tab's navigation stack and state; only the chrome is ours, and
/// only the membership is the plan's.
struct MainTabView: View {
    @Environment(AppState.self) private var appState
    @State private var selection: Tab = .inbox
    @State private var inboxPath = NavigationPath()
    @State private var contactsPath = NavigationPath()
    @State private var callsPath = NavigationPath()
    @State private var settingsPath = NavigationPath()

    enum Tab: Hashable { case inbox, calls, contacts, settings }

    private var language: Language { appState.language }

    /// The tabs this account actually has.
    ///
    /// Inbox and Settings are core and always present. Calls and Contacts are
    /// plan-gated, and while the plan is still resolving neither is rendered —
    /// a tab that appears and then vanishes reads as a bug.
    private var tabs: [Tab] {
        var tabs: [Tab] = [.inbox]
        if appState.planResolved {
            if appState.callCenterVisible { tabs.append(.calls) }
            if appState.contactsVisible { tabs.append(.contacts) }
        }
        tabs.append(.settings)
        return tabs
    }

    private var items: [FloatingTabBar<Tab>.Item] {
        tabs.map { tab in
            switch tab {
            case .inbox:
                .init(tab: .inbox, title: Str.tabInbox(language),
                      icon: "tray", selectedIcon: "tray.fill")
            case .calls:
                .init(tab: .calls, title: Str.tabCalls(language),
                      icon: "phone", selectedIcon: "phone.fill")
            case .contacts:
                .init(tab: .contacts, title: Str.tabContacts(language),
                      icon: "person.2", selectedIcon: "person.2.fill")
            case .settings:
                .init(tab: .settings, title: Str.tabSettings(language),
                      icon: "gearshape", selectedIcon: "gearshape.fill")
            }
        }
    }

    /// A pushed detail screen is a full-screen task, so the bar goes away
    /// rather than hovering over a composer.
    private var showsTabBar: Bool {
        switch selection {
        case .inbox: inboxPath.isEmpty
        case .contacts: contactsPath.isEmpty
        case .calls: callsPath.isEmpty
        case .settings: settingsPath.isEmpty
        }
    }

    var body: some View {
        TabView(selection: $selection) {
            NavigationStack(path: $inboxPath) {
                InboxView()
            }
            .toolbar(.hidden, for: .tabBar)
            .tag(Tab.inbox)

            if appState.callCenterVisible {
                NavigationStack(path: $callsPath) {
                    CallCenterView()
                }
                .toolbar(.hidden, for: .tabBar)
                .tag(Tab.calls)
            }

            if appState.contactsVisible {
                NavigationStack(path: $contactsPath) {
                    ContactsView()
                }
                .toolbar(.hidden, for: .tabBar)
                .tag(Tab.contacts)
            }

            NavigationStack(path: $settingsPath) {
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
        .animation(Theme.Motion.standard, value: tabs)
        // A plan change can remove the tab that is currently open — switching
        // workspace is the ordinary way that happens. Without this the shell
        // would be left showing a tab that no longer exists.
        .onChange(of: tabs) { _, newTabs in
            if !newTabs.contains(selection) { selection = .inbox }
        }
        .task(id: appState.selectedWorkspace?.id) {
            await openRequestedScreen()
        }
    }

    /// Opens a detail screen on launch when a Debug run asked for one, so a
    /// screenshot pass can capture the chat and contact screens too. Compiled
    /// out of Release entirely.
    private func openRequestedScreen() async {
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
            guard contactsPath.isEmpty, appState.contactsVisible,
                  let contact = try? await Backend.current.contacts(workspaceID: workspace.id).first
            else { return }
            selection = .contacts
            contactsPath.append(contact)

        case .contacts:
            if appState.contactsVisible { selection = .contacts }

        case .calls:
            if appState.callCenterVisible { selection = .calls }

        case .settings:
            selection = .settings

        case .profile, .security:
            // Both live behind Settings, so the tab has to be selected before
            // the destination is pushed onto its stack.
            selection = .settings
            guard settingsPath.isEmpty else { return }
            settingsPath.append(SampleRoute.current == .profile ? SettingsRoute.profile : .security)

        case .inbox, .none:
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
