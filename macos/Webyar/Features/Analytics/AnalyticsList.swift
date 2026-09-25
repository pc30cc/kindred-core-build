import SwiftUI

/// Website analytics' content column: the title, who is on the site right
/// now, the date range every report shares, and the reports to pick from.
struct AnalyticsList: View {
    let model: AnalyticsModel
    @Environment(AppModel.self) private var app

    var body: some View {
        let s = app.strings
        VStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 12) {
                HStack(spacing: 12) {
                    Image(systemName: "chart.bar.xaxis")
                        .font(.system(size: 17, weight: .semibold))
                        .foregroundStyle(.white)
                        .frame(width: 40, height: 40)
                        .background(LinearGradient(colors: [Color(hex: 0x3B9BFF), Color(hex: 0x0070E0)], startPoint: .top, endPoint: .bottom),
                                    in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                    VStack(alignment: .leading, spacing: 2) {
                        Text(s["navAnalytics"]).appFont(18, .bold).lineLimit(1)
                        Text(s["waSubtitle"]).appFont(11.5).foregroundStyle(Palette.text2).lineLimit(2)
                    }
                    Spacer(minLength: 4)
                    Button { model.refresh() } label: { Image(systemName: "arrow.clockwise") }
                        .buttonStyle(.borderless)
                        .help(s["refresh"])
                        .keyboardShortcut("r", modifiers: .command)
                }
                if let live = model.live {
                    LiveVisitorsPill(count: live)
                }
                Picker("", selection: Binding(get: { model.range }, set: { model.setRange($0) })) {
                    ForEach(AnalyticsRange.allCases) { r in
                        Text(s["waRange\(r.rawValue)"]).tag(r)
                    }
                }
                .pickerStyle(.segmented)
                .labelsHidden()
            }
            .padding(.horizontal, 14)
            .padding(.top, 12)
            .padding(.bottom, 12)
            Divider()
            ScrollView {
                VStack(spacing: 6) {
                    ForEach(AnalyticsSection.allCases) { section in
                        AnalyticsSectionRow(section: section, selected: model.section == section) {
                            model.section = section
                        }
                    }
                }
                .padding(10)
            }
        }
        .onAppear { model.appear() }
        .onDisappear { model.disappear() }
    }
}

/// "12 on the site now", with a slow green pulse.
private struct LiveVisitorsPill: View {
    let count: Int
    @Environment(AppModel.self) private var app
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        HStack(spacing: 8) {
            TimelineView(.animation(minimumInterval: 1.0 / 20, paused: reduceMotion || count == 0)) { context in
                let t = reduceMotion ? 0 : context.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 1.6) / 1.6
                ZStack {
                    Circle().fill(Palette.success.opacity(count > 0 ? 0.35 * (1 - t) : 0))
                        .frame(width: 8 + 10 * t, height: 8 + 10 * t)
                    Circle().fill(count > 0 ? Palette.success : Palette.text3).frame(width: 8, height: 8)
                }
                .frame(width: 18, height: 18)
            }
            Text(app.strings.get("waLiveNow", "count", AnalyticsFormat.count(count, app.strings)))
                .appFont(12.5, .semibold)
                .foregroundStyle(count > 0 ? Palette.success : Palette.text2)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background((count > 0 ? Palette.successSoft : Palette.elevated), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
    }
}

/// One report: its icon on a coloured tile, its name and what it answers.
private struct AnalyticsSectionRow: View {
    let section: AnalyticsSection
    let selected: Bool
    let action: () -> Void
    @Environment(AppModel.self) private var app
    @State private var hovering = false

