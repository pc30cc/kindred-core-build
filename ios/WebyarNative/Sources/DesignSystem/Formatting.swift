import Foundation

/// Date and name formatting shared by every screen.
enum Format {

    /// The timestamp on a list row: a time for today, a weekday inside the
    /// last week, a date beyond that. This is the convention Mail and
    /// Messages use, and it is what lets someone scan a column of timestamps
    /// without reading any of them closely.
    static func listTimestamp(_ date: Date?, locale: Locale, now: Date = Date()) -> String {
        guard let date else { return "" }

        var calendar = Calendar.current
        calendar.locale = locale
        let formatter = DateFormatter()
        formatter.locale = locale
        formatter.calendar = calendar

        if calendar.isDateInToday(date) {
            formatter.setLocalizedDateFormatFromTemplate("jmm")
        } else if calendar.isDateInYesterday(date) {
            // A relative word beats "Tue" when it is the day before.
            let relative = RelativeDateTimeFormatter()
            relative.locale = locale
            relative.dateTimeStyle = .named
            relative.unitsStyle = .short
            return relative.localizedString(from: DateComponents(day: -1))
        } else if let weekAgo = calendar.date(byAdding: .day, value: -6, to: now), date > weekAgo {
            formatter.setLocalizedDateFormatFromTemplate("EEE")
        } else if calendar.isDate(date, equalTo: now, toGranularity: .year) {
            formatter.setLocalizedDateFormatFromTemplate("dMMM")
        } else {
            formatter.setLocalizedDateFormatFromTemplate("dMMMyy")
        }

        return formatter.string(from: date)
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

        let formatter = DateFormatter()
        formatter.locale = locale
        formatter.calendar = calendar
        if calendar.isDate(date, equalTo: now, toGranularity: .year) {
            formatter.setLocalizedDateFormatFromTemplate("EEEEdMMMM")
        } else {
            formatter.setLocalizedDateFormatFromTemplate("dMMMMyyyy")
        }
        return formatter.string(from: date)
    }

    /// The clock time under a chat bubble.
    static func bubbleTime(_ date: Date?, locale: Locale) -> String {
        guard let date else { return "" }
        let formatter = DateFormatter()
        formatter.locale = locale
        formatter.setLocalizedDateFormatFromTemplate("jmm")
        return formatter.string(from: date)
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
