import Charts
import SwiftUI

/// The report picked in the list: the overview's numbers and trend, or one
/// breakdown, laid out as a dashboard of cards.
struct AnalyticsDetail: View {
    let model: AnalyticsModel
    @Environment(AppModel.self) private var app

    var body: some View {
        let s = app.strings
        Group {
            if model.locked {
                EmptyState(systemImage: "lock.fill", title: s["waLocked"], message: s["waLockedHint"], tint: Palette.warning)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        header
                        if let error = model.error {
                            Banner(severity: .error, message: error, actionTitle: s["retry"], action: { model.refresh() })
                        }
                        if truncated {
                            Label(s["waTruncated"], systemImage: "info.circle")
                                .appFont(11.5)
                                .foregroundStyle(Palette.text2)
                        }
                        content
                    }
                    .padding(24)
                    .frame(maxWidth: 1080)
                    .frame(maxWidth: .infinity)
                }
                .background(Palette.appBackground)
            }
        }
    }

    private var header: some View {
        let s = app.strings
        let section = model.section
        return HStack(spacing: 12) {
            Image(systemName: section.icon)
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(section.tint)
                .frame(width: 36, height: 36)
                .background(section.tint.opacity(0.14), in: RoundedRectangle(cornerRadius: 11, style: .continuous))
            VStack(alignment: .leading, spacing: 2) {
                Text(s[section.titleKey]).appFont(20, .bold)
                Text(verbatim: "\(s[section.hintKey]) · \(s["waRange\(model.range.rawValue)"])")
                    .appFont(12)
                    .foregroundStyle(Palette.text2)
            }
            Spacer()
        }
    }

    private var truncated: Bool {
        switch model.section {
        case .overview: return model.overview?.truncated == true
        case .sources: return model.breakdowns["sources.\(model.sourceDimension)"]?.truncated == true
        case .pages: return model.pageLists["pages.\(model.pagesKind)"]?.truncated == true
        case .geography: return model.breakdowns["geo.\(model.geoDimension)"]?.truncated == true
        case .technology: return ["device", "os", "browser"].contains { model.breakdowns["tech.\($0)"]?.truncated == true }
        case .events: return model.events?.truncated == true
        }
    }

    @ViewBuilder private var content: some View {
        switch model.section {
        case .overview: AnalyticsOverviewView(model: model)
        case .sources: AnalyticsSourcesView(model: model)
        case .pages: AnalyticsPagesView(model: model)
        case .geography: AnalyticsGeographyView(model: model)
        case .technology: AnalyticsTechnologyView(model: model)
        case .events: AnalyticsEventsView(model: model)
        }
    }
}

// MARK: - Overview

private struct AnalyticsOverviewView: View {
    let model: AnalyticsModel
    @Environment(AppModel.self) private var app

