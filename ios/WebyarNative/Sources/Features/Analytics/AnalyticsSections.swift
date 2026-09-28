import SwiftUI
import Charts

// MARK: - Overview

/// The headline numbers against the period before, the trend, and the top
/// channels and pages.
struct AnalyticsOverviewSection: View {
    let model: AnalyticsViewModel
    let language: Language

    private let columns = [
        GridItem(.flexible(), spacing: Theme.Space.sm, alignment: .top),
        GridItem(.flexible(), spacing: Theme.Space.sm, alignment: .top),
    ]

    var body: some View {
        let now = model.overview, before = model.previous
        let comparedWith = Str.analyticsVsPrevious(language)
            .filling("count", with: AnalyticsFormat.count(model.range.rawValue, language))

        VStack(alignment: .leading, spacing: Theme.Space.lg) {
            LazyVGrid(columns: columns, spacing: Theme.Space.sm) {
                KPITile(
                    icon: "person.2.fill", tint: Theme.Palette.brand, label: Str.analyticsVisitors(language),
                    value: now.map { AnalyticsFormat.count($0.uniqueVisitors ?? 0, language) },
                    change: change(now?.uniqueVisitors, before?.uniqueVisitors), comparedWith: comparedWith, language: language
                )
                KPITile(
                    icon: "rectangle.stack.fill", tint: AnalyticsSection.sources.tint, label: Str.analyticsSessions(language),
                    value: now.map { AnalyticsFormat.count($0.sessions ?? 0, language) },
                    change: change(now?.sessions, before?.sessions), comparedWith: comparedWith, language: language
                )
                KPITile(
                    icon: "eye.fill", tint: AnalyticsSection.pages.tint, label: Str.analyticsPageviews(language),
                    value: now.map { AnalyticsFormat.count($0.pageviews ?? 0, language) },
                    change: change(now?.pageviews, before?.pageviews), comparedWith: comparedWith, language: language
                )
                KPITile(
                    icon: "doc.on.doc.fill", tint: AnalyticsSection.geography.tint, label: Str.analyticsPagesPerVisit(language),
                    value: now.map { AnalyticsFormat.decimal($0.avgPagesPerSession ?? 0, language) },
                    change: AnalyticsViewModel.change(now?.avgPagesPerSession, before?.avgPagesPerSession),
                    comparedWith: comparedWith, language: language
                )
                KPITile(
                    icon: "arrow.uturn.backward", tint: AnalyticsSection.technology.tint, label: Str.analyticsBounceRate(language),
                    value: now.map { AnalyticsFormat.percent(($0.bounceRate ?? 0) / 100, language) },
                    change: AnalyticsViewModel.change(now?.bounceRate, before?.bounceRate),
                    higherIsBetter: false, comparedWith: comparedWith, language: language
                )
                KPITile(
                    icon: "clock.fill", tint: AnalyticsSection.events.tint, label: Str.analyticsAvgDuration(language),
                    value: now.map { AnalyticsFormat.duration($0.avgVisitDurationSeconds ?? 0, language) },
                    change: AnalyticsViewModel.change(now?.avgVisitDurationSeconds, before?.avgVisitDurationSeconds),
                    comparedWith: comparedWith, language: language
                )
            }

            AnalyticsTrendCard(overview: now, language: language)

            AnalyticsCard(title: Str.analyticsTopChannels(language), icon: AnalyticsSection.sources.icon,
                          tint: AnalyticsSection.sources.tint) {
                AnalyticsBarList(
                    items: (now?.topChannels ?? []).map {
                        AnalyticsBarItem(id: $0.key, label: AnalyticsFormat.channel($0.key, language), value: $0.sessions)
                    },
                    loading: now == nil, limit: 6, tint: AnalyticsSection.sources.tint, language: language
                )
            }

            AnalyticsCard(title: Str.analyticsTopPages(language), icon: AnalyticsSection.pages.icon,
                          tint: AnalyticsSection.pages.tint) {
                AnalyticsBarList(
                    items: (now?.topPages ?? []).map {
                        AnalyticsBarItem(id: $0.path, label: $0.path, value: $0.views, latin: true)
                    },
                    loading: now == nil, limit: 6, tint: AnalyticsSection.pages.tint, language: language
                )
            }
        }
    }

