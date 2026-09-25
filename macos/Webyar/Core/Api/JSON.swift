import Foundation

/// Any JSON value, for the fields the server shapes freely (`metadata`, the
/// plan snapshot, map markers). Read with the typed accessors; a missing key
/// or a value of the wrong kind reads as nil, never as an error.
enum JSONValue: Codable, Hashable, Sendable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let b = try? c.decode(Bool.self) { self = .bool(b) }
        else if let n = try? c.decode(Double.self) { self = .number(n) }
        else if let s = try? c.decode(String.self) { self = .string(s) }
        else if let a = try? c.decode([JSONValue].self) { self = .array(a) }
        else { self = .object(try c.decode([String: JSONValue].self)) }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .null: try c.encodeNil()
        case .bool(let b): try c.encode(b)
        case .number(let n): try c.encode(n)
        case .string(let s): try c.encode(s)
        case .array(let a): try c.encode(a)
        case .object(let o): try c.encode(o)
        }
    }

    /// The decoder converts snake_case keys to camelCase everywhere, object
    /// keys inside free-form JSON included; a lookup by the server's own
    /// snake_case name finds either spelling.
    subscript(key: String) -> JSONValue? {
        guard case .object(let o) = self else { return nil }
        return o[key] ?? o[JSONValue.camel(key)]
    }

    static func camel(_ key: String) -> String {
        let parts = key.split(separator: "_", omittingEmptySubsequences: true)
        guard let first = parts.first, parts.count > 1, !key.hasPrefix("_") else { return key }
        return String(first) + parts.dropFirst().map { $0.prefix(1).uppercased() + $0.dropFirst().lowercased() }.joined()
    }

    var object: [String: JSONValue]? { if case .object(let o) = self { return o }; return nil }
    var array: [JSONValue]? { if case .array(let a) = self { return a }; return nil }
    var bool: Bool? { if case .bool(let b) = self { return b }; return nil }
    var isNull: Bool { if case .null = self { return true }; return false }

    var string: String? { if case .string(let s) = self { return s }; return nil }

    /// A non-empty, trimmed string.
    var text: String? {
        guard let s = string?.trimmingCharacters(in: .whitespacesAndNewlines), !s.isEmpty else { return nil }
        return s
    }

    var double: Double? {
        switch self {
        case .number(let n): return n.isFinite ? n : nil
        case .string(let s): return Double(s.trimmingCharacters(in: .whitespaces))
        default: return nil
        }
    }

    var int: Int? { double.map { Int($0.rounded()) } }

    /// Back to plain Foundation objects, e.g. to hand to a web page as JSON.
    var foundation: Any {
        switch self {
        case .null: return NSNull()
        case .bool(let b): return b
        case .number(let n): return n
        case .string(let s): return s
        case .array(let a): return a.map(\.foundation)
        case .object(let o): return o.mapValues(\.foundation)
        }
    }
}

/// The API speaks snake_case (and a little camelCase); both land on the same
/// Swift property. Dates come in every ISO 8601 shape Postgres and Node write.
enum JSON {
    static func decoder() -> JSONDecoder {
        let d = JSONDecoder()
        d.keyDecodingStrategy = .convertFromSnakeCase
        d.dateDecodingStrategy = .custom { decoder in
            let c = try decoder.singleValueContainer()
            if let n = try? c.decode(Double.self) {
                // Epoch seconds or milliseconds.
                return Date(timeIntervalSince1970: n > 10_000_000_000 ? n / 1000 : n)
            }
            let s = try c.decode(String.self)
            if let date = parseDate(s) { return date }
            throw DecodingError.dataCorruptedError(in: c, debugDescription: "Unreadable date \(s)")
        }
        return d
    }

    static func encoder() -> JSONEncoder {
        let e = JSONEncoder()
        e.dateEncodingStrategy = .iso8601
        return e
    }

    private static let withFraction: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    private static let plain: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()

