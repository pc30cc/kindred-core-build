import Foundation

/// How conversations and messages read in lists and notifications — the same
/// rules as the other clients (windows-native/src/Webyar.Core/Inbox/Display.cs).
enum Display {
    static func contactName(_ contact: ConversationContact?, _ s: Strings, fallbackId: String? = nil) -> String {
        visitorName(name: contact?.name, code: contact?.visitorCode, fallbackId: fallbackId, city: nil, region: nil, countryCode: nil, s)
    }

    /// The name the web inbox shows: with the visitor's city once the network profile is known.
    static func conversationName(_ c: Conversation, _ s: Strings) -> String {
        visitorName(name: c.contacts?.name, code: c.contacts?.visitorCode, fallbackId: c.contactId ?? c.id,
                    city: c.visitorCity, region: c.visitorRegion, countryCode: c.visitorCountryCode, s)
    }

    /// The web console's contactDisplayName: the contact's own name, else
    /// "Visitor from {city} · {code}" (the province for Iran), else
    /// "Visitor · {code}". The code is the widget's, else a hash of the id,
    /// exactly as the server derives it.
    static func visitorName(name: String?, code: String?, fallbackId: String?, city: String?, region: String?, countryCode: String?, _ s: Strings) -> String {
        let n = (name ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if !n.isEmpty && n.lowercased() != "visitor" { return n }
        let c: String
        if let code, !code.isEmpty { c = code.trimmingCharacters(in: .whitespaces) }
        else if let fallbackId, !fallbackId.isEmpty { c = legacyCode(fallbackId) }
        else { c = "----" }
        let isolated = "\u{2068}" + c + "\u{2069}"
        let iran = countryCode?.trimmingCharacters(in: .whitespaces).uppercased() == "IR"
        let place = (iran ? region : city)?.trimmingCharacters(in: .whitespaces) ?? ""
        if place.isEmpty { return s.get("visitorAnonymous", "code", isolated) }
        return s.get(iran ? "visitorAnonymousFromRegion" : "visitorAnonymousFromCity",
                     ["code": isolated, iran ? "region" : "city": "\u{2068}" + place + "\u{2069}"])
    }

    /// server/services/widget/anonymousContact.ts anonCodeFrom: base-36 of a ×31 hash, last four.
    static func legacyCode(_ seed: String) -> String {
        var h: UInt32 = 0
        for ch in seed.utf16 { h = h &* 31 &+ UInt32(ch) }
        let digits = Array("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ")
        var out: [Character] = []
        repeat { out.insert(digits[Int(h % 36)], at: 0); h /= 36 } while h > 0
        while out.count < 4 { out.insert("0", at: 0) }
        return String(out.suffix(4))
    }

    /// Up to two letters for an avatar, from the first two words.
    static func initials(_ name: String) -> String {
        let words = name.split(separator: " ").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        guard let w0 = words.first, let first = w0.first.map(String.init) else { return "?" }
        if words.count == 1 { return first.uppercased() }
        let second = words[1].first.map(String.init) ?? ""
        // "بازدیدکننده 4ZTK" would render as a jumbled "ب4": mixed directions keep one letter.
        if isRightToLeft(first) != isRightToLeft(second) { return first.uppercased() }
        return (first + second).uppercased()
    }

    static func isRightToLeft(_ text: String) -> Bool {
        guard let u = text.unicodeScalars.first?.value else { return false }
        return (0x0590...0x08FF).contains(u) || (0xFB1D...0xFEFC).contains(u)
    }

    /// A one-line preview of the last message; attachments get a sentence instead of an empty line.
    static func preview(_ last: MessagePreview?, _ s: Strings) -> String {
        guard let last else { return "" }
        let body = oneLine(last.body)
        if !body.isEmpty { return body }
        guard let kind = last.attachmentKind, !kind.isEmpty else { return "" }
        return attachmentPreview(kind: kind, isMe: SenderType.isOperatorSide(last.senderType), senderName: last.senderName, s)
    }

    /// "You sent a photo" / "Sara sent a photo".
    static func attachmentPreview(kind: String, isMe: Bool, senderName: String?, _ s: Strings) -> String {
        let k: String
        switch kind {
        case "image": k = "Image"
        case "audio": k = "Audio"
        case "video": k = "Video"
        default: k = "File"
        }
        if isMe { return s["previewYouSent\(k)"] }
        let sender = (senderName ?? "").trimmingCharacters(in: .whitespaces)
        return s.get("previewSentBy\(k)", "name", sender.isEmpty ? s["previewSomeone"] : sender)
    }

    /// Any run of whitespace, line breaks included, becomes one space.
    static func oneLine(_ text: String?) -> String {
        (text ?? "").split(whereSeparator: { $0 == " " || $0 == "\r" || $0 == "\n" || $0 == "\t" || $0 == "\u{00A0}" }).joined(separator: " ")
    }

    private static func gregorian() -> Calendar {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = .current
        return c
    }

    /// The stamp beside a conversation: the time today, "Yesterday", the weekday
    /// within a week, otherwise the date — in the Persian calendar and digits for Persian.
    static func listStamp(_ when: Date, now: Date = Date(), _ s: Strings) -> String {
        let cal = gregorian()
        let day = cal.startOfDay(for: when), today = cal.startOfDay(for: now)
        let days = cal.dateComponents([.day], from: day, to: today).day ?? 0
        let text: String
        if days == 0 { text = clock(when) }
        else if days == 1 { text = s["yesterday"] }
        else if days > 1 && days < 7 {
            let f = DateFormatter()
            f.locale = s.language.locale
            f.dateFormat = "EEEE"
            text = f.string(from: when)
        } else { text = shortDate(when, s.language) }
        return Digits.localize(text, s.language)
    }

    /// The clock time under a chat bubble.
    static func clockTime(_ when: Date, _ language: Language) -> String {
        Digits.localize(clock(when), language)
    }

    private static func clock(_ when: Date) -> String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "HH:mm"
        return f.string(from: when)
    }