    var body: some View {
        let s = app.strings
        let o = model.overview, p = model.previous
        let vs = s.get("waVsPrevious", "count", AnalyticsFormat.count(model.range.rawValue, s))
        VStack(alignment: .leading, spacing: 16) {
            LazyVGrid(columns: Array(repeating: GridItem(.flexible(minimum: 150), spacing: 12), count: 3), spacing: 12) {
                KPITile(icon: "person.2.fill", tint: Palette.brand, label: s["waVisitors"],
                        value: o.map { AnalyticsFormat.count($0.uniqueVisitors ?? 0, s) },
                        change: change(o?.uniqueVisitors.map(Double.init), p?.uniqueVisitors.map(Double.init)), changeHelp: vs)
                KPITile(icon: "rectangle.stack.fill", tint: Color(hex: 0x6E56CF), label: s["waSessions"],
                        value: o.map { AnalyticsFormat.count($0.sessions ?? 0, s) },
                        change: change(o?.sessions.map(Double.init), p?.sessions.map(Double.init)), changeHelp: vs)
                KPITile(icon: "eye.fill", tint: Color(hex: 0x0EA5A4), label: s["waPageviews"],
                        value: o.map { AnalyticsFormat.count($0.pageviews ?? 0, s) },
                        change: change(o?.pageviews.map(Double.init), p?.pageviews.map(Double.init)), changeHelp: vs)
                KPITile(icon: "doc.on.doc.fill", tint: Color(hex: 0x30A46C), label: s["waPagesPerSession"],
                        value: o.map { AnalyticsFormat.decimal($0.avgPagesPerSession ?? 0, s) },
                        change: change(o?.avgPagesPerSession, p?.avgPagesPerSession), changeHelp: vs)
                KPITile(icon: "arrow.uturn.backward", tint: Color(hex: 0xF76B15), label: s["waBounceRate"],
                        value: o.map { AnalyticsFormat.percent(($0.bounceRate ?? 0) / 100, s) },
                        change: change(o?.bounceRate, p?.bounceRate), higherIsBetter: false, changeHelp: vs)
                KPITile(icon: "clock.fill", tint: Color(hex: 0xD6409F), label: s["waAvgDuration"],
                        value: o.map { AnalyticsFormat.duration($0.avgVisitDurationSeconds ?? 0, s) },
                        change: change(o?.avgVisitDurationSeconds, p?.avgVisitDurationSeconds), changeHelp: vs)
            }
            TrendCard(overview: o, loading: model.isLoading("overview"))
            ViewThatFits(in: .horizontal) {
                HStack(alignment: .top, spacing: 16) { channels(o); pages(o) }
                VStack(spacing: 16) { channels(o); pages(o) }
            }
        }
    }

    /// The relative change from the period before, when both are known and the old one is not zero.
    private func change(_ now: Double?, _ before: Double?) -> Double? {
        guard let now, let before, before > 0 else { return nil }
        return (now - before) / before
    }

    private func channels(_ o: WebAnalyticsOverview?) -> some View {
        let s = app.strings
        let rows = (o?.topChannels ?? []).map { BarItem(id: $0.key, label: AnalyticsFormat.channel($0.key, s), value: $0.sessions ?? 0) }
        return AnalyticsCard(title: s["waTopChannels"], icon: "arrow.triangle.branch", tint: AnalyticsSection.sources.tint) {
            BarList(items: rows, loading: o == nil, unit: s["waVisitsUnit"], limit: 6, tint: AnalyticsSection.sources.tint)
        }
        .frame(minWidth: 320)
    }

    private func pages(_ o: WebAnalyticsOverview?) -> some View {
        let s = app.strings
        let rows = (o?.topPages ?? []).map { BarItem(id: $0.path, label: $0.path, value: $0.views ?? 0, ltr: true) }
        return AnalyticsCard(title: s["waTopPages"], icon: "doc.text", tint: AnalyticsSection.pages.tint) {
            BarList(items: rows, loading: o == nil, unit: s["waViews"], limit: 6, tint: AnalyticsSection.pages.tint)
        }
        .frame(minWidth: 320)
    }
}

/// A headline number: its icon on a soft tint, the value large, the label under it.
private struct KPITile: View {
    let icon: String
    let tint: Color
    let label: String
    let value: String?
    /// The change from the period before (0.12 = 12% more).
    var change: Double? = nil
    /// False where less is better, as for the bounce rate.
    var higherIsBetter = true
    var changeHelp = ""
    @Environment(AppModel.self) private var app

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .center) {
                Image(systemName: icon)
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(tint)
                    .frame(width: 28, height: 28)
                    .background(tint.opacity(0.14), in: Circle())
                Spacer(minLength: 4)
                if let change, value != nil { changeChip(change) }
            }
            VStack(alignment: .leading, spacing: 3) {
                if let value {
                    Text(value).appFont(24, .bold).monospacedDigit().lineLimit(1).minimumScaleFactor(0.6)
                } else {
                    RoundedRectangle(cornerRadius: 6).fill(Palette.elevated).frame(width: 80, height: 26)
                }
                Text(label).appFont(12).foregroundStyle(Palette.text2).lineLimit(1)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .panel(14)
    }

    /// "▲ 12%": green when the number moved the good way, red when the bad way, grey when flat.
    private func changeChip(_ change: Double) -> some View {
        let flat = abs(change) < 0.005
        let good = (change > 0) == higherIsBetter
        let color = flat ? Palette.text2 : good ? Palette.success : Palette.danger
        return HStack(spacing: 3) {
            Image(systemName: flat ? "equal" : change > 0 ? "arrow.up.right" : "arrow.down.right")
                .font(.system(size: 9, weight: .bold))
            Text(AnalyticsFormat.percent(abs(change), app.strings)).appFont(11, .semibold).monospacedDigit()
        }
        .foregroundStyle(color)
        .padding(.horizontal, 7)
        .padding(.vertical, 3)
        .background(color.opacity(0.12), in: Capsule())
        .environment(\.layoutDirection, .leftToRight)
        .help(changeHelp)
    }
}

