import SwiftUI
import MapKit

/// Where a visitor's page is pushed from the list or the map.
enum VisitorsRoute: Hashable {
    /// By session id: the page reads the visitor from the live list, so it
    /// keeps up with them while it is open.
    case visitor(String)
}

/// Keeps the list — and, on the map, the markers — fresh while the operator
/// is looking, and not a moment longer.
///
/// "Looking" is the Visitors tab being the one on screen *and* the app being
/// in front: `SyncCoordinator.isForeground` is the same rule the realtime
/// socket keeps, so the phone never polls from the background. Both are in
/// the task's id, so SwiftUI cancels the loop the instant either changes.
///
/// Applied to the list and to a visitor's page alike. A `.task` stops when
/// its view is covered by a pushed screen, and a visitor's page is exactly
/// where a live status is most wanted.
private struct VisitorsPolling: ViewModifier {
    let model: VisitorsViewModel
    let isSelectedTab: Bool
    var includesMap = false

    @Environment(AppState.self) private var appState
    @State private var sync = SyncCoordinator.shared

    private var workspaceID: String? { appState.selectedWorkspace?.id }
    private var isLive: Bool { isSelectedTab && sync.isForeground && workspaceID != nil }

    func body(content: Content) -> some View {
        content
            .task(id: "\(workspaceID ?? "-")|\(isLive)") {
                guard isLive, let workspaceID else { return }
                await model.poll(workspaceID: workspaceID, appState: appState)
            }
            .task(id: "\(workspaceID ?? "-")|\(isLive && includesMap)") {
                guard isLive, includesMap, let workspaceID else { return }
                await model.pollMap(workspaceID: workspaceID, appState: appState)
            }
    }
}

extension View {
    fileprivate func pollingVisitors(_ model: VisitorsViewModel, isSelectedTab: Bool, includesMap: Bool = false) -> some View {
        modifier(VisitorsPolling(model: model, isSelectedTab: isSelectedTab, includesMap: includesMap))
    }
}

/// The Online Visitors tab: who is on the site now, as a list or on a map.
struct VisitorsView: View {
    @Binding var path: NavigationPath
    /// Whether this tab is the one on screen. Polling runs only while it is.
    let isSelectedTab: Bool

    @Environment(AppState.self) private var appState
    @State private var model = VisitorsViewModel()
    @State private var mode: Mode = .list
    @State private var isSearching = false

    private enum Mode: Hashable { case list, map }

    private var language: Language { appState.language }
    private var workspaceID: String? { appState.selectedWorkspace?.id }

    var body: some View {
        Group {
            switch mode {
            case .list: list
            case .map: VisitorsMapView(model: model) { id in path.append(VisitorsRoute.visitor(id)) }
            }
        }
        .navigationTitle(Str.visitorsTitle(language))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { toolbar }
        .pollingVisitors(model, isSelectedTab: isSelectedTab, includesMap: mode == .map)
        .navigationDestination(for: VisitorsRoute.self) { route in
            switch route {
            case .visitor(let id):
                VisitorDetailView(sessionID: id, model: model)
                    .pollingVisitors(model, isSelectedTab: isSelectedTab)
            }
        }
        .onChange(of: workspaceID) { _, new in
            model.use(workspaceID: new)
            isSearching = false
        }
    }

    // MARK: - Toolbar

    @ToolbarContentBuilder
    private var toolbar: some ToolbarContent {
        // The switch sits where the title would, as Find My and Maps put
        // theirs; the title still names the screen to VoiceOver and to the
        // back button of a visitor's page.
        ToolbarItem(placement: .principal) {
            Picker(Str.visitorsTitle(language), selection: $mode.animation(Theme.Motion.standard)) {
                Text(Str.visitorsList(language)).tag(Mode.list)
                Text(Str.visitorsMap(language)).tag(Mode.map)
            }
            .pickerStyle(.segmented)
            .fixedSize()
        }
        ToolbarItemGroup(placement: .topBarTrailing) {
            filterMenu
            if mode == .list {
                Button {
                    isSearching.toggle()
                } label: {
                    Image(systemName: "magnifyingglass")
                }
                .accessibilityLabel(Str.search(language))
            }
        }
    }

