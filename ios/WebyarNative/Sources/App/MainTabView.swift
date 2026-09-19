import SwiftUI

/// The signed-in shell.
///
/// Which tabs exist is decided by the plan, not by this file. `TabView` still
/// owns each tab's navigation stack and state; only the chrome is ours, and
/// only the membership is the plan's.
struct MainTabView: View {
    @Environment(AppState.self) private var appState
    /// What `TabView` is showing.
    @State private var selection: Tab = .inbox
    /// What the operator actually asked for.
    ///
    /// The two come apart because `TabView` re-seats its own selection when
    /// its children change, and the children change the moment the plan
    /// resolves — several seconds after launch on a cold network. Without
    /// this the app quietly lands on Contacts or Settings while the operator is
    /// looking at the inbox.
    @State private var intent: Tab = .inbox
    @State private var inboxPath = NavigationPath()
    @State private var contactsPath = NavigationPath()
    @State private var settingsPath = NavigationPath()

    enum Tab: Hashable { case inbox, contacts, settings }

    private var language: Language { appState.language }

    /// The tabs this account actually has.
    ///
    /// Inbox and Settings are core and always present. Contacts is
    /// plan-gated, and while the plan is still resolving it is not rendered —
    /// a tab that appears and then vanishes reads as a bug.
    private var tabs: [Tab] {
        var tabs: [Tab] = [.inbox]
        if appState.planResolved, appState.contactsVisible { tabs.append(.contacts) }
        tabs.append(.settings)
        return tabs
    }

    private var items: [FloatingTabBar<Tab>.Item] {
        tabs.map { tab in
            switch tab {
            case .inbox:
                .init(tab: .inbox, title: Str.tabInbox(language),
                      icon: "tray", selectedIcon: "tray.fill")
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
        case .settings: settingsPath.isEmpty
        }
    }

    /// The bar writes the operator's choice; `TabView` only ever reads it.
    private var chosen: Binding<Tab> {
        Binding(
            get: { selection },
            set: { tab in
                intent = tab
                selection = tab
            }
        )
    }

    var body: some View {
        TabView(selection: $selection) {
            NavigationStack(path: $inboxPath) {
                InboxView()
            }
            .toolbar(.hidden, for: .tabBar)
            .tag(Tab.inbox)

            // The plan-gated tab is always *here* and only sometimes has
            // anything in it. Adding and removing `TabView` children is what
            // makes it re-seat its own selection, and the plan resolves a few
            // seconds after launch — long enough for the operator to be
            // reading the inbox when the app slides out from under them.
            // Keeping the children fixed and their contents conditional costs
            // nothing: an empty stack is never reachable, because the bar only
            // lists the tabs the plan grants.
            NavigationStack(path: $contactsPath) {
                if appState.contactsVisible {
                    ContactsView()
                }
            }
            .toolbar(.hidden, for: .tabBar)
            .tag(Tab.contacts)

            NavigationStack(path: $settingsPath) {
                SettingsView()
            }
            .toolbar(.hidden, for: .tabBar)
            .tag(Tab.settings)
        }
        .overlay(alignment: .bottom) {
            if showsTabBar {
                FloatingTabBar(selection: chosen, items: items)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
        .animation(Theme.Motion.standard, value: showsTabBar)
        .animation(Theme.Motion.standard, value: tabs)
        // A plan change can remove the tab that is currently open — switching
        // workspace is the ordinary way that happens. Without this the shell
        // would be left showing a tab that no longer exists.
        .onChange(of: tabs) { _, newTabs in
            if !newTabs.contains(intent) { intent = .inbox }
            if selection != intent { selection = intent }
        }
        // And this is the other half: adding a tab moves `TabView`'s own
        // selection even when the current one is still there, so put the
        // operator back where they were.
        .onChange(of: selection) { _, now in
            guard now != intent, tabs.contains(intent) else { return }
            selection = intent
        }
        .task(id: appState.selectedWorkspace?.id) {
            await openRequestedScreen()
        }
    }

    private func select(_ tab: Tab) {
        intent = tab
        selection = tab
    }

    /// Opens a detail screen on launch when a Debug run asked for one, so a
    /// screenshot pass can capture the chat and contact screens too. Compiled
    /// out of Release entirely.
    private func openRequestedScreen() async {
        #if DEBUG
        guard let workspace = appState.selectedWorkspace else { return }

        // The plan decides whether Contacts exists at all, and it resolves a
        // beat after the workspace does. Without waiting, a Debug run that
        // asks for Contacts silently lands on the inbox instead — which looks
        // like the tab is broken rather than like the route was early.
        for _ in 0..<40 where !appState.planResolved {
            try? await Task.sleep(for: .milliseconds(100))
        }

        switch SampleRoute.current {
        case .chat, .aiChat, .call, .videoCall:
            guard inboxPath.isEmpty,
                  let all = try? await Backend.current
                      .conversations(workspaceID: workspace.id, filter: .open)
            else { return }
            // `aiChat` picks a thread the AI still owns, so the composer's
            // AI state can be screenshotted too.
            let wanted = SampleRoute.current == .aiChat
                ? all.first { AIState.resolve($0) == .aiManaged }
                : all.first
            guard let conversation = wanted else { return }
            inboxPath.append(conversation)

        case .contact:
            guard contactsPath.isEmpty, appState.contactsVisible,
                  let contact = try? await Backend.current.contacts(workspaceID: workspace.id).first
            else { return }
            select(.contacts)
            contactsPath.append(contact)

        case .contacts:
            if appState.contactsVisible { select(.contacts) }

        case .settings:
            select(.settings)

        case .profile, .security:
            // Both live behind Settings, so the tab has to be selected before
            // the destination is pushed onto its stack.
            select(.settings)
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
