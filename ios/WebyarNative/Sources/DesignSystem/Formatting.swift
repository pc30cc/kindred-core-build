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

    /// The calendar a date should be *read* in, which is not the same as the
    /// one the device happens to be set to.
    ///
    /// A Persian operator reads Persian dates: ۲۷ شهریور, not ۱۸ سپتامبر.
    /// That is a different calendar, not a different set of month names, so
    /// starting from `Calendar.current` — Gregorian on a device configured in
    /// English — and only changing its locale gives Persian *words* over
    /// Gregorian *dates*, which is worse than either on its own. The clock
    /// stays the device's: the operator is where they are.
    static func workingCalendar(_ locale: Locale) -> Calendar {
        var calendar = Calendar(identifier: locale.calendar.identifier)
        calendar.locale = locale
        calendar.timeZone = Calendar.current.timeZone
        return calendar
    }

    /// Numbers in the reader's own digits.
    ///
    /// Swift's own interpolation always produces Latin digits, so a count
    /// built with `"\(n)"` lands as "2" in the middle of a Persian sentence.
    /// Anything a person reads as a quantity goes through here instead.
    static func number(_ value: Int, locale: Locale) -> String {
        numberCache.formatter(locale: locale).string(from: NSNumber(value: value))
            ?? String(value)
    }

    static func number(_ value: Int, language: Language) -> String {
        number(value, locale: language.locale)
    }

    /// Same reasoning as the date cache: building a `NumberFormatter` per row
    /// per frame is not free.
    private final class NumberFormatterCache: @unchecked Sendable {
        private var storage: [String: NumberFormatter] = [:]
        private let lock = NSLock()

        func formatter(locale: Locale) -> NumberFormatter {
            lock.lock()
            defer { lock.unlock() }
            if let cached = storage[locale.identifier] { return cached }

            let formatter = NumberFormatter()
            formatter.locale = locale
            formatter.numberStyle = .decimal
            // A count is not a measurement: "1,024 conversations" is a
            // grouping separator doing no work in a badge.
            formatter.usesGroupingSeparator = false
            storage[locale.identifier] = formatter
            return formatter
        }
    }

    private static let numberCache = NumberFormatterCache()

    /// The timestamp on a list row: a time for today, a weekday inside the
    /// last week, a date beyond that. This is the convention Mail and
    /// Messages use, and it is what lets someone scan a column of timestamps
    /// without reading any of them closely.
    static func listTimestamp(_ date: Date?, locale: Locale, now: Date = Date()) -> String {
        guard let date else { return "" }

        let calendar = workingCalendar(locale)

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
        let calendar = workingCalendar(locale)

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
        let calendar = workingCalendar(locale)
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

    /// A call length or a wait, as `m:ss` or `h:mm:ss`.
    ///
    /// The shape is fixed — a duration is read as a clock rather than as a
    /// sentence, "4:05" lands faster than "4 minutes 5 seconds", and a column
    /// of them lines up — but the digits are the reader's own. An iPhone set
    /// to Persian counts a call in ۰۰:۴۰, and so does this.
    static func duration(_ seconds: Int, locale: Locale) -> String {
        let clamped = max(0, seconds)
        let hours = clamped / 3600
        let minutes = (clamped % 3600) / 60
        let secs = clamped % 60
        // Padded on both sides, which is what `formatCallDuration` in
        // `src/lib/systemMessageText.ts` does — a call summary has to read
        // identically in the app and in the console.
        return hours > 0
            ? clock([hours, minutes, secs], padFirst: true, locale: locale)
            : clock([minutes, secs], padFirst: true, locale: locale)
    }

    /// Joins clock fields with a colon, zero-padding every field after the
    /// first in whatever digits the locale writes.
    ///
    /// Padding has to happen in the localized digits rather than before
    /// them: `String(format: "%02d", 5)` gives "05", and swapping the glyphs
    /// afterwards is exactly the kind of string surgery that breaks on the
    /// next locale. Formatting each field and padding with the locale's own
    /// zero keeps it honest.
    private static func clock(_ fields: [Int], padFirst: Bool = false, locale: Locale) -> String {
        let zero = number(0, locale: locale)
        return fields.enumerated().map { index, value in
            let text = number(value, locale: locale)
            guard index > 0 || padFirst, text.count < 2 else { return text }
            return zero + text
        }
        .joined(separator: ":")
    }

    /// A file size the way a person reads one.
    ///
    /// Same thresholds and rounding as `humanSize` in
    /// `src/components/inbox/MessageAttachmentView.tsx`, so an attachment
    /// reads the same in the app and in the console — with the digits and the
    /// unit word in the reader's own language.
    static func fileSize(_ bytes: Int, language: Language) -> String {
        let locale = language.locale
        if bytes < 1024 {
            return "\(number(bytes, locale: locale)) \(Str.unitBytes(language))"
        }
        if bytes < 1024 * 1024 {
            let kb = Int((Double(bytes) / 1024).rounded())
            return "\(number(kb, locale: locale)) \(Str.unitKilobytes(language))"
        }
        let mb = Double(bytes) / (1024 * 1024)
        // One decimal place below 10 MB, none above — a "12.3 MB" reads no
        // better than "12 MB" and takes more room in a card.
        let text = mb < 10
            ? decimal(mb, locale: locale)
            : number(Int(mb.rounded()), locale: locale)
        return "\(text) \(Str.unitMegabytes(language))"
    }

    /// One decimal place, in the locale's digits and with its decimal mark.
    private static func decimal(_ value: Double, locale: Locale) -> String {
        let formatter = NumberFormatter()
        formatter.locale = locale
        formatter.numberStyle = .decimal
        formatter.usesGroupingSeparator = false
        formatter.minimumFractionDigits = 1
        formatter.maximumFractionDigits = 1
        return formatter.string(from: NSNumber(value: value)) ?? String(format: "%.1f", value)
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

extension Format {
    /// How long a call has been running, as a call timer reads it: mm:ss, and
    /// h:mm:ss only once there is an hour to show.
    static func callDuration(from start: Date, to now: Date, locale: Locale) -> String {
        let total = max(0, Int(now.timeIntervalSince(start)))
        let seconds = total % 60
        let minutes = (total / 60) % 60
        let hours = total / 3600
        return hours > 0
            ? clock([hours, minutes, seconds], locale: locale)
            : clock([minutes, seconds], padFirst: true, locale: locale)
    }
}