    private var filterMenu: some View {
        @Bindable var model = model
        return Menu {
            Toggle(isOn: $model.onlineOnly) {
                Label(Str.visitorsFilterOnline(language), systemImage: "circle.fill")
            }
            Toggle(isOn: $model.chatOnly) {
                Label(Str.visitorsFilterInChat(language), systemImage: "bubble.left.and.bubble.right")
            }
            Picker(selection: $model.country) {
                Text(Str.visitorsAllCountries(language)).tag(String?.none)
                ForEach(model.countries) { country in
                    Text(countryLabel(country)).tag(String?.some(country.code))
                }
            } label: {
                Label(Str.visitorsFilterCountry(language), systemImage: "flag")
            }
            .pickerStyle(.menu)

            Divider()

            Toggle(isOn: includeOffline) {
                Label(Str.visitorsIncludeOffline(language), systemImage: "moon.zzz")
            }

            if model.isFiltered {
                Divider()
                Button(role: .destructive) {
                    withAnimation(Theme.Motion.standard) { model.clearFilters() }
                } label: {
                    Label(Str.visitorsClearFilters(language), systemImage: "xmark.circle")
                }
            }
        } label: {
            Image(systemName: model.isFiltered
                  ? "line.3.horizontal.decrease.circle.fill"
                  : "line.3.horizontal.decrease.circle")
        }
        .accessibilityLabel(Str.visitorsFilters(language))
    }

    /// Asks again as soon as it is flipped, rather than on the next tick.
    private var includeOffline: Binding<Bool> {
        Binding(
            get: { model.includeOffline },
            set: { on in
                Task { await model.setIncludeOffline(on, workspaceID: workspaceID, appState: appState) }
            }
        )
    }

    private func countryLabel(_ country: VisitorCountry) -> String {
        let name = Locale(identifier: language.locale.identifier).localizedString(forRegionCode: country.code) ?? country.name
        guard let flag = VisitorText.flag(country.code) else { return name }
        return "\(flag) \(name)"
    }

    // MARK: - List

    private var list: some View {
        @Bindable var model = model
        let rows = model.visible { VisitorFormat.name($0, language: language) }

        return SearchableList(
            text: $model.search,
            prompt: Str.visitorsSearchPrompt(language),
            resetToken: workspaceID ?? "-",
            isSearching: $isSearching
        ) {
            switch model.phase {
            case .loading:
                ForEach(0..<8, id: \.self) { _ in
                    ContactRowSkeleton()
                }

            case .failed:
                ErrorStateView(
                    title: Str.visitorsErrorTitle(language),
                    message: Str.offlineBody(language),
                    retryTitle: Str.retry(language),
                    onRetry: { Task { await reload() } }
                )
                .listRowInsets(EdgeInsets())
                .listRowSeparator(.hidden)

            case .loaded:
                VisitorStatsStrip(model: model, language: language)
                    .listRowInsets(EdgeInsets(
                        top: Theme.Space.sm, leading: Theme.screenInset,
                        bottom: Theme.Space.md, trailing: Theme.screenInset
                    ))
                    .listRowSeparator(.hidden)

                if model.isFiltered {
                    ActiveVisitorFilters(model: model, language: language, countryLabel: countryLabel)
                        .listRowInsets(EdgeInsets(
                            top: 0, leading: Theme.screenInset, bottom: Theme.Space.sm, trailing: Theme.screenInset
                        ))
                        .listRowSeparator(.hidden)
                }

                if rows.isEmpty {
                    emptyState
                        .listRowInsets(EdgeInsets())
                        .listRowSeparator(.hidden)
                } else {
                    ForEach(rows) { visitor in
                        NavigationLink(value: VisitorsRoute.visitor(visitor.id)) {
                            VisitorRow(visitor: visitor, now: model.now, language: language)
                        }
                    }
                }
            }
        }
        .animation(Theme.Motion.standard, value: rows.map(\.id))
        .floatingTabBarInset()
        .refreshable { await reload() }
    }