    private func change(_ now: Int?, _ before: Int?) -> Double? {
        AnalyticsViewModel.change(now.map(Double.init), before.map(Double.init))
    }
}

/// A headline number: its icon on a soft tint, the value large, the label
/// under it, and how it moved since the period before.
private struct KPITile: View {
    let icon: String
    let tint: Color
    let label: String
    /// Nil while it loads.
    let value: String?
    /// 0.12 is 12% more than the period before.
    var change: Double?
    /// False where less is better, as for the bounce rate.
    var higherIsBetter = true
    let comparedWith: String
    let language: Language

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Space.sm) {
            HStack(alignment: .center, spacing: Theme.Space.xs) {
                Image(systemName: icon)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(tint)
                    .frame(width: 28, height: 28)
                    .background(Circle().fill(tint.opacity(0.14)))
                    .accessibilityHidden(true)
                Spacer(minLength: 0)
                if let change, value != nil { changeChip(change) }
            }
            if let value {
                Text(value)
                    .font(.title2.weight(.bold))
                    .monospacedDigit()
                    .foregroundStyle(Theme.Palette.label)
                    .lineLimit(1)
                    .minimumScaleFactor(0.6)
                    .contentTransition(.numericText())
            } else {
                RoundedRectangle(cornerRadius: Theme.Radius.sm)
                    .fill(Theme.Palette.surfaceElevated)
                    .frame(width: 72, height: 26)
                    .accessibilityHidden(true)
            }
            Text(label)
                .font(Theme.Typo.meta)
                .foregroundStyle(Theme.Palette.labelSecondary)
                .lineLimit(2)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(Theme.Space.md)
        .background(RoundedRectangle(cornerRadius: Theme.Radius.lg, style: .continuous).fill(Theme.Palette.surface))
        .accessibilityElement(children: .combine)
    }

    /// Green when the number moved the good way, red the bad way, grey when
    /// it held.
    private func changeChip(_ change: Double) -> some View {
        let flat = abs(change) < 0.005
        let good = (change > 0) == higherIsBetter
        let color = flat ? Theme.Palette.labelSecondary : good ? Theme.Palette.success : Theme.Palette.danger
        return HStack(spacing: Theme.Space.xxs) {
            Image(systemName: flat ? "equal" : change > 0 ? "arrow.up.right" : "arrow.down.right")
                .font(.caption2.weight(.bold))
            Text(AnalyticsFormat.percent(abs(change), language))
                .font(.caption2.weight(.semibold))
                .monospacedDigit()
        }
        .foregroundStyle(color)
        .padding(.horizontal, Theme.Space.xs + 2)
        .padding(.vertical, Theme.Space.xxs)
        .background(Capsule().fill(color.opacity(0.12)))
        // Up and to the right is "more" in every language; mirroring the
        // arrow would make growth look like decline.
        .environment(\.layoutDirection, .leftToRight)
        .accessibilityLabel("\(change > 0 ? "+" : flat ? "" : "−")\(AnalyticsFormat.percent(abs(change), language)), \(comparedWith)")
    }
}

/// Visits or page views, day by day, with the touched day called out.
private struct AnalyticsTrendCard: View {
    let overview: WebAnalyticsOverview?
    let language: Language
    @State private var showsViews = false
    @State private var selected: Date?

    private struct Point: Identifiable {
        let date: Date
        let value: Int
        var id: Date { date }
    }

    private var points: [Point] {
        (overview?.trend ?? []).compactMap { day in
            AnalyticsFormat.day(day.date).map { Point(date: $0, value: showsViews ? day.pageviews : day.sessions) }
        }
    }

