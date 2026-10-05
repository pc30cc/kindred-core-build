import SwiftUI

/// The Analytics tab: website analytics as the web console's SEO → Web
/// Analytics shows it — who is on the site now, a shared date range, and six
/// reports laid out as cards.
///
/// Owners and admins on a plan with `web_analytics` see the tab at all
/// (`AppState.webAnalyticsVisible`); the server checks the same module on
/// every report, and a 403 here turns the screen into the "not in your plan"
/// state while the gates are read again.
struct AnalyticsView: View {
    /// Whether this tab is the one on screen. Nothing loads or polls otherwise.
    let isSelectedTab: Bool

    @Environment(AppState.self) private var appState
    @State private var model = AnalyticsViewModel()
    @State private var sync = SyncCoordinator.shared

    private var language: Language { appState.language }
    private var workspaceID: String? { appState.selectedWorkspace?.id }
    private var isLive: Bool { isSelectedTab && sync.isForeground && workspaceID != nil }

    var body: some View {
        Group {
            if model.locked {
                ScrollView {
                    EmptyStateView(
                        systemImage: "lock.fill",
                        title: Str.analyticsLocked(language),
                        message: Str.analyticsLockedHint(language)
                    )
                    .padding(.top, Theme.Space.huge)
                }
            } else {
                dashboard
            }
        }
        .background(Theme.Palette.background)
        .navigationTitle(Str.analyticsTitle(language))
        .navigationBarTitleDisplayMode(.inline)
        .floatingTabBarInset()
        .refreshable {
            model.refresh()
            await model.load(workspaceID: workspaceID, appState: appState)
        }
        // The reports on screen: again whenever the section, a dimension,
        // the range or the generation changes — and not at all while the tab
        // is out of sight.
        .task(id: "\(workspaceID ?? "-")|\(isSelectedTab)|\(model.loadKey)") {
            guard isSelectedTab else { return }
            await model.load(workspaceID: workspaceID, appState: appState)
        }
        // "On the site now", every thirty seconds, only while it can be seen.
        .task(id: "\(workspaceID ?? "-")|\(isLive)") {
            guard isLive, let workspaceID else { return }
            await model.pollLive(workspaceID: workspaceID, appState: appState)
        }
    }

    private var dashboard: some View {
        @Bindable var model = model
        return ScrollView {
            VStack(alignment: .leading, spacing: Theme.Space.lg) {
                header

                AnalyticsSectionStrip(selection: $model.section, language: language)

                if model.failed {
                    failureBanner
                }
                if model.truncated {
                    Label(Str.analyticsTruncated(language), systemImage: "info.circle")
                        .font(Theme.Typo.meta)
                        .foregroundStyle(Theme.Palette.labelSecondary)
                }

                section
            }
            .padding(.horizontal, Theme.screenInset)
            .padding(.top, Theme.Space.sm)
            .padding(.bottom, Theme.Space.xl)
            .animation(Theme.Motion.standard, value: model.section)
        }
    }

    /// Who is here now, and the range every report below shares.
    private var header: some View {
        VStack(alignment: .leading, spacing: Theme.Space.md) {
            Text(Str.analyticsSubtitle(language))
                .font(.app(.subheadline))
                .foregroundStyle(Theme.Palette.labelSecondary)
                .fixedSize(horizontal: false, vertical: true)

            if let live = model.live {
                LiveVisitorsPill(count: live, language: language)
                    .transition(.opacity)
            }

            Picker(Str.analyticsTitle(language), selection: Binding(get: { model.range }, set: { model.setRange($0) })) {
                ForEach(AnalyticsRange.allCases) { range in
                    Text(AnalyticsFormat.rangeTitle(range, language)).tag(range)
                }
            }
            .pickerStyle(.segmented)
        }
        .animation(Theme.Motion.standard, value: model.live != nil)
    }

