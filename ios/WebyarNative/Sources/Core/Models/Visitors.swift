import Foundation

// MARK: - Online visitors (`/api/visitor-intel`)
//
// The shapes the web console's Visitors page reads, as
// `server/services/visitors/intelligence.ts` builds them. Snake case on the
// wire and no key strategy on the app's decoder, so every key is spelled out.
//
// Every field is decoded leniently. The list is a live view of other people's
// browsers — a user agent nobody parsed, a geo provider that answered half a
// row — and one odd visitor must never cost the operator the whole list. So a
// value that does not read is simply absent, and the row still shows.
//
// Each type's decoder lives in an extension, which keeps the memberwise
// initialiser for the sample backend and the tests to build fixtures with.

/// Whether a visitor is on the page now, stepped away, or gone.
///
/// The server also says `unknown` for a presence row it could not place; the
/// web files that with offline, and so does this — a dot that claims somebody
/// is there must only ever be green when they are.
enum VisitorPresence: String, Sendable, Hashable, CaseIterable {
    case online, idle, offline

    init(serverValue: String?) {
        self = VisitorPresence(rawValue: serverValue ?? "") ?? .offline
    }
}

/// Where the visitor's IP resolved to.
struct VisitorGeo: Hashable, Sendable {
    var country: String?
    var countryCode: String?
    var region: String?
    var city: String?
    var latitude: Double?
    var longitude: Double?
    /// Which provider placed them — `ip`, `browser`, `none`…
    var source: String?

    init(
        country: String? = nil, countryCode: String? = nil, region: String? = nil, city: String? = nil,
        latitude: Double? = nil, longitude: Double? = nil, source: String? = nil
    ) {
        self.country = country
        self.countryCode = countryCode
        self.region = region
        self.city = city
        self.latitude = latitude
        self.longitude = longitude
        self.source = source
    }
}

extension VisitorGeo: Decodable {
    enum CodingKeys: String, CodingKey {
        case country, region, city, latitude, longitude, source
        case countryCode = "country_code"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        country = c.lenientString(.country)
        countryCode = c.lenientString(.countryCode)
        region = c.lenientString(.region)
        city = c.lenientString(.city)
        latitude = c.lenientDouble(.latitude)
        longitude = c.lenientDouble(.longitude)
        source = c.lenientString(.source)
    }
}

/// The contact a visitor is already linked to, when there is one.
struct VisitorContactRef: Hashable, Sendable {
    var id: String
    var name: String?
    var email: String?
    var avatarURL: String?
    /// The short code the widget gave this visitor — `visitor_code`, or the
    /// `anon_code` older rows keep in their metadata, as the web resolves it.
    var code: String?

    init(id: String, name: String? = nil, email: String? = nil, avatarURL: String? = nil, code: String? = nil) {
        self.id = id
        self.name = name
        self.email = email
        self.avatarURL = avatarURL
        self.code = code
    }
}

extension VisitorContactRef: Decodable {
    enum CodingKeys: String, CodingKey {
        case id, name, email, metadata
        case avatarURL = "avatar_url"
        case visitorCode = "visitor_code"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = c.lenientString(.name)
        email = c.lenientString(.email)
        avatarURL = c.lenientString(.avatarURL)
        let direct = c.lenientString(.visitorCode)?.trimmingCharacters(in: .whitespaces)
        if let direct, !direct.isEmpty {
            code = direct
        } else {
            let metadata = try? c.decodeIfPresent(JSONValue.self, forKey: .metadata)
            code = metadata?["anon_code"]?.stringValue
        }
    }
}

/// The conversation a visitor is already in.
struct VisitorConversationRef: Hashable, Sendable {
    var id: String
    var status: String?
    var subject: String?

    init(id: String, status: String? = nil, subject: String? = nil) {
        self.id = id
        self.status = status
        self.subject = subject
    }
}

extension VisitorConversationRef: Decodable {
    enum CodingKeys: String, CodingKey { case id, status, subject }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        status = c.lenientString(.status)
        subject = c.lenientString(.subject)
    }
}

/// One live visitor session. `id` is the session id — the key the page
/// history, the map and "start chat" all take.
struct LiveVisitor: Identifiable, Hashable, Sendable {
    var id: String
    var visitorID: String?
    var presence: VisitorPresence
    var currentPage: String?
    var lastActivityAt: Date?
    var startedAt: Date?
    var browser: String?
    var device: String?
    var os: String?
    var referrer: String?
    var geo: VisitorGeo?
    /// Always what the server lets this operator see: masked, or a stand-in
    /// when the plan does not include IP visibility. The app never decides.
    var ipDisplay: String?
    var ipLocked: Bool
    var contact: VisitorContactRef?
    var conversation: VisitorConversationRef?