    var body: some View {
        let tint = Theme.Palette.brand
        let series = points
        AnalyticsCard(title: Str.analyticsTrend(language), icon: AnalyticsSection.overview.icon, tint: tint) {
            VStack(alignment: .leading, spacing: Theme.Space.md) {
                Picker(Str.analyticsTrend(language), selection: $showsViews) {
                    Text(Str.analyticsSessions(language)).tag(false)
                    Text(Str.analyticsPageviews(language)).tag(true)
                }
                .pickerStyle(.segmented)

                if overview == nil {
                    RoundedRectangle(cornerRadius: Theme.Radius.md)
                        .fill(Theme.Palette.surfaceElevated.opacity(0.6))
                        .frame(height: 200)
                        .overlay { ProgressView() }
                } else if series.allSatisfy({ $0.value == 0 }) {
                    EmptyStateView(
                        systemImage: "chart.xyaxis.line",
                        title: Str.analyticsNoData(language),
                        message: Str.analyticsNoDataHint(language)
                    )
                } else {
                    chart(series, tint: tint)
                }
            }
        }
    }

    private func chart(_ points: [Point], tint: Color) -> some View {
        Chart {
            ForEach(points) { point in
                AreaMark(x: .value("Day", point.date, unit: .day), y: .value("Count", point.value))
                    .interpolationMethod(.monotone)
                    .foregroundStyle(
                        LinearGradient(colors: [tint.opacity(0.28), tint.opacity(0.02)], startPoint: .top, endPoint: .bottom)
                    )
                LineMark(x: .value("Day", point.date, unit: .day), y: .value("Count", point.value))
                    .interpolationMethod(.monotone)
                    .lineStyle(StrokeStyle(lineWidth: 2, lineCap: .round, lineJoin: .round))
                    .foregroundStyle(tint)
            }
            if let point = nearest(points) {
                RuleMark(x: .value("Day", point.date, unit: .day))
                    .foregroundStyle(Theme.Palette.labelTertiary)
                    .lineStyle(StrokeStyle(lineWidth: 1, dash: [3, 3]))
                PointMark(x: .value("Day", point.date, unit: .day), y: .value("Count", point.value))
                    .symbolSize(60)
                    .foregroundStyle(tint)
                    .annotation(position: .top, spacing: 6, overflowResolution: .init(x: .fit(to: .chart), y: .disabled)) {
                        callout(point)
                    }
            }
        }
        .chartXSelection(value: $selected)
        .chartYAxis {
            AxisMarks(position: .leading, values: .automatic(desiredCount: 4)) { value in
                AxisGridLine().foregroundStyle(Theme.Palette.separator.opacity(0.5))
                AxisValueLabel {
                    if let n = value.as(Int.self) {
                        Text(AnalyticsFormat.count(n, language))
                            .font(.caption2)
                            .foregroundStyle(Theme.Palette.labelTertiary)
                    }
                }
            }
        }
        .chartXAxis {
            AxisMarks(values: .automatic(desiredCount: 4)) { value in
                AxisValueLabel {
                    if let date = value.as(Date.self) {
                        Text(AnalyticsFormat.dayLabel(date, language))
                            .font(.caption2)
                            .foregroundStyle(Theme.Palette.labelTertiary)
                    }
                }
            }
        }
        .frame(height: 200)
        // Time runs left to right in every language, as it does on the web.
        .environment(\.layoutDirection, .leftToRight)
    }

    private func callout(_ point: Point) -> some View {
        VStack(alignment: .leading, spacing: Theme.Space.xxs) {
            Text(AnalyticsFormat.dayLabel(point.date, language, long: true))
                .font(.caption2)
                .foregroundStyle(Theme.Palette.labelSecondary)
            Text("\(AnalyticsFormat.count(point.value, language)) \(showsViews ? Str.analyticsViewsUnit(language) : Str.analyticsVisitsUnit(language))")
                .font(.footnote.weight(.bold))
                .foregroundStyle(Theme.Palette.label)
        }
        .padding(.horizontal, Theme.Space.sm)
        .padding(.vertical, Theme.Space.xs)
        .background(RoundedRectangle(cornerRadius: Theme.Radius.sm, style: .continuous).fill(Theme.Palette.surface))
        .overlay(RoundedRectangle(cornerRadius: Theme.Radius.sm, style: .continuous).strokeBorder(Theme.Palette.separator.opacity(0.5)))
        .shadow(color: .black.opacity(0.08), radius: 6, y: 2)
        // The callout's words go the reader's way, inside a chart that does not.
        .environment(\.layoutDirection, language.layoutDirection)
    }

    private func nearest(_ points: [Point]) -> Point? {
        guard let selected else { return nil }
        return points.min { abs($0.date.timeIntervalSince(selected)) < abs($1.date.timeIntervalSince(selected)) }
    }
}

