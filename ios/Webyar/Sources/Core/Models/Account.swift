import Foundation

/// The operator's own profile row. `GET /api/account/me`.
struct AccountProfile: Codable, Sendable {
    let id: String?
    let fullName: String?
    /// Derived server-side from the storage key for whichever provider is
    /// primary, so it is read-only here — an avatar is changed by uploading,
    /// never by setting a URL.
    let avatarURL: String?
    let preferredLocale: String?

    enum CodingKeys: String, CodingKey {
        case id
        case fullName = "full_name"
        case avatarURL = "avatar_url"
        case preferredLocale = "preferred_locale"
    }
}

struct Account: Codable, Sendable {
    let id: String
    let email: String?
    let phone: String?
    let emailConfirmedAt: String?
    let createdAt: Date?
    let profile: AccountProfile?

    enum CodingKeys: String, CodingKey {
        case id, email, phone
        case emailConfirmedAt = "email_confirmed_at"
        case createdAt = "created_at"
        case profile
    }

    var isEmailVerified: Bool { emailConfirmedAt != nil }

    var displayName: String {
        if let name = profile?.fullName, !name.trimmingCharacters(in: .whitespaces).isEmpty { return name }
        if let email, !email.isEmpty { return email }
        return "—"
    }
}

/// A signed-in device or browser. `GET /api/account/security/sessions`.
///
/// The server already parses the user agent into browser, OS and device and
/// resolves the IP to a city and country, so none of that is re-derived here —
/// a second parser in the client could only ever disagree with the one the web
/// console shows for the same session.
struct AccountSession: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let browser: String?
    let os: String?
    let device: String?
    let ip: String?
    let city: String?
    let country: String?
    let countryCode: String?
    let isCurrent: Bool?
    let createdAt: Date?
    let lastActiveAt: Date?

    enum CodingKeys: String, CodingKey {
        case id, browser, os, device, ip, city, country
        case countryCode = "country_code"
        case isCurrent = "is_current"
        case createdAt = "created_at"
        case lastActiveAt = "last_active_at"
    }

    /// "iPhone · Safari", or whichever parts the server managed to identify.
    ///
    /// Only the device *kind* is translated. The server says `Desktop`,
    /// `Mobile` or `Tablet` there whoever is asking, and the console
    /// translates exactly those three words; `macOS`, `Chrome` and `iPhone`
    /// are names and stay as they are in every language.
    func deviceLabel(_ language: Language) -> String {
        let parts = [Self.deviceKind(device, language), os, browser]
            .compactMap { $0?.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty && $0.lowercased() != "unknown" }
        // De-duplicated because `device` and `os` often say the same thing.
        var seen = Set<String>()
        let unique = parts.filter { seen.insert($0.lowercased()).inserted }
        return unique.isEmpty ? "—" : unique.joined(separator: " · ")
    }

    private static func deviceKind(_ raw: String?, _ language: Language) -> String? {
        switch raw?.trimmingCharacters(in: .whitespaces).lowercased() {
        case "desktop": Str.deviceDesktop(language)
        case "mobile": Str.deviceMobile(language)
        case "tablet": Str.deviceTablet(language)
        // Anything else is already a name — "iPhone", "Pixel 8".
        default: raw
        }
    }

    /// "Istanbul, Türkiye" when the server resolved it.
    var locationLabel: String? {
        let parts = [city, country]
            .compactMap { $0?.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
        return parts.isEmpty ? nil : parts.joined(separator: ", ")
    }
}

struct AccountSessionsResponse: Decodable, Sendable {
    let sessions: [AccountSession]
    let currentSessionId: String?

    enum CodingKeys: String, CodingKey {
        case sessions
        case currentSessionId = "current_session_id"
    }
}

struct AccountAvatarResponse: Decodable, Sendable {
    let success: Bool?
    let profile: AccountProfile?
}