    init(
        id: String, visitorID: String? = nil, presence: VisitorPresence = .online,
        currentPage: String? = nil, lastActivityAt: Date? = nil, startedAt: Date? = nil,
        browser: String? = nil, device: String? = nil, os: String? = nil, referrer: String? = nil,
        geo: VisitorGeo? = nil, ipDisplay: String? = nil, ipLocked: Bool = false,
        contact: VisitorContactRef? = nil, conversation: VisitorConversationRef? = nil
    ) {
        self.id = id
        self.visitorID = visitorID
        self.presence = presence
        self.currentPage = currentPage
        self.lastActivityAt = lastActivityAt
        self.startedAt = startedAt
        self.browser = browser
        self.device = device
        self.os = os
        self.referrer = referrer
        self.geo = geo
        self.ipDisplay = ipDisplay
        self.ipLocked = ipLocked
        self.contact = contact
        self.conversation = conversation
    }
}

extension LiveVisitor: Decodable {
    enum CodingKeys: String, CodingKey {
        case id, status, browser, device, os, referrer, geo, contact, conversation
        case visitorID = "visitor_id"
        case currentPage = "current_page"
        case lastActivityAt = "last_activity_at"
        case startedAt = "started_at"
        case ipDisplay = "ip_display"
        case ipLocked = "ip_locked"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        visitorID = c.lenientString(.visitorID)
        presence = VisitorPresence(serverValue: c.lenientString(.status))
        currentPage = c.lenientString(.currentPage)
        lastActivityAt = c.lenientDate(.lastActivityAt)
        startedAt = c.lenientDate(.startedAt)
        browser = c.lenientString(.browser)
        device = c.lenientString(.device)
        os = c.lenientString(.os)
        referrer = c.lenientString(.referrer)
        geo = try? c.decodeIfPresent(VisitorGeo.self, forKey: .geo)
        ipDisplay = c.lenientString(.ipDisplay)
        ipLocked = ((try? c.decodeIfPresent(Bool.self, forKey: .ipLocked)) ?? false)
        contact = try? c.decodeIfPresent(VisitorContactRef.self, forKey: .contact)
        conversation = try? c.decodeIfPresent(VisitorConversationRef.self, forKey: .conversation)
    }
}

/// `GET /api/visitor-intel/live` → `{ items }`.
///
/// Rows are decoded one at a time, so a visitor the app cannot read is
/// dropped rather than failing everyone else on the list.
struct LiveVisitorsResponse: Decodable, Sendable {
    let items: [LiveVisitor]

    enum CodingKeys: String, CodingKey { case items }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let rows = try? c.decodeIfPresent([LenientRow<LiveVisitor>].self, forKey: .items)
        items = (rows ?? []).compactMap(\.value)
    }
}

// MARK: - Page history

/// One page a visitor looked at.
struct VisitorPageView: Hashable, Sendable {
    var url: String?
    var title: String?
    var viewedAt: Date?

    init(url: String? = nil, title: String? = nil, viewedAt: Date? = nil) {
        self.url = url
        self.title = title
        self.viewedAt = viewedAt
    }
}

extension VisitorPageView: Decodable {
    // `id` is on the wire too — a bigint on some deployments, a uuid on
    // others — and nothing here needs it, so it is not read at all.
    enum CodingKeys: String, CodingKey {
        case url, title
        case viewedAt = "viewed_at"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        url = c.lenientString(.url)
        title = c.lenientString(.title)
        viewedAt = c.lenientDate(.viewedAt)
    }
}

/// Where the visit began: the landing page and what sent them there.
struct VisitorPageEntry: Hashable, Sendable {
    var landingURL: String?
    var landingTitle: String?
    var landedAt: Date?
    var referrer: String?

    init(landingURL: String? = nil, landingTitle: String? = nil, landedAt: Date? = nil, referrer: String? = nil) {
        self.landingURL = landingURL
        self.landingTitle = landingTitle
        self.landedAt = landedAt
        self.referrer = referrer
    }
}

extension VisitorPageEntry: Decodable {
    enum CodingKeys: String, CodingKey {
        case referrer
        case landingURL = "landing_url"
        case landingTitle = "landing_title"
        case landedAt = "landed_at"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        landingURL = c.lenientString(.landingURL)
        landingTitle = c.lenientString(.landingTitle)
        landedAt = c.lenientDate(.landedAt)
        referrer = c.lenientString(.referrer)
    }
}

/// `GET /api/visitor-intel/:sessionId/page-history` → `{ items, entry, current }`.
///
/// `items` is most recent first, as the server orders them.
struct VisitorPageHistory: Hashable, Sendable {
    var items: [VisitorPageView]
    var entry: VisitorPageEntry?
    var current: VisitorPageView?

    init(items: [VisitorPageView] = [], entry: VisitorPageEntry? = nil, current: VisitorPageView? = nil) {
        self.items = items
        self.entry = entry
        self.current = current
    }
}

extension VisitorPageHistory: Decodable {
    enum CodingKeys: String, CodingKey { case items, entry, current }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let rows = try? c.decodeIfPresent([LenientRow<VisitorPageView>].self, forKey: .items)
        items = (rows ?? []).compactMap(\.value)
        entry = try? c.decodeIfPresent(VisitorPageEntry.self, forKey: .entry)
        current = try? c.decodeIfPresent(VisitorPageView.self, forKey: .current)
    }
}

// MARK: - Map