// MARK: - Breakdowns

struct AnalyticsSourcesSection: View {
    let model: AnalyticsViewModel
    let language: Language

    var body: some View {
        @Bindable var model = model
        let dimension = model.sourceDimension
        let result = model.breakdowns[AnalyticsViewModel.key("sources", dimension)]
        let items = (result?.rows ?? []).map { row in
            AnalyticsBarItem(
                id: row.key,
                label: dimension == "channel" ? AnalyticsFormat.channel(row.key, language)
                    : AnalyticsFormat.unknown(row.label ?? row.key, language),
                value: row.sessions,
                latin: dimension != "channel" && row.key != "(unknown)"
            )
        }
        return AnalyticsBreakdownCard(
            section: .sources, items: items, loaded: result != nil,
            totalLabel: Str.analyticsTotal(language), language: language
        ) {
            Picker(Str.analyticsSources(language), selection: $model.sourceDimension) {
                Text(Str.analyticsChannel(language)).tag("channel")
                Text(Str.analyticsSource(language)).tag("source")
                Text(Str.analyticsCampaign(language)).tag("campaign")
            }
            .pickerStyle(.segmented)
        }
    }
}

struct AnalyticsPagesSection: View {
    let model: AnalyticsViewModel
    let language: Language

    var body: some View {
        @Bindable var model = model
        let result = model.pageLists[AnalyticsViewModel.key("pages", model.pagesKind)]
        let items = (result?.rows ?? []).map { AnalyticsBarItem(id: $0.path, label: $0.path, value: $0.views, latin: true) }
        return AnalyticsBreakdownCard(
            section: .pages, items: items, loaded: result != nil,
            totalLabel: Str.analyticsPageviews(language), language: language
        ) {
            Picker(Str.analyticsPages(language), selection: $model.pagesKind) {
                Text(Str.analyticsPagesTop(language)).tag("top")
                Text(Str.analyticsPagesEntry(language)).tag("entry")
                Text(Str.analyticsPagesExit(language)).tag("exit")
            }
            .pickerStyle(.segmented)
        }
    }
}

struct AnalyticsGeographySection: View {
    let model: AnalyticsViewModel
    let language: Language

    var body: some View {
        @Bindable var model = model
        let dimension = model.geoDimension
        let result = model.breakdowns[AnalyticsViewModel.key("geo", dimension)]
        let items: [AnalyticsBarItem] = (result?.rows ?? []).map { row in
            let raw = row.label ?? row.key
            switch dimension {
            case "country":
                let country = AnalyticsFormat.country(raw, language)
                return AnalyticsBarItem(id: row.key, label: country.name, value: row.sessions, leading: country.flag)
            case "language":
                return AnalyticsBarItem(id: row.key, label: AnalyticsFormat.languageName(raw, language), value: row.sessions)
            default:
                return AnalyticsBarItem(id: row.key, label: AnalyticsFormat.unknown(raw, language), value: row.sessions)
            }
        }
        return AnalyticsBreakdownCard(
            section: .geography, items: items, loaded: result != nil,
            totalLabel: Str.analyticsTotal(language), language: language
        ) {
            Picker(Str.analyticsGeography(language), selection: $model.geoDimension) {
                Text(Str.analyticsCountry(language)).tag("country")
                Text(Str.analyticsCity(language)).tag("city")
                Text(Str.analyticsLanguage(language)).tag("language")
            }
            .pickerStyle(.segmented)
        }
    }
}

/// Device, operating system and browser. The device split is a ring — three
/// slices at most, which is what a ring is good at; the other two are ranked.
struct AnalyticsTechnologySection: View {
    let model: AnalyticsViewModel
    let language: Language