    private var failureBanner: some View {
        HStack(spacing: Theme.Space.sm) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(Theme.Palette.warning)
            Text(Str.analyticsLoadFailed(language))
                .font(.app(.subheadline))
                .frame(maxWidth: .infinity, alignment: .leading)
            Button(Str.retry(language)) {
                model.refresh()
            }
            .font(.app(.subheadline, .semibold))
        }
        .padding(Theme.Space.md)
        .background(
            RoundedRectangle(cornerRadius: Theme.Radius.md, style: .continuous)
                .fill(Theme.Palette.warning.opacity(0.12))
        )
    }

    @ViewBuilder
    private var section: some View {
        switch model.section {
        case .overview: AnalyticsOverviewSection(model: model, language: language)
        case .sources: AnalyticsSourcesSection(model: model, language: language)
        case .pages: AnalyticsPagesSection(model: model, language: language)
        case .geography: AnalyticsGeographySection(model: model, language: language)
        case .technology: AnalyticsTechnologySection(model: model, language: language)
        case .events: AnalyticsEventsSection(model: model, language: language)
        }
    }
}

/// "12 on the site now", with a slow green pulse while anybody is.
private struct LiveVisitorsPill: View {
    let count: Int
    let language: Language
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var pulsing = false

    var body: some View {
        let active = count > 0
        HStack(spacing: Theme.Space.sm) {
            ZStack {
                Circle()
                    .fill(Theme.Palette.success.opacity(active ? 0.35 : 0))
                    .frame(width: 18, height: 18)
                    .scaleEffect(pulsing ? 1 : 0.45)
                    .opacity(pulsing ? 0 : 1)
                Circle()
                    .fill(active ? Theme.Palette.success : Theme.Palette.labelTertiary)
                    .frame(width: 8, height: 8)
            }
            .frame(width: 18, height: 18)
            .accessibilityHidden(true)

            Text(Str.analyticsLiveNow(language).filling("count", with: AnalyticsFormat.count(count, language)))
                .font(.app(.subheadline, .semibold))
                .foregroundStyle(active ? Theme.Palette.success : Theme.Palette.labelSecondary)
                .contentTransition(.numericText())
        }
        .padding(.horizontal, Theme.Space.md)
        .padding(.vertical, Theme.Space.sm)
        .background(
            Capsule().fill(active ? Theme.Palette.success.opacity(0.12) : Theme.Palette.surfaceElevated)
        )
        // Pulses only while somebody is there, and never under Reduce Motion.
        .onChange(of: active, initial: true) { _, on in
            pulsing = false
            guard on, !reduceMotion else { return }
            withAnimation(.easeOut(duration: 1.6).repeatForever(autoreverses: false)) { pulsing = true }
        }
    }
}

/// The six reports as a row of capsules that scrolls sideways — a picker
/// with room for an icon and a word each, which a segmented control of six
/// would not have on a phone.
private struct AnalyticsSectionStrip: View {
    @Binding var selection: AnalyticsSection
    let language: Language

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: Theme.Space.sm) {
                    ForEach(AnalyticsSection.allCases) { section in
                        chip(section)
                            .id(section)
                    }
                }
                .padding(.vertical, Theme.Space.xxs)
            }
            .onChange(of: selection) { _, now in
                withAnimation(Theme.Motion.standard) { proxy.scrollTo(now, anchor: .center) }
            }
        }
        // Bleeds to the screen edges, so the strip reads as scrollable.
        .padding(.horizontal, -Theme.screenInset)
        .contentMargins(.horizontal, Theme.screenInset, for: .scrollContent)
    }

    private func chip(_ section: AnalyticsSection) -> some View {
        let selected = section == selection
        return Button {
            guard !selected else { return }
            Haptics.selection()
            selection = section
        } label: {
            Label(AnalyticsFormat.sectionTitle(section, language), systemImage: section.icon)
                .font(.app(.subheadline, selected ? .semibold : .medium))
                .lineLimit(1)
                .padding(.horizontal, Theme.Space.md)
                .frame(minHeight: 36)
                .foregroundStyle(selected ? Color.white : section.tint)
                .background(
                    Capsule().fill(selected ? section.tint : section.tint.opacity(0.12))
                )
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? [.isSelected, .isButton] : .isButton)
        .accessibilityHint(AnalyticsFormat.sectionHint(section, language))
    }
}

extension AnalyticsSection {
    /// Each report's own colour, for its chip and its accents — the desktop
    /// apps' palette, through the system colours so both themes and
    /// increased contrast are looked after.
    var tint: Color {
        switch self {
        case .overview: Theme.Palette.brand
        case .sources: Color(uiColor: .systemIndigo)
        case .pages: Color(uiColor: .systemTeal)
        case .geography: Color(uiColor: .systemGreen)
        case .technology: Color(uiColor: .systemOrange)
        case .events: Color(uiColor: .systemPink)
        }
    }
}