/// A dot on the visitors map.
struct VisitorMapMarker: Identifiable, Hashable, Sendable {
    var id: String
    var presence: VisitorPresence
    var latitude: Double
    var longitude: Double
    var country: String?
    var countryCode: String?
    var city: String?
    var currentPage: String?

    init(
        id: String, presence: VisitorPresence, latitude: Double, longitude: Double,
        country: String? = nil, countryCode: String? = nil, city: String? = nil, currentPage: String? = nil
    ) {
        self.id = id
        self.presence = presence
        self.latitude = latitude
        self.longitude = longitude
        self.country = country
        self.countryCode = countryCode
        self.city = city
        self.currentPage = currentPage
    }

    /// A visitor's own coordinates, for the moment before the map endpoint
    /// has answered — so the map is never blank while the list is not.
    init?(visitor: LiveVisitor) {
        guard let lat = visitor.geo?.latitude, let lng = visitor.geo?.longitude else { return nil }
        self.init(
            id: visitor.id, presence: visitor.presence, latitude: lat, longitude: lng,
            country: visitor.geo?.country, countryCode: visitor.geo?.countryCode,
            city: visitor.geo?.city, currentPage: visitor.currentPage
        )
    }

    /// "City, Country", whatever of it is known.
    var place: String {
        [city, country]
            .compactMap { $0?.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
            .joined(separator: ", ")
    }
}

extension VisitorMapMarker: Decodable {
    enum CodingKeys: String, CodingKey {
        case id, status, lat, lng, country, city
        case countryCode = "country_code"
        case currentPage = "current_page"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        guard let lat = c.lenientDouble(.lat), let lng = c.lenientDouble(.lng),
              (-90...90).contains(lat), (-180...180).contains(lng)
        else {
            throw DecodingError.dataCorruptedError(forKey: .lat, in: c, debugDescription: "No usable coordinates")
        }
        latitude = lat
        longitude = lng
        id = c.lenientString(.id) ?? "\(lat),\(lng)"
        presence = VisitorPresence(serverValue: c.lenientString(.status))
        country = c.lenientString(.country)
        countryCode = c.lenientString(.countryCode)
        city = c.lenientString(.city)
        currentPage = c.lenientString(.currentPage)
    }
}

/// `GET /api/visitor-intel/map` → `{ markers, total, without_location, source_counts }`.
struct VisitorMap: Hashable, Sendable {
    var markers: [VisitorMapMarker]
    var total: Int
    /// Visitors the server could not place — said under the map, so an
    /// empty-looking map is not mistaken for an empty site.
    var withoutLocation: Int

    init(markers: [VisitorMapMarker] = [], total: Int = 0, withoutLocation: Int = 0) {
        self.markers = markers
        self.total = total
        self.withoutLocation = withoutLocation
    }
}

extension VisitorMap: Decodable {
    enum CodingKeys: String, CodingKey {
        case markers, total
        case withoutLocation = "without_location"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let rows = try? c.decodeIfPresent([LenientRow<VisitorMapMarker>].self, forKey: .markers)
        markers = (rows ?? []).compactMap(\.value)
        total = c.lenientInt(.total) ?? markers.count
        withoutLocation = c.lenientInt(.withoutLocation) ?? 0
    }
}

/// `POST /api/conversations/start-from-visitor` → `{ ok, conversation_id, created }`.
///
/// `created` is false when the server handed back the visitor's open
/// conversation instead of starting a second one.
struct StartVisitorChatResult: Decodable, Hashable, Sendable {
    var conversationID: String?
    var created: Bool?

    init(conversationID: String?, created: Bool?) {
        self.conversationID = conversationID
        self.created = created
    }

    enum CodingKeys: String, CodingKey {
        case created
        case conversationID = "conversation_id"
    }
}

// MARK: - Lenient decoding

/// One element of an array that is kept only if it decodes, so a single bad
/// row does not throw the rest away.
struct LenientRow<Value: Decodable>: Decodable {
    let value: Value?

    init(from decoder: Decoder) throws {
        value = try? Value(from: decoder)
    }
}

extension KeyedDecodingContainer {
    /// A string, or nil for anything else — including `null`, a number, or a
    /// blank value that would otherwise show as an empty line.
    func lenientString(_ key: Key) -> String? {
        guard let value = try? decodeIfPresent(String.self, forKey: key) else { return nil }
        return value.isEmpty ? nil : value
    }

    /// A number the server may have sent as a JSON number or as a string —
    /// Postgres `numeric` columns arrive as strings through some drivers.
    func lenientDouble(_ key: Key) -> Double? {
        if let number = try? decodeIfPresent(Double.self, forKey: key), number.isFinite { return number }
        if let text = try? decodeIfPresent(String.self, forKey: key), let number = Double(text), number.isFinite {
            return number
        }
        return nil
    }

    func lenientInt(_ key: Key) -> Int? {
        if let number = try? decodeIfPresent(Int.self, forKey: key) { return number }
        return lenientDouble(key).flatMap { Int(exactly: $0.rounded()) }
    }

    /// A timestamp the app's decoder understands, or nil — never a thrown
    /// error that would drop the whole row over one odd date.
    func lenientDate(_ key: Key) -> Date? {
        try? decodeIfPresent(Date.self, forKey: key)
    }
}