    var body: some View {
        let tint = AnalyticsSection.technology.tint
        VStack(spacing: Theme.Space.lg) {
            AnalyticsCard(title: Str.analyticsDevice(language), icon: "laptopcomputer.and.iphone", tint: tint) {
                AnalyticsDeviceRing(result: rows("device"), language: language)
            }
            AnalyticsCard(title: Str.analyticsOS(language), icon: "gearshape.2", tint: tint) {
                AnalyticsBarList(
                    items: items("os") { AnalyticsFormat.unknown($0.label ?? $0.key, language) },
                    symbol: { AnalyticsFormat.osIcon($0) },
                    loading: rows("os") == nil, limit: 8, tint: tint, language: language
                )
            }
            AnalyticsCard(title: Str.analyticsBrowser(language), icon: "safari", tint: tint) {
                AnalyticsBarList(
                    items: items("browser") { AnalyticsFormat.unknown($0.label ?? $0.key, language) },
                    loading: rows("browser") == nil, limit: 8, tint: tint, language: language
                )
            }
        }
    }

    private func rows(_ dimension: String) -> WebAnalyticsRows<WebAnalyticsRow>? {
        model.breakdowns[AnalyticsViewModel.key("tech", dimension)]
    }

    private func items(_ dimension: String, label: (WebAnalyticsRow) -> String) -> [AnalyticsBarItem] {
        (rows(dimension)?.rows ?? []).map { AnalyticsBarItem(id: $0.key, label: label($0), value: $0.sessions) }
    }
}

/// The device split as a ring, with its legend beside it.
private struct AnalyticsDeviceRing: View {
    let result: WebAnalyticsRows<WebAnalyticsRow>?
    let language: Language

    private static let palette: [Color] = [
        Color(uiColor: .systemOrange), Color(uiColor: .systemBlue), Color(uiColor: .systemTeal),
        Color(uiColor: .systemPurple), Color(uiColor: .systemGray),
    ]

    var body: some View {
        let rows = Array((result?.rows ?? []).prefix(Self.palette.count))
        let total = max(1, rows.reduce(0) { $0 + $1.sessions })
        if result == nil {
            ProgressView().frame(maxWidth: .infinity, minHeight: 140)
        } else if rows.isEmpty {
            EmptyStateView(systemImage: "tray", title: Str.analyticsNoData(language), message: "")
        } else {
            HStack(spacing: Theme.Space.xl) {
                Chart(Array(rows.enumerated()), id: \.element.key) { index, row in
                    SectorMark(
                        angle: .value("Visits", row.sessions),
                        innerRadius: .ratio(0.62),
                        angularInset: 1.5
                    )
                    .cornerRadius(3)
                    .foregroundStyle(Self.palette[index])
                }
                .frame(width: 128, height: 128)
                .accessibilityHidden(true)

                VStack(alignment: .leading, spacing: Theme.Space.sm) {
                    ForEach(Array(rows.enumerated()), id: \.element.key) { index, row in
                        HStack(spacing: Theme.Space.sm) {
                            Circle().fill(Self.palette[index]).frame(width: 9, height: 9)
                            Image(systemName: VisitorFormat.deviceIcon(row.key))
                                .font(.caption)
                                .foregroundStyle(Theme.Palette.labelSecondary)
                                .frame(width: 16)
                            Text(AnalyticsFormat.unknown(VisitorFormat.device(row.key, language: language), language))
                                .font(.subheadline)
                                .lineLimit(1)
                            Spacer(minLength: Theme.Space.xs)
                            Text(AnalyticsFormat.percent(Double(row.sessions) / Double(total), language))
                                .font(.subheadline.weight(.semibold))
                                .monospacedDigit()
                        }
                        .accessibilityElement(children: .combine)
                    }
                }
            }
        }
    }
}

// MARK: - Events

struct AnalyticsEventsSection: View {
    let model: AnalyticsViewModel
    let language: Language

    var body: some View {
        let tint = AnalyticsSection.events.tint
        let rows = model.events?.rows ?? []
        let best = max(0.0001, rows.map(\.conversionRate).max() ?? 0)
        AnalyticsCard(title: Str.analyticsEvents(language), icon: AnalyticsSection.events.icon, tint: tint) {
            if model.events == nil {
                ProgressView().frame(maxWidth: .infinity, minHeight: 120)
            } else if rows.isEmpty {
                EmptyStateView(
                    systemImage: AnalyticsSection.events.icon,
                    title: Str.analyticsNoEvents(language),
                    message: Str.analyticsNoEventsHint(language)
                )
            } else {
                VStack(spacing: 0) {
                    ForEach(Array(rows.enumerated()), id: \.element.id) { index, event in
                        if index > 0 { Divider() }
                        eventRow(event, best: best, tint: tint)
                    }
                }
            }
        }
    }