/// Visits or page views, day by day, with the day under the pointer called out.
private struct TrendCard: View {
    let overview: WebAnalyticsOverview?
    let loading: Bool
    @Environment(AppModel.self) private var app
    @State private var showViews = false
    @State private var selected: Date?

    private struct Point: Identifiable {
        let date: Date
        let value: Int
        var id: Date { date }
    }

    private var points: [Point] {
        (overview?.trend ?? []).compactMap { d in
            AnalyticsFormat.day(d.date).map { Point(date: $0, value: (showViews ? d.pageviews : d.sessions) ?? 0) }
        }
    }

    var body: some View {
        let s = app.strings
        let pts = points
        let tint = Palette.brand
        AnalyticsCard(title: s["waTrend"], icon: "chart.xyaxis.line", tint: tint) {
            Picker("", selection: $showViews) {
                Text(s["waSessions"]).tag(false)
                Text(s["waPageviews"]).tag(true)
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .frame(width: 220)
        } content: {
            if overview == nil {
                RoundedRectangle(cornerRadius: 10).fill(Palette.elevated.opacity(0.6)).frame(height: 240)
                    .overlay { if loading { ProgressView().controlSize(.small) } }
            } else if pts.allSatisfy({ $0.value == 0 }) {
                EmptyState(systemImage: "chart.xyaxis.line", title: s["waNoData"], message: s["waNoDataHint"])
                    .frame(maxWidth: .infinity)
            } else {
                Chart {
                    ForEach(pts) { p in
                        AreaMark(x: .value("day", p.date, unit: .day), y: .value("n", p.value))
                            .interpolationMethod(.monotone)
                            .foregroundStyle(LinearGradient(colors: [tint.opacity(0.26), tint.opacity(0.02)], startPoint: .top, endPoint: .bottom))
                        LineMark(x: .value("day", p.date, unit: .day), y: .value("n", p.value))
                            .interpolationMethod(.monotone)
                            .lineStyle(StrokeStyle(lineWidth: 2, lineCap: .round, lineJoin: .round))
                            .foregroundStyle(tint)
                    }
                    if let sel = nearest(pts) {
                        RuleMark(x: .value("day", sel.date, unit: .day))
                            .foregroundStyle(Palette.text3.opacity(0.45))
                            .lineStyle(StrokeStyle(lineWidth: 1, dash: [3, 3]))
                        PointMark(x: .value("day", sel.date, unit: .day), y: .value("n", sel.value))
                            .symbolSize(70)
                            .foregroundStyle(tint)
                            .annotation(position: .top, spacing: 8, overflowResolution: .init(x: .fit(to: .chart), y: .disabled)) {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(AnalyticsFormat.dayLabel(sel.date, s, long: true)).appFont(11).foregroundStyle(Palette.text2)
                                    Text(verbatim: "\(AnalyticsFormat.count(sel.value, s)) \(s[showViews ? "waViews" : "waVisitsUnit"])")
                                        .appFont(13, .bold)
                                        .foregroundStyle(Palette.text)
                                }
                                .padding(.horizontal, 10)
                                .padding(.vertical, 6)
                                .background(Palette.surface, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                                .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(Palette.line))
                                .shadow(color: .black.opacity(0.08), radius: 6, y: 2)
                                .environment(\.layoutDirection, s.isRightToLeft ? .rightToLeft : .leftToRight)
                            }
                    }
                }
                .chartXSelection(value: $selected)
                .chartYAxis {
                    AxisMarks(position: .leading, values: .automatic(desiredCount: 4)) { value in
                        AxisGridLine().foregroundStyle(Palette.line)
                        AxisValueLabel {
                            if let n = value.as(Int.self) { Text(AnalyticsFormat.count(n, s)).appFont(10.5).foregroundStyle(Palette.text3) }
                        }
                    }
                }
                .chartXAxis {
                    AxisMarks(values: .automatic(desiredCount: 6)) { value in
                        AxisValueLabel {
                            if let d = value.as(Date.self) { Text(AnalyticsFormat.dayLabel(d, s)).appFont(10.5).foregroundStyle(Palette.text3) }
                        }
                    }
                }
                .frame(height: 240)
                // Time runs left to right in every language, as on the web.
                .environment(\.layoutDirection, .leftToRight)
            }
        }
    }

