import Foundation

/// Date and name formatting shared by every screen.
enum Format {

    /// Reuses formatters across calls.
    ///
    /// Building a `DateFormatter` is expensive, and a list row formats a date
    /// every time it is laid out — so a scrolling inbox would otherwise
    /// allocate one per row per frame. Keyed by template *and* locale, because
    /// the same template produces different output in Persian and English.
    ///
    /// `nonisolated(unsafe)` is sound here for the same reason the parsers
    /// above are: formatters are thread-safe once configured, and the lock
    /// guards only the dictionary.
    private final class FormatterCache: @unchecked Sendable {
        private var storage: [String: DateFormatter] = [:]
        private let lock = NSLock()

        func formatter(template: String, locale: Locale, calendar: Calendar) -> DateFormatter {
            let key = "\(template)|\(locale.identifier)|\(calendar.identifier)"
            lock.lock()
            defer { lock.unlock() }
            if let cached = storage[key] { return cached }

            let formatter = DateFormatter()
            formatter.locale = locale
            formatter.calendar = calendar
            formatter.setLocalizedDateFormatFromTemplate(template)
            storage[key] = formatter
            return formatter
        }
    }

    private static let cache = FormatterCache()

    private static func string(_ date: Date, template: String, locale: Locale, calendar: Calendar) -> String {
        cache.formatter(template: template, locale: locale, calendar: calendar).string(from: date)
    }

    /// The timestamp on a list row: a time for today, a weekday inside the
    /// last week, a date beyond that. This is the convention Mail and
    /// Messages use, and it is what lets someone scan a column of timestamps
    /// without reading any of them closely.
    static func listTimestamp(_ date: Date?, locale: Locale, now: Date = Date()) -> String {
        guard let date else { return "" }

        var calendar = Calendar.current
        calendar.locale = locale

        let template: String
        if calendar.isDateInToday(date) {
            template = "jmm"
        } else if calendar.isDateInYesterday(date) {
            // A relative word beats "Tue" when it is the day before.
            let relative = RelativeDateTimeFormatter()
            relative.locale = locale
            relative.dateTimeStyle = .named
            relative.unitsStyle = .short
            return relative.localizedString(from: DateComponents(day: -1))
        } else if let weekAgo = calendar.date(byAdding: .day, value: -6, to: now), date > weekAgo {
            template = "EEE"
        } else if calendar.isDate(date, equalTo: now, toGranularity: .year) {
            template = "dMMM"
        } else {
            template = "dMMMyy"
        }

        return string(date, template: template, locale: locale, calendar: calendar)
    }

    /// The header that separates one day of chat from the next.
    static func dayHeader(_ date: Date, locale: Locale, now: Date = Date()) -> String {
        var calendar = Calendar.current
        calendar.locale = locale

        if calendar.isDateInToday(date) || calendar.isDateInYesterday(date) {
            let relative = RelativeDateTimeFormatter()
            relative.locale = locale
            relative.dateTimeStyle = .named
            relative.unitsStyle = .full
            return relative.localizedString(
                from: DateComponents(day: calendar.isDateInToday(date) ? 0 : -1)
            )
        }

        let template = calendar.isDate(date, equalTo: now, toGranularity: .year)
            ? "EEEEdMMMM"
            : "dMMMMyyyy"
        return string(date, template: template, locale: locale, calendar: calendar)
    }

    /// The clock time under a chat bubble.
    static func bubbleTime(_ date: Date?, locale: Locale) -> String {
        guard let date else { return "" }
        var calendar = Calendar.current
        calendar.locale = locale
        return string(date, template: "jmm", locale: locale, calendar: calendar)
    }

    /// What to call a contact who may have given us nothing.
    ///
    /// Falls back through name → email local part → the stable visitor code,
    /// and only then to a generic word, so two anonymous visitors are still
    /// told apart on screen.
    static func contactName(
        name: String?,
        email: String?,
        visitorCode: String?,
        language: Language
    ) -> String {
        if let name, !name.trimmingCharacters(in: .whitespaces).isEmpty { return name }
        if let email, !email.isEmpty {
            if let at = email.firstIndex(of: "@"), at != email.startIndex {
                return String(email[email.startIndex..<at])
            }
            return email
        }
        if let visitorCode, !visitorCode.isEmpty {
            return "\(Str.unknownVisitor(language)) \(visitorCode)"
        }
        return Str.unknownVisitor(language)
    }

    /// Collapses a message body to a single scannable preview line.
    static func preview(_ body: String?) -> String {
        guard let body else { return "" }
        return body
            .replacingOccurrences(of: "\n", with: " ")
            .replacingOccurrences(of: "\r", with: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