    private func eventRow(_ event: WebAnalyticsEvent, best: Double, tint: Color) -> some View {
        VStack(alignment: .leading, spacing: Theme.Space.sm) {
            // An event's name is code, and reads as code in every language.
            Text(event.eventName)
                .font(.subheadline.weight(.semibold).monospaced())
                .lineLimit(1)
                .truncationMode(.middle)
                .environment(\.layoutDirection, .leftToRight)
                .frame(maxWidth: .infinity, alignment: .leading)

            HStack(spacing: Theme.Space.lg) {
                metric(Str.analyticsEventCount(language), AnalyticsFormat.count(event.count, language))
                metric(Str.analyticsEventVisits(language), AnalyticsFormat.count(event.uniqueSessions, language))
                metric(Str.analyticsConversion(language), AnalyticsFormat.percent(event.conversionRate, language))
                Spacer(minLength: 0)
            }
            AnalyticsShareBar(fraction: event.conversionRate / best, tint: tint)
        }
        .padding(.vertical, Theme.Space.md)
        .accessibilityElement(children: .combine)
    }

    private func metric(_ label: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: Theme.Space.xxs) {
            Text(value).font(.body.weight(.semibold)).monospacedDigit()
            Text(label).font(Theme.Typo.meta).foregroundStyle(Theme.Palette.labelSecondary)
        }
    }
}

// MARK: - Pieces

/// A card with a small coloured icon, a title, and its content.
struct AnalyticsCard<Content: View>: View {
    let title: String
    let icon: String
    let tint: Color
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Space.md) {
            Label {
                Text(title).font(.headline)
            } icon: {
                Image(systemName: icon)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(tint)
            }
            .accessibilityAddTraits(.isHeader)
            content
        }
        .padding(Theme.Space.lg)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: Theme.Radius.lg, style: .continuous).fill(Theme.Palette.surface))
    }
}

/// A ranked report: its dimension switch, three numbers that sum it up, and
/// its lines.
private struct AnalyticsBreakdownCard<Controls: View>: View {
    let section: AnalyticsSection
    let items: [AnalyticsBarItem]
    let loaded: Bool
    let totalLabel: String
    let language: Language
    @ViewBuilder var controls: Controls

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Space.lg) {
            controls
            if loaded, !items.isEmpty {
                AnalyticsInsightStrip(items: items, totalLabel: totalLabel, tint: section.tint, language: language)
            }
            AnalyticsCard(
                title: AnalyticsFormat.sectionTitle(section, language), icon: section.icon, tint: section.tint
            ) {
                AnalyticsBarList(items: items, loading: !loaded, limit: 25, tint: section.tint, language: language)
            }
        }
    }
}

/// One line of a ranked list.
struct AnalyticsBarItem: Identifiable {
    let id: String
    let label: String
    let value: Int
    /// Addresses and campaign names read left to right in every language.
    var latin = false
    /// A flag before the label.
    var leading: String?
}

/// A ranked list: each line's label and count over a bar showing its share.
///
/// Rows rather than a bar chart on purpose: the labels here are addresses
/// and names that need the whole width to be read, and a row's bar grows
/// from the reading edge in Persian as naturally as in English.
private struct AnalyticsBarList: View {
    let items: [AnalyticsBarItem]
    var symbol: ((String) -> String)?
    let loading: Bool
    let limit: Int
    let tint: Color
    let language: Language

