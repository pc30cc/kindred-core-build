import Foundation

enum Language: String, CaseIterable, Sendable, Identifiable {
    case fa, en, tr

    var id: String { rawValue }

    var code: String { rawValue }

    var isRightToLeft: Bool { self == .fa }

    /// Its own name, as the language picker lists it.
    var nativeName: String {
        switch self {
        case .fa: return "فارسی"
        case .en: return "English"
        case .tr: return "Türkçe"
        }
    }

    var locale: Locale {
        switch self {
        case .fa: return Locale(identifier: "fa_IR")
        case .tr: return Locale(identifier: "tr_TR")
        case .en: return Locale(identifier: "en_US")
        }
    }

    static func parse(_ code: String?) -> Language? {
        switch code?.trimmingCharacters(in: .whitespaces).lowercased() {
        case "fa", "fa-ir", "fa_ir": return .fa
        case "tr", "tr-tr", "tr_tr": return .tr
        case "en", "en-us", "en-gb", "en_us", "en_gb": return .en
        default: return nil
        }
    }

    /// The first launch follows the Mac's language when it is one of ours, Persian otherwise.
    static var system: Language {
        for id in Locale.preferredLanguages {
            if let l = parse(String(id.prefix(2))) { return l }
        }
        return .fa
    }
}

/// The app's copy in Persian, English and Turkish — the same sentences the
/// Windows, iOS and web apps use. The table is the Windows app's own
/// strings.json (windows-native/src/Webyar.Core/Localization), bundled as is,
/// with the few Mac-specific lines layered on top (Resources/mac-strings.json).
/// `{name}` placeholders are filled in, numbers in the language's own digits.
struct Strings: Sendable {
    let language: Language
    private let table: [String: [String: String]]

    init(_ language: Language, table: [String: [String: String]]? = nil) {
        self.language = language
        self.table = table ?? Self.shared
    }

    var isRightToLeft: Bool { language.isRightToLeft }

    subscript(_ key: String) -> String { self.get(key) }

    func get(_ key: String, _ args: [String: Any] = [:]) -> String {
        let raw = lookup(language, key) ?? lookup(.en, key) ?? key
        guard !args.isEmpty else { return raw }
        var out = ""
        var i = raw.startIndex
        while i < raw.endIndex {
            if raw[i] == "{", let close = raw[i...].firstIndex(of: "}") {
                let name = String(raw[raw.index(after: i)..<close])
                if !name.isEmpty, name.allSatisfy({ $0.isLetter || $0.isNumber || $0 == "_" }), let value = args[name] {
                    out += format(value)
                    i = raw.index(after: close)
                    continue
                }
            }
            out.append(raw[i])
            i = raw.index(after: i)
        }
        return out
    }

    func get(_ key: String, _ name: String, _ value: Any) -> String { get(key, [name: value]) }

    func has(_ key: String) -> Bool { lookup(.en, key) != nil }

    /// A number in this language's digits.
    func number(_ n: Int) -> String { Digits.localize(String(n), language) }

    private func format(_ value: Any) -> String {
        switch value {
        case let i as Int: return Digits.localize(String(i), language)
        case let i as Int64: return Digits.localize(String(i), language)
        case let d as Double: return Digits.localize(d == d.rounded() ? String(Int64(d)) : String(d), language)
        default: return "\(value)"
        }
    }

    private func lookup(_ language: Language, _ key: String) -> String? {
        guard let s = table[language.code]?[key], !s.isEmpty else { return nil }
        return s
    }

    static let shared: [String: [String: String]] = load()

    private static func load() -> [String: [String: String]] {
        var table: [String: [String: String]] = [:]
        // The shared table first, then every "*-strings.json" the Mac app adds on top.
        let bundle = Bundle.main
        var urls: [URL] = []
        if let base = bundle.url(forResource: "strings", withExtension: "json") { urls.append(base) }
        urls += (bundle.urls(forResourcesWithExtension: "json", subdirectory: nil) ?? [])
            .filter { $0.deletingPathExtension().lastPathComponent.hasSuffix("-strings") }
            .sorted { $0.lastPathComponent < $1.lastPathComponent }
        for url in urls {
            guard let data = try? Data(contentsOf: url),
                  let raw = try? JSONSerialization.jsonObject(with: data) as? [String: [String: String]] else { continue }
            for (code, dict) in raw { table[code, default: [:]].merge(dict) { _, new in new } }
        }
        return table
    }
}


/// Western digits to Persian ones, the way every Persian UI in the product writes numbers.
enum Digits {
    private static let persian: [Character] = ["۰", "۱", "۲", "۳", "۴", "۵", "۶", "۷", "۸", "۹"]

    static func localize(_ text: String, _ language: Language) -> String {
        guard language == .fa else { return text }
        return String(text.map { c in
            if let d = c.wholeNumberValue, c.isASCII { return persian[d] }
            return c
        })
    }
}