    var body: some View {
        let s = app.strings
        Button(action: action) {
            HStack(spacing: 12) {
                Image(systemName: section.icon)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(section.tint)
                    .frame(width: 34, height: 34)
                    .background(section.tint.opacity(0.14), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                VStack(alignment: .leading, spacing: 2) {
                    Text(s[section.titleKey]).appFont(13.5, .semibold).foregroundStyle(Palette.text).lineLimit(1)
                    Text(s[section.hintKey]).appFont(11.5).foregroundStyle(Palette.text2).lineLimit(1)
                }
                Spacer(minLength: 4)
                Image(systemName: "chevron.forward")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(selected ? Palette.brand : Palette.text3.opacity(hovering ? 1 : 0.5))
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 9)
            .background(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .fill(selected ? Palette.selected : hovering ? Palette.hover : Color.clear)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .strokeBorder(selected ? Palette.brand.opacity(0.35) : Color.clear, lineWidth: 1)
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
    }
}

extension AnalyticsSection {
    /// Each report's own colour, for its tile here and its accents on the page.
    var tint: Color {
        switch self {
        case .overview: return Palette.brand
        case .sources: return Color(hex: 0x6E56CF)
        case .pages: return Color(hex: 0x0EA5A4)
        case .geography: return Color(hex: 0x30A46C)
        case .technology: return Color(hex: 0xF76B15)
        case .events: return Color(hex: 0xD6409F)
        }
    }
}

// MARK: - Formatting

/// Numbers, shares, durations and dates the way each language writes them.
enum AnalyticsFormat {
    static func count(_ n: Int, _ s: Strings) -> String {
        let f = NumberFormatter()
        f.locale = s.language.locale
        f.numberStyle = .decimal
        f.maximumFractionDigits = 0
        return f.string(from: NSNumber(value: n)) ?? s.number(n)
    }

    static func decimal(_ v: Double, _ s: Strings) -> String {
        let f = NumberFormatter()
        f.locale = s.language.locale
        f.numberStyle = .decimal
        f.minimumFractionDigits = 1
        f.maximumFractionDigits = 1
        return f.string(from: NSNumber(value: v)) ?? String(format: "%.1f", v)
    }

    /// `fraction` is 0–1.
    static func percent(_ fraction: Double, _ s: Strings) -> String {
        let f = NumberFormatter()
        f.locale = s.language.locale
        f.numberStyle = .percent
        f.maximumFractionDigits = fraction < 0.1 && fraction > 0 ? 1 : 0
        return f.string(from: NSNumber(value: fraction)) ?? "\(Int(fraction * 100))%"
    }

    static func duration(_ seconds: Double, _ s: Strings) -> String {
        let total = max(0, Int(seconds.rounded()))
        let m = total / 60, sec = total % 60
        if m == 0 { return "\(count(sec, s)) \(s["waSeconds"])" }
        return "\(count(m, s)) \(s["waMinutes"]) \(count(sec, s)) \(s["waSeconds"])"
    }

    private static let dayParser: DateFormatter = {
        let f = DateFormatter()
        f.calendar = Calendar(identifier: .gregorian)
        f.timeZone = TimeZone(identifier: "UTC")
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyy-MM-dd"
        return f
    }()

    static func day(_ text: String) -> Date? { dayParser.date(from: text) }

    /// "12 Mehr" / "4 Oct": the day on the chart's axis and in its tooltip.
    static func dayLabel(_ date: Date, _ s: Strings, long: Bool = false) -> String {
        let f = DateFormatter()
        f.locale = s.language.locale
        f.timeZone = TimeZone(identifier: "UTC")
        if s.language == .fa { f.calendar = Calendar(identifier: .persian) }
        f.setLocalizedDateFormatFromTemplate(long ? "EEEE d MMMM" : "d MMM")
        return f.string(from: date)
    }

    /// A channel's key ("organic_search") in the reader's language.
    static func channel(_ key: String, _ s: Strings) -> String {
        let k = "waChannel_\(key)"
        let v = s[k]
        return v == k ? key : v
    }

    /// The country's name in the reader's language and its flag, from the English name the server keeps.
    static func country(_ name: String, _ s: Strings) -> (flag: String?, name: String) {
        guard let code = countryCodes[name.lowercased()] else { return (nil, name) }
        return (AvatarArt.flag(code), s.language.locale.localizedString(forRegionCode: code) ?? name)
    }

    private static let countryCodes: [String: String] = {
        var map: [String: String] = [:]
        let en = Locale(identifier: "en_US")
        for region in Locale.Region.isoRegions where region.identifier.count == 2 {
            if let name = en.localizedString(forRegionCode: region.identifier) { map[name.lowercased()] = region.identifier }
        }
        // The names the geo databases use where they differ from Apple's.
        for (name, code) in ["iran": "IR", "russia": "RU", "south korea": "KR", "united states": "US", "united kingdom": "GB",
                             "turkey": "TR", "türkiye": "TR", "czech republic": "CZ", "vietnam": "VN", "syria": "SY", "hong kong": "HK"] {
            map[name] = code
        }
        return map
    }()

    /// "fa-IR" → "Persian (Iran)", in the reader's language.
    static func language(_ tag: String, _ s: Strings) -> String {
        s.language.locale.localizedString(forIdentifier: tag.replacingOccurrences(of: "-", with: "_")) ?? tag
    }

    static func deviceIcon(_ key: String) -> String {
        let k = key.lowercased()
        if k.contains("mobile") || k.contains("phone") { return "iphone" }
        if k.contains("tablet") || k.contains("ipad") { return "ipad" }
        return "desktopcomputer"
    }

    static func osIcon(_ key: String) -> String {
        switch AvatarArt.osOf(key) {
        case .apple: return "apple.logo"
        case .windows: return "pc"
        case .android: return "iphone.gen2"
        case .linux: return "terminal"
        case .none: return "questionmark.circle"
        }
    }
}