    /// "2025-01-02T03:04:05Z", with or without fractions (any number of
    /// digits), "+00:00" or "+00", and Postgres' space instead of the T.
    static func parseDate(_ raw: String) -> Date? {
        var s = raw.trimmingCharacters(in: .whitespaces)
        guard !s.isEmpty else { return nil }
        if s.count >= 11, s[s.index(s.startIndex, offsetBy: 10)] == " " {
            s.replaceSubrange(s.index(s.startIndex, offsetBy: 10)...s.index(s.startIndex, offsetBy: 10), with: "T")
        }
        // "+00" → "+00:00"
        // (Only after a time: in a bare date "2025-01-02" the "-02" is the day.)
        if s.count > 10, let r = s.range(of: #"[+-]\d{2}$"#, options: .regularExpression) { s.replaceSubrange(r, with: s[r] + ":00") }
        // No zone at all: UTC, as the server writes it.
        if s.count == 19 || (s.contains(".") && s.range(of: #"(Z|[+-]\d{2}:\d{2})$"#, options: .regularExpression) == nil && s.count > 19) {
            s += "Z"
        }
        // Trim fractions to milliseconds; the formatter reads at most three digits reliably.
        if let dot = s.firstIndex(of: "."), let end = s[dot...].firstIndex(where: { !$0.isNumber && $0 != "." }) {
            let digits = s[s.index(after: dot)..<end]
            if digits.count > 3 { s.replaceSubrange(s.index(after: dot)..<end, with: digits.prefix(3)) }
        }
        if let d = withFraction.date(from: s) ?? plain.date(from: s) { return d }
        if s.count == 10 {
            let f = DateFormatter()
            f.locale = Locale(identifier: "en_US_POSIX")
            f.timeZone = TimeZone(identifier: "UTC")
            f.dateFormat = "yyyy-MM-dd"
            return f.date(from: s)
        }
        return nil
    }
}

// MARK: - Lenient values

/// Numbers and flags the server sometimes sends as strings (Postgres counts,
/// bigints). Missing, null or unreadable reads as nil instead of failing the
/// whole response, as the Windows app's `AllowReadingFromString` does.
@propertyWrapper
struct Lenient<Value: LenientValue>: Codable, Hashable, Sendable {
    var wrappedValue: Value?

    init(wrappedValue: Value?) { self.wrappedValue = wrappedValue }

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        wrappedValue = (try? c.decode(JSONValue.self)).flatMap(Value.init(json:))
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        if let v = wrappedValue { try c.encode(v) } else { try c.encodeNil() }
    }
}

protocol LenientValue: Codable, Hashable, Sendable {
    init?(json: JSONValue)
}

extension Int: LenientValue {
    init?(json: JSONValue) { guard let v = json.int else { return nil }; self = v }
}

extension Int64: LenientValue {
    init?(json: JSONValue) { guard let v = json.double else { return nil }; self = Int64(v) }
}

extension Double: LenientValue {
    init?(json: JSONValue) { guard let v = json.double else { return nil }; self = v }
}

extension Bool: LenientValue {
    init?(json: JSONValue) {
        switch json {
        case .bool(let b): self = b
        case .string(let s) where s == "true" || s == "1": self = true
        case .string(let s) where s == "false" || s == "0": self = false
        case .number(let n): self = n != 0
        default: return nil
        }
    }
}

extension String: LenientValue {
    init?(json: JSONValue) {
        switch json {
        case .string(let s): self = s
        case .number(let n): self = n == n.rounded() ? String(Int64(n)) : String(n)
        default: return nil
        }
    }
}

/// A date that reads as nil when it cannot be read, rather than failing the response.
struct LenientDate: LenientValue {
    let date: Date
    init(_ date: Date) { self.date = date }
    init?(json: JSONValue) {
        switch json {
        case .string(let s): guard let d = JSON.parseDate(s) else { return nil }; date = d
        case .number(let n): date = Date(timeIntervalSince1970: n > 10_000_000_000 ? n / 1000 : n)
        default: return nil
        }
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        guard let v = LenientDate(json: try c.decode(JSONValue.self)) else {
            throw DecodingError.dataCorruptedError(in: c, debugDescription: "date")
        }
        self = v
    }
    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        try c.encode(date.timeIntervalSince1970)
    }
}

extension KeyedDecodingContainer {
    /// A missing key is simply nil for a lenient field.
    func decode<T>(_ type: Lenient<T>.Type, forKey key: Key) throws -> Lenient<T> {
        (try? decodeIfPresent(type, forKey: key)) ?? Lenient(wrappedValue: nil)
    }
}