    private func nearest(_ pts: [Point]) -> Point? {
        guard let selected else { return nil }
        return pts.min { abs($0.date.timeIntervalSince(selected)) < abs($1.date.timeIntervalSince(selected)) }
    }
}

// MARK: - Breakdowns

private struct AnalyticsSourcesView: View {
    let model: AnalyticsModel
    @Environment(AppModel.self) private var app

    var body: some View {
        @Bindable var model = model
        let s = app.strings
        let result = model.breakdowns["sources.\(model.sourceDimension)"]
        let rows = (result?.rows ?? []).map { r in
            BarItem(id: r.key, label: model.sourceDimension == "channel" ? AnalyticsFormat.channel(r.key, s) : AnalyticsFormat.unknown(r.label ?? r.key, s),
                    value: r.sessions ?? 0, secondary: r.pageviews.map { "\(AnalyticsFormat.count($0, s)) \(s["waViews"])" },
                    ltr: model.sourceDimension != "channel")
        }
        AnalyticsCard(title: s["waSources"], icon: AnalyticsSection.sources.icon, tint: AnalyticsSection.sources.tint) {
            Picker("", selection: $model.sourceDimension) {
                Text(s["waChannel"]).tag("channel")
                Text(s["waSource"]).tag("source")
                Text(s["waCampaign"]).tag("campaign")
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .frame(width: 280)
        } content: {
            BarList(items: rows, loading: result == nil, unit: s["waVisitsUnit"], limit: 25, tint: AnalyticsSection.sources.tint)
        }
        .insights(rows, loaded: result != nil, total: s["waTotal"], tint: AnalyticsSection.sources.tint)
    }
}

private struct AnalyticsPagesView: View {
    let model: AnalyticsModel
    @Environment(AppModel.self) private var app

    var body: some View {
        @Bindable var model = model
        let s = app.strings
        let result = model.pageLists["pages.\(model.pagesKind)"]
        let rows = (result?.rows ?? []).map { BarItem(id: $0.path, label: $0.path, value: $0.views ?? 0, ltr: true) }
        AnalyticsCard(title: s["waPages"], icon: AnalyticsSection.pages.icon, tint: AnalyticsSection.pages.tint) {
            Picker("", selection: $model.pagesKind) {
                Text(s["waPagesTop"]).tag("top")
                Text(s["waPagesEntry"]).tag("entry")
                Text(s["waPagesExit"]).tag("exit")
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .frame(width: 320)
        } content: {
            BarList(items: rows, loading: result == nil, unit: s["waViews"], limit: 25, tint: AnalyticsSection.pages.tint)
        }
        .insights(rows, loaded: result != nil, total: s["waPageviews"], tint: AnalyticsSection.pages.tint)
    }
}

private struct AnalyticsGeographyView: View {
    let model: AnalyticsModel
    @Environment(AppModel.self) private var app