    @ViewBuilder
    private var emptyState: some View {
        if model.visitors.isEmpty {
            EmptyStateView(
                systemImage: "globe.americas",
                title: Str.visitorsEmptyTitle(language),
                message: Str.visitorsEmptyBody(language)
            )
        } else {
            VStack(spacing: 0) {
                EmptyStateView(systemImage: "magnifyingglass", title: Str.visitorsNoResults(language), message: "")
                if model.isFiltered {
                    Button(Str.visitorsClearFilters(language)) {
                        withAnimation(Theme.Motion.standard) { model.clearFilters() }
                    }
                    .buttonStyle(.bordered)
                    .buttonBorderShape(.capsule)
                    .padding(.bottom, Theme.Space.xl)
                }
            }
        }
    }

    private func reload() async {
        guard let workspaceID else { return }
        await model.refresh(workspaceID: workspaceID, appState: appState)
    }
}

// MARK: - The numbers

/// Online, active now, countries and pages — the four figures the web page
/// leads with. Four across when they fit, two by two when the text is large.
struct VisitorStatsStrip: View {
    let model: VisitorsViewModel
    let language: Language

    var body: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: Theme.Space.sm) { tiles }
            Grid(horizontalSpacing: Theme.Space.sm, verticalSpacing: Theme.Space.sm) {
                GridRow { online; active }
                GridRow { countries; pages }
            }
        }
    }

    @ViewBuilder private var tiles: some View {
        online
        active
        countries
        pages
    }

    private var online: some View {
        VisitorStatTile(label: Str.visitorsStatOnline(language), value: model.onlineCount,
                        language: language, tint: Theme.Palette.success, showsPulse: true)
    }
    private var active: some View {
        VisitorStatTile(label: Str.visitorsStatActive(language), value: model.activeCount, language: language)
    }
    private var countries: some View {
        VisitorStatTile(label: Str.visitorsStatCountries(language), value: model.countryCount, language: language)
    }
    private var pages: some View {
        VisitorStatTile(label: Str.visitorsStatPages(language), value: model.pageCount, language: language)
    }
}

private struct VisitorStatTile: View {
    let label: String
    let value: Int
    let language: Language
    var tint: Color = Theme.Palette.label
    var showsPulse = false

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Space.xxs) {
            HStack(spacing: Theme.Space.xs) {
                if showsPulse {
                    Circle().fill(tint).frame(width: 7, height: 7)
                        .accessibilityHidden(true)
                }
                Text(label)
                    .font(Theme.Typo.meta)
                    .foregroundStyle(Theme.Palette.labelSecondary)
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
            }
            Text(Format.number(value, language: language))
                .font(.title2.weight(.bold))
                .monospacedDigit()
                .foregroundStyle(tint)
                .contentTransition(.numericText())
                .animation(Theme.Motion.standard, value: value)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, Theme.Space.md)
        .padding(.vertical, Theme.Space.sm)
        .background(
            RoundedRectangle(cornerRadius: Theme.Radius.md, style: .continuous)
                .fill(Theme.Palette.surface)
        )
        .accessibilityElement(children: .combine)
    }
}