    static func shortDate(_ date: Date, _ language: Language) -> String {
        if language == .fa {
            var cal = Calendar(identifier: .persian)
            cal.timeZone = .current
            let c = cal.dateComponents([.year, .month, .day], from: date)
            return Digits.localize(String(format: "%d/%02d/%02d", c.year ?? 0, c.month ?? 0, c.day ?? 0), language)
        }
        let f = DateFormatter()
        f.locale = language.locale
        f.dateStyle = .short
        f.timeStyle = .none
        return f.string(from: date)
    }

    /// "Today", "Yesterday" or the date, for the line between days in a thread.
    static func dayLabel(_ date: Date, _ s: Strings) -> String {
        let cal = gregorian()
        if cal.isDateInToday(date) { return s["today"] }
        if cal.isDateInYesterday(date) { return s["yesterday"] }
        return shortDate(date, s.language)
    }

    /// Date and time in one line, for "started" and history rows.
    static func dateTime(_ date: Date, _ s: Strings) -> String {
        "\(shortDate(date, s.language)) \(clockTime(date, s.language))"
    }

    /// "4:05", or "1:02:09" past an hour.
    static func duration(_ seconds: Int, _ language: Language) -> String {
        let t = max(0, seconds)
        let h = t / 3600, m = t % 3600 / 60, sec = t % 60
        let text = h > 0 ? String(format: "%02d:%02d:%02d", h, m, sec) : String(format: "%02d:%02d", m, sec)
        return Digits.localize(text, language)
    }

    /// "12 KB" in the language's digits.
    static func fileSize(_ bytes: Int64, _ s: Strings) -> String {
        let value: String, unit: String
        if bytes < 1024 { value = String(bytes); unit = "unitBytes" }
        else if bytes < 1024 * 1024 { value = String(format: "%.0f", Double(bytes) / 1024); unit = "unitKilobytes" }
        else {
            let mb = Double(bytes) / 1024 / 1024
            value = mb == mb.rounded() ? String(format: "%.0f", mb) : String(format: "%.1f", mb)
            unit = "unitMegabytes"
        }
        return "\(Digits.localize(value, s.language)) \(s[unit])"
    }

    /// The web's channelLabel: brand names as they are, the widget translated.
    static func channelLabel(_ key: String, _ s: Strings) -> String {
        switch key {
        case "telegram": return "Telegram"
        case "bale": return "بله"
        case "whatsapp": return "WhatsApp"
        case "instagram": return "Instagram"
        case "x": return "X (Twitter)"
        case "email": return "Email"
        case "phone": return "Phone"
        case "widget": return s["channelWidget"]
        default: return key
        }
    }

    static func statusLabel(_ status: String, _ s: Strings) -> String {
        switch status {
        case ConversationStatus.open: return s["filterOpen"]
        case ConversationStatus.pending: return s["filterPending"]
        case ConversationStatus.resolved: return s["filterResolved"]
        case ConversationStatus.closed: return s["statusClosed"]
        default: return status
        }
    }

    static func priorityLabel(_ priority: String?, _ s: Strings) -> String {
        switch priority {
        case ConversationPriority.low: return s["priorityLow"]
        case ConversationPriority.high: return s["priorityHigh"]
        case ConversationPriority.urgent: return s["priorityUrgent"]
        default: return s["priorityNormal"]
        }
    }
}

/// The words an error shows — the same mapping as the other apps.
enum ErrorText {
    static func of(_ error: Error, _ s: Strings, unauthorized: String? = nil) -> String {
        guard let e = error as? ApiError else { return s["offlineBody"] }
        switch e.failure {
        case .transport: return s["offlineBody"]
        case .unauthorized: return unauthorized ?? s["sessionExpired"]
        case .decoding: return s["errorUnreadableAnswer"]
        case .server:
            if s.language == .en, let m = e.serverMessage, !m.isEmpty { return m }
            switch e.status ?? 500 {
            case 400, 422: return s["errorInvalidInput"]
            case 404: return s["errorNotFound"]
            case 409: return s["errorConflict"]
            case 429: return s["errorTooManyRequests"]
            case 400..<500: return s["errorNotAllowed"]
            default: return s["errorServerProblem"]
            }
        }
    }
}