    var body: some View {
        @Bindable var model = model
        let s = app.strings
        let result = model.breakdowns["geo.\(model.geoDimension)"]
        let rows: [BarItem] = (result?.rows ?? []).map { r in
            let raw = r.label ?? r.key
            switch model.geoDimension {
            case "country":
                let c = AnalyticsFormat.country(raw, s)
                return BarItem(id: r.key, label: AnalyticsFormat.unknown(c.name, s), value: r.sessions ?? 0, leading: c.flag)
            case "language":
                return BarItem(id: r.key, label: AnalyticsFormat.unknown(AnalyticsFormat.language(raw, s), s), value: r.sessions ?? 0)
            default:
                return BarItem(id: r.key, label: AnalyticsFormat.unknown(raw, s), value: r.sessions ?? 0)
            }
        }
        AnalyticsCard(title: s["waGeography"], icon: AnalyticsSection.geography.icon, tint: AnalyticsSection.geography.tint) {
            Picker("", selection: $model.geoDimension) {
                Text(s["waCountry"]).tag("country")
                Text(s["waCity"]).tag("city")
                Text(s["waLanguage"]).tag("language")
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .frame(width: 260)
        } content: {
            BarList(items: rows, loading: result == nil, unit: s["waVisitsUnit"], limit: 25, tint: AnalyticsSection.geography.tint)
        }
        .insights(rows, loaded: result != nil, total: s["waTotal"], tint: AnalyticsSection.geography.tint)
    }
}

private struct AnalyticsTechnologyView: View {
    let model: AnalyticsModel
    @Environment(AppModel.self) private var app

    var body: some View {
        let s = app.strings
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 300), spacing: 16, alignment: .top)], spacing: 16) {
            card("device", title: s["waDevice"], icon: "laptopcomputer.and.iphone", symbol: AnalyticsFormat.deviceIcon, name: { AnalyticsFormat.device($0, s) })
            card("os", title: s["waOs"], icon: "gearshape.2", symbol: AnalyticsFormat.osIcon)
            card("browser", title: s["waBrowser"], icon: "safari")
        }
    }

    private func card(_ dim: String, title: String, icon: String,
                      symbol: ((String) -> String)? = nil, name: ((String) -> String)? = nil) -> some View {
        let s = app.strings
        let tint = AnalyticsSection.technology.tint
        let result = model.breakdowns["tech.\(dim)"]
        let rows = (result?.rows ?? []).map { r in
            BarItem(id: r.key, label: AnalyticsFormat.unknown(name?(r.key) ?? r.label ?? r.key, s), value: r.sessions ?? 0, symbol: symbol?(r.key))
        }
        return AnalyticsCard(title: title, icon: icon, tint: tint) {
            BarList(items: rows, loading: result == nil, unit: s["waVisitsUnit"], limit: 8, tint: tint)
        }
    }
}

private struct AnalyticsEventsView: View {
    let model: AnalyticsModel
    @Environment(AppModel.self) private var app