/// The filters in force, each with its own way out, so a short list is never
/// a mystery.
private struct ActiveVisitorFilters: View {
    let model: VisitorsViewModel
    let language: Language
    let countryLabel: (VisitorCountry) -> String

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: Theme.Space.xs) {
                if model.onlineOnly {
                    chip(Str.visitorsFilterOnline(language)) { model.onlineOnly = false }
                }
                if model.chatOnly {
                    chip(Str.visitorsFilterInChat(language)) { model.chatOnly = false }
                }
                if let code = model.country {
                    let name = model.countries.first { $0.code == code }.map(countryLabel) ?? code
                    chip(name) { model.country = nil }
                }
            }
        }
    }

    private func chip(_ title: String, remove: @escaping () -> Void) -> some View {
        Button {
            withAnimation(Theme.Motion.standard) { remove() }
        } label: {
            HStack(spacing: Theme.Space.xs) {
                Text(title).lineLimit(1)
                Image(systemName: "xmark")
                    .font(.caption2.weight(.bold))
            }
            .font(Theme.Typo.metaEmphasis)
            .foregroundStyle(Theme.Palette.brand)
            .padding(.horizontal, Theme.Space.md)
            .frame(minHeight: 30)
            .background(Capsule().fill(Theme.Palette.brand.opacity(0.12)))
        }
        .buttonStyle(.plain)
        .accessibilityHint(Str.visitorsClearFilters(language))
    }
}

// MARK: - A row

/// A visitor in the list: the same avatar as everywhere else (their OS on its
/// brand colour, their flag), a presence dot, their name, "In chat" when they
/// are in one, where and how long ago, and the page they are on.
struct VisitorRow: View {
    let visitor: LiveVisitor
    let now: Date
    let language: Language

    private var name: String { VisitorFormat.name(visitor, language: language) }

    var body: some View {
        HStack(alignment: .top, spacing: Theme.Space.md) {
            Avatar(
                name: name,
                imageURL: visitor.contact?.avatarURL,
                size: Theme.Size.avatarMedium,
                os: visitor.os,
                device: visitor.device,
                countryCode: visitor.geo?.countryCode
            )
            .overlay(alignment: .topTrailing) {
                PresenceDot(presence: visitor.presence)
            }

            VStack(alignment: .leading, spacing: Theme.Space.xxs) {
                HStack(spacing: Theme.Space.sm) {
                    Text(name)
                        .font(Theme.Typo.rowTitle)
                        .foregroundStyle(Theme.Palette.label)
                        .lineLimit(1)
                    Spacer(minLength: Theme.Space.xs)
                    if visitor.conversation != nil {
                        StatusPill(text: Str.visitorInChat(language), tint: Theme.Palette.brand)
                    }
                }

                Text(VisitorFormat.whereAndWhen(visitor, now: now, language: language))
                    .font(Theme.Typo.rowSubtitle)
                    .foregroundStyle(Theme.Palette.labelSecondary)
                    .lineLimit(1)

                let page = VisitorText.shortURL(visitor.currentPage)
                if !page.isEmpty {
                    // An address reads left to right in every language, and
                    // sits on the reading side of the row all the same.
                    Text(page)
                        .font(Theme.Typo.meta)
                        .foregroundStyle(Theme.Palette.labelTertiary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                        .environment(\.layoutDirection, .leftToRight)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
        .padding(.vertical, Theme.Space.xs)
        .accessibilityElement(children: .combine)
        .accessibilityValue(VisitorFormat.presence(visitor.presence, language: language))
    }
}

/// Green and haloed when on the page, amber when the tab is in the
/// background, grey when gone — the web's colours for the same three states.
struct PresenceDot: View {
    let presence: VisitorPresence
    var size: CGFloat = 12

    static func color(_ presence: VisitorPresence) -> Color {
        switch presence {
        case .online: Theme.Palette.success
        case .idle: Theme.Palette.warning
        case .offline: Color(uiColor: .systemGray)
        }
    }

    var body: some View {
        Circle()
            .fill(Self.color(presence))
            .frame(width: size, height: size)
            // A ring in the row's own colour, so the dot reads as sitting on
            // the avatar rather than as a hole in it — in both themes.
            .overlay(Circle().strokeBorder(Theme.Palette.background, lineWidth: 2))
            .accessibilityHidden(true)
    }
}