    var body: some View {
        if loading {
            VStack(spacing: Theme.Space.md) {
                ForEach(0..<4, id: \.self) { _ in
                    RoundedRectangle(cornerRadius: Theme.Radius.sm)
                        .fill(Theme.Palette.surfaceElevated)
                        .frame(height: 24)
                }
            }
            .accessibilityHidden(true)
        } else if items.isEmpty {
            EmptyStateView(systemImage: "tray", title: Str.analyticsNoData(language), message: Str.analyticsNoDataHint(language))
        } else {
            let total = max(1, items.reduce(0) { $0 + $1.value })
            let top = max(1, items.map(\.value).max() ?? 1)
            VStack(spacing: Theme.Space.md) {
                ForEach(items.prefix(limit)) { item in
                    VStack(alignment: .leading, spacing: Theme.Space.xs + 2) {
                        HStack(spacing: Theme.Space.sm) {
                            if let leading = item.leading {
                                Text(leading).accessibilityHidden(true)
                            }
                            if let symbol {
                                Image(systemName: symbol(item.id))
                                    .font(.caption)
                                    .foregroundStyle(Theme.Palette.labelSecondary)
                                    .frame(width: 16)
                                    .accessibilityHidden(true)
                            }
                            Text(item.label)
                                .font(.subheadline)
                                .foregroundStyle(Theme.Palette.label)
                                .lineLimit(1)
                                .truncationMode(.middle)
                                .latin(item.latin)
                            Spacer(minLength: Theme.Space.sm)
                            Text(AnalyticsFormat.count(item.value, language))
                                .font(.subheadline.weight(.semibold))
                                .monospacedDigit()
                            Text(AnalyticsFormat.percent(Double(item.value) / Double(total), language))
                                .font(Theme.Typo.meta)
                                .foregroundStyle(Theme.Palette.labelSecondary)
                                .monospacedDigit()
                                .frame(minWidth: 40, alignment: .trailing)
                        }
                        AnalyticsShareBar(fraction: Double(item.value) / Double(top), tint: tint)
                    }
                    .accessibilityElement(children: .combine)
                }
            }
        }
    }
}

/// A thin rounded bar, filled to `fraction` (0–1) from the reading edge.
private struct AnalyticsShareBar: View {
    let fraction: Double
    let tint: Color

    var body: some View {
        GeometryReader { geometry in
            ZStack(alignment: .leading) {
                Capsule().fill(Theme.Palette.surfaceElevated)
                Capsule()
                    .fill(tint.gradient)
                    .frame(width: max(4, geometry.size.width * min(1, max(0, fraction))))
            }
        }
        .frame(height: 6)
        .accessibilityHidden(true)
    }
}

/// Three tiles over a ranked report: its total, the line in first place and
/// how many lines there are. Side by side when they fit, stacked when not.
private struct AnalyticsInsightStrip: View {
    let items: [AnalyticsBarItem]
    let totalLabel: String
    let tint: Color
    let language: Language

    var body: some View {
        let total = items.reduce(0) { $0 + $1.value }
        let leader = items.max { $0.value < $1.value }
        ViewThatFits(in: .horizontal) {
            HStack(spacing: Theme.Space.sm) { tiles(total: total, leader: leader) }
            VStack(spacing: Theme.Space.sm) { tiles(total: total, leader: leader) }
        }
    }

    @ViewBuilder
    private func tiles(total: Int, leader: AnalyticsBarItem?) -> some View {
        tile(icon: "sum", label: totalLabel, value: AnalyticsFormat.count(total, language))
        if let leader {
            tile(
                icon: "crown.fill", label: Str.analyticsLeader(language),
                value: [leader.leading, leader.label].compactMap { $0 }.joined(separator: " "),
                latin: leader.latin
            )
        }
        tile(icon: "list.number", label: Str.analyticsDistinct(language), value: AnalyticsFormat.count(items.count, language))
    }

    private func tile(icon: String, label: String, value: String, latin: Bool = false) -> some View {
        HStack(spacing: Theme.Space.sm) {
            Image(systemName: icon)
                .font(.caption.weight(.semibold))
                .foregroundStyle(tint)
                .frame(width: 30, height: 30)
                .background(RoundedRectangle(cornerRadius: Theme.Radius.sm, style: .continuous).fill(tint.opacity(0.14)))
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: Theme.Space.xxs) {
                Text(value)
                    .font(.headline)
                    .monospacedDigit()
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .latin(latin)
                Text(label)
                    .font(Theme.Typo.meta)
                    .foregroundStyle(Theme.Palette.labelSecondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 0)
        }
        .padding(Theme.Space.md)
        .frame(maxWidth: .infinity)
        .background(RoundedRectangle(cornerRadius: Theme.Radius.lg, style: .continuous).fill(Theme.Palette.surface))
        .accessibilityElement(children: .combine)
    }
}