    var body: some View {
        let s = app.strings
        let tint = AnalyticsSection.events.tint
        let rows = model.events?.rows ?? []
        let best = max(0.0001, rows.compactMap(\.conversionRate).max() ?? 0)
        AnalyticsCard(title: s["waEvents"], icon: AnalyticsSection.events.icon, tint: tint) {
            if model.events == nil {
                ProgressView().controlSize(.small).frame(maxWidth: .infinity, minHeight: 120)
            } else if rows.isEmpty {
                EmptyState(systemImage: "cursorarrow.click.2", title: s["waNoEvents"], message: s["waNoEventsHint"], tint: tint)
                    .frame(maxWidth: .infinity)
            } else {
                VStack(spacing: 0) {
                    HStack {
                        Text(s["waEvents"]).frame(maxWidth: .infinity, alignment: .leading)
                        Text(s["waEventCount"]).frame(width: 90, alignment: .trailing)
                        Text(s["waEventSessions"]).frame(width: 90, alignment: .trailing)
                        Text(s["waConversion"]).frame(width: 150, alignment: .trailing)
                    }
                    .appFont(11, .semibold)
                    .foregroundStyle(Palette.text3)
                    .padding(.horizontal, 4)
                    .padding(.bottom, 8)
                    ForEach(rows) { e in
                        Divider()
                        HStack {
                            Text(e.eventName)
                                .appFont(13, .semibold)
                                .environment(\.layoutDirection, .leftToRight)
                                .frame(maxWidth: .infinity, alignment: .leading)
                            Text(AnalyticsFormat.count(e.count ?? 0, s)).appFont(13).monospacedDigit().frame(width: 90, alignment: .trailing)
                            Text(AnalyticsFormat.count(e.uniqueSessions ?? 0, s)).appFont(13).monospacedDigit().frame(width: 90, alignment: .trailing)
                            HStack(spacing: 8) {
                                ShareBar(fraction: (e.conversionRate ?? 0) / best, tint: tint).frame(width: 70)
                                Text(AnalyticsFormat.percent(e.conversionRate ?? 0, s)).appFont(13, .semibold).monospacedDigit()
                            }
                            .frame(width: 150, alignment: .trailing)
                        }
                        .padding(.vertical, 10)
                        .padding(.horizontal, 4)
                    }
                }
            }
        }
    }
}

// MARK: - Pieces

/// A white card with a small coloured icon, a title, optional controls, and its content.
private struct AnalyticsCard<Controls: View, Content: View>: View {
    let title: String
    let icon: String
    let tint: Color
    @ViewBuilder var controls: Controls
    @ViewBuilder var content: Content

    init(title: String, icon: String, tint: Color, @ViewBuilder controls: () -> Controls, @ViewBuilder content: () -> Content) {
        self.title = title
        self.icon = icon
        self.tint = tint
        self.controls = controls()
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 8) {
                Image(systemName: icon)
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(tint)
                Text(title).appFont(14, .semibold)
                Spacer(minLength: 8)
                controls
            }
            content
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .panel(16)
    }
}

extension AnalyticsCard where Controls == EmptyView {
    init(title: String, icon: String, tint: Color, @ViewBuilder content: () -> Content) {
        self.init(title: title, icon: icon, tint: tint, controls: { EmptyView() }, content: content)
    }
}

/// One line of a ranked list.
private struct BarItem: Identifiable {
    let id: String
    let label: String
    let value: Int
    var secondary: String? = nil
    /// A flag or other glyph before the label.
    var leading: String? = nil
    /// An SF Symbol before the label.
    var symbol: String? = nil
    /// URLs and campaign names read left to right in every language.
    var ltr = false
}

/// A ranked list: each line's label and count over a bar showing its share of the whole.
private struct BarList: View {
    let items: [BarItem]
    let loading: Bool
    let unit: String
    let limit: Int
    let tint: Color
    @Environment(AppModel.self) private var app

    var body: some View {
        let s = app.strings
        if loading {
            VStack(spacing: 14) {
                ForEach(0..<4, id: \.self) { _ in
                    RoundedRectangle(cornerRadius: 6).fill(Palette.elevated.opacity(0.7)).frame(height: 22)
                }
            }
        } else if items.isEmpty {
            EmptyState(systemImage: "tray", title: s["waNoData"], message: s["waNoDataHint"], tint: tint)
                .frame(maxWidth: .infinity)
        } else {
            let total = max(1, items.reduce(0) { $0 + $1.value })
            let top = max(1, items.map(\.value).max() ?? 1)
            VStack(spacing: 12) {
                ForEach(items.prefix(limit)) { item in
                    VStack(alignment: .leading, spacing: 6) {
                        HStack(spacing: 8) {
                            if let leading = item.leading { Text(leading).font(.system(size: 14)) }
                            if let symbol = item.symbol {
                                Image(systemName: symbol).font(.system(size: 11, weight: .medium)).foregroundStyle(Palette.text2).frame(width: 16)
                            }
                            Text(item.label)
                                .appFont(12.5, .medium)
                                .lineLimit(1)
                                .truncationMode(.middle)
                                .environment(\.layoutDirection, item.ltr ? .leftToRight : (s.isRightToLeft ? .rightToLeft : .leftToRight))
                                .help(item.label)
                            Spacer(minLength: 8)
                            if let secondary = item.secondary {
                                Text(secondary).appFont(11).foregroundStyle(Palette.text3).lineLimit(1)
                            }
                            Text(AnalyticsFormat.count(item.value, s)).appFont(12.5, .semibold).monospacedDigit()
                            Text(AnalyticsFormat.percent(Double(item.value) / Double(total), s))
                                .appFont(11)
                                .foregroundStyle(Palette.text2)
                                .monospacedDigit()
                                .frame(minWidth: 38, alignment: .trailing)
                        }
                        ShareBar(fraction: Double(item.value) / Double(top), tint: tint)
                    }
                    .help("\(AnalyticsFormat.count(item.value, s)) \(unit)")
                }
            }
        }
    }
}

/// A thin rounded bar, filled to `fraction` (0–1) from the reading edge.
private struct ShareBar: View {
    let fraction: Double
    let tint: Color

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                Capsule().fill(Palette.elevated)
                Capsule()
                    .fill(LinearGradient(colors: [tint.opacity(0.75), tint], startPoint: .leading, endPoint: .trailing))
                    .frame(width: max(4, geo.size.width * min(1, max(0, fraction))))
            }
        }
        .frame(height: 6)
    }
}

extension AnalyticsFormat {
    /// The server's "(unknown)" bucket, in the reader's language.
    static func unknown(_ label: String, _ s: Strings) -> String {
        label == "(unknown)" || label.isEmpty ? s["waUnknown"] : label
    }
}

extension View {
    /// Three tiles above a ranked report: its total, the line in first place and how many lines there are.
    fileprivate func insights(_ items: [BarItem], loaded: Bool, total: String, tint: Color) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            if loaded, !items.isEmpty { InsightStrip(items: items, totalLabel: total, tint: tint) }
            self
        }
    }
}

private struct InsightStrip: View {
    let items: [BarItem]
    let totalLabel: String
    let tint: Color
    @Environment(AppModel.self) private var app

    var body: some View {
        let s = app.strings
        let total = items.reduce(0) { $0 + $1.value }
        let top = items.max { $0.value < $1.value }
        HStack(spacing: 12) {
            tile(icon: "sum", label: totalLabel) {
                Text(AnalyticsFormat.count(total, s)).appFont(20, .bold).monospacedDigit()
            }
            tile(icon: "crown.fill", label: s["waLeader"]) {
                if let top {
                    HStack(spacing: 6) {
                        if let flag = top.leading { Text(flag).font(.system(size: 15)) }
                        Text(top.label)
                            .appFont(15, .bold)
                            .lineLimit(1)
                            .truncationMode(.middle)
                            .environment(\.layoutDirection, top.ltr ? .leftToRight : (s.isRightToLeft ? .rightToLeft : .leftToRight))
                        Text(AnalyticsFormat.percent(Double(top.value) / Double(max(1, total)), s))
                            .appFont(12, .semibold)
                            .foregroundStyle(Palette.text2)
                            .monospacedDigit()
                    }
                }
            }
            tile(icon: "list.number", label: s["waDistinct"]) {
                Text(AnalyticsFormat.count(items.count, s)).appFont(20, .bold).monospacedDigit()
            }
        }
    }

    private func tile<V: View>(icon: String, label: String, @ViewBuilder value: () -> V) -> some View {
        HStack(spacing: 12) {
            Image(systemName: icon)
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(tint)
                .frame(width: 30, height: 30)
                .background(tint.opacity(0.14), in: RoundedRectangle(cornerRadius: 9, style: .continuous))
            VStack(alignment: .leading, spacing: 2) {
                value().frame(height: 24, alignment: .leading)
                Text(label).appFont(11.5).foregroundStyle(Palette.text2).lineLimit(1)
            }
            Spacer(minLength: 0)
        }
        .padding(12)
        .frame(maxWidth: .infinity)
        .panel(14)
    }
}
