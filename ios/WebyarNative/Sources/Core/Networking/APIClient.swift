import Foundation

/// Every way a request can fail, in the terms the UI needs to react.
///
/// The distinction that matters most is `unauthorized` versus `transport`: the
/// first means the session is genuinely gone and the operator must sign in
/// again; the second means we simply could not ask. Treating a dropped
/// connection as a logout would throw away a perfectly good session every time
/// someone walks into a lift.
enum APIError: Error, Equatable, Sendable {
    /// The server rejected our credentials, or the session was revoked.
    case unauthorized
    /// We never got an answer — offline, DNS, timeout, TLS.
    case transport
    /// The server answered with a failure and, where it gave one, a message.
    case server(status: Int, message: String?)
    /// The answer did not match what this version of the app understands.
    case decoding

    var isAuthFailure: Bool { self == .unauthorized }
}

/// Talks to the same REST API the web client uses.
///
/// Native sessions use `Authorization: Bearer <opaque token>` — the server
/// runs the identical security flow it runs for the web's cookie session and
/// simply returns the token in the login response body instead
/// (`server/lib/sessionTransport.ts`).
actor APIClient {

    static let shared = APIClient()

    private let baseURL: URL
    private let session: URLSession
    private let decoder: JSONDecoder
    private let encoder: JSONEncoder

    /// Set on login, cleared on a *confirmed* logout. Held in memory so the
    /// Keychain is not read on every single request.
    private var token: String?

    init(baseURL: URL = GeneratedConfig.apiBaseURL) {
        self.baseURL = baseURL

        let config = URLSessionConfiguration.default
        // A hung request is worse than a failed one: the operator is left
        // staring at a spinner. Fail fast enough to show a retry affordance.
        config.timeoutIntervalForRequest = 20
        config.timeoutIntervalForResource = 60
        config.waitsForConnectivity = false
        // The session token is the auth; cookies would only add a second,
        // confusing transport.
        config.httpCookieAcceptPolicy = .never
        config.httpShouldSetCookies = false
        self.session = URLSession(configuration: config)

        let dec = JSONDecoder()
        dec.dateDecodingStrategy = .custom { decoder in
            let raw = try decoder.singleValueContainer().decode(String.self)
            guard let date = DateParsing.parse(raw) else {
                throw DecodingError.dataCorrupted(
                    .init(codingPath: decoder.codingPath, debugDescription: "Unrecognised date: \(raw)")
                )
            }
            return date
        }
        self.decoder = dec

        let enc = JSONEncoder()
        enc.dateEncodingStrategy = .iso8601
        self.encoder = enc

        self.token = TokenStore.read()
    }

    // MARK: - Session lifecycle

    var hasToken: Bool { token != nil }

    func setToken(_ value: String?) {
        token = value
        if let value { TokenStore.save(value) } else { TokenStore.delete() }
    }

    // MARK: - Request plumbing

    private func makeRequest(
        _ method: String,
        _ path: String,
        query: [URLQueryItem] = [],
        body: (any Encodable & Sendable)? = nil
    ) throws -> URLRequest {
        guard var components = URLComponents(url: baseURL.appendingPathComponent(path), resolvingAgainstBaseURL: false) else {
            throw APIError.transport
        }
        if !query.isEmpty { components.queryItems = query }
        guard let url = components.url else { throw APIError.transport }

        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let token {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try encoder.encode(body)
        }
        return request
    }

    private func perform<T: Decodable>(_ request: URLRequest, as type: T.Type) async throws -> T {
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw APIError.transport
        }

        guard let http = response as? HTTPURLResponse else { throw APIError.transport }

        guard (200..<300).contains(http.statusCode) else {
            if http.statusCode == 401 || http.statusCode == 403 {
                throw APIError.unauthorized
            }
            let message = try? decoder.decode(ErrorResponse.self, from: data).error
            throw APIError.server(status: http.statusCode, message: message)
        }

        do {
            return try decoder.decode(T.self, from: data)
        } catch {
            throw APIError.decoding
        }
    }

    /// For endpoints whose body we do not need — only that they succeeded.
    private func performIgnoringBody(_ request: URLRequest) async throws {
        let response: URLResponse
        do {
            (_, response) = try await session.data(for: request)
        } catch {
            throw APIError.transport
        }
        guard let http = response as? HTTPURLResponse else { throw APIError.transport }
        guard (200..<300).contains(http.statusCode) else {
            if http.statusCode == 401 || http.statusCode == 403 { throw APIError.unauthorized }
            throw APIError.server(status: http.statusCode, message: nil)
        }
    }

    // MARK: - Auth

    private struct LoginBody: Encodable, Sendable {
        let email: String
        let password: String
        /// Asks the server for a Bearer-transport session instead of a cookie.
        let client = "mobile"
    }

    func logIn(email: String, password: String) async throws -> User {
        let request = try makeRequest("POST", "/api/auth/login", body: LoginBody(email: email, password: password))
        let result = try await perform(request, as: LoginResponse.self)

        guard let sessionToken = result.sessionToken, let user = result.user else {
            throw APIError.decoding
        }
        setToken(sessionToken)
        return user
    }

    /// Confirms the stored token still names a live session.
    func currentUser() async throws -> User {
        guard token != nil else { throw APIError.unauthorized }
        let request = try makeRequest("GET", "/api/auth/session")
        let result = try await perform(request, as: SessionResponse.self)
        guard let user = result.user else { throw APIError.unauthorized }
        return user
    }

    /// Only a confirmed server-side revocation clears the token. A network
    /// failure here proves nothing, so the caller stays signed in and can
    /// retry — clearing locally would show a signed-out UI while a usable
    /// session still existed on the server.
    func logOut() async throws {
        let request = try makeRequest("POST", "/api/auth/logout")
        try await performIgnoringBody(request)
        setToken(nil)
    }

    /// Drops the local session without asking the server. Reserved for the one
    /// case where the server has already told us the session is void (401).
    func discardSession() {
        setToken(nil)
    }

    private struct ResetBody: Encodable, Sendable {
        let email: String
    }

    /// Asks the server to email a reset link.
    ///
    /// The response is deliberately not inspected for whether the address
    /// exists: the endpoint answers the same either way so that it cannot be
    /// used to discover which addresses have accounts, and the UI must not
    /// undo that by reporting a difference.
    func requestPasswordReset(email: String) async throws {
        let request = try makeRequest("POST", "/api/auth-email/send-reset", body: ResetBody(email: email))
        try await performIgnoringBody(request)
    }

    // MARK: - Workspaces

    func workspaces() async throws -> [Workspace] {
        let request = try makeRequest("GET", "/api/workspaces")
        return try await perform(request, as: WorkspacesResponse.self).workspaces
    }

    // MARK: - Conversations

    func conversations(workspaceID: String, filter: InboxFilter) async throws -> [Conversation] {
        var query = [
            URLQueryItem(name: "workspace_id", value: workspaceID),
            URLQueryItem(name: "queue", value: filter.queue),
        ]
        if let status = filter.status {
            query.append(URLQueryItem(name: "status", value: status))
        }
        let request = try makeRequest("GET", "/api/conversations", query: query)
        return try await perform(request, as: ConversationsResponse.self).conversations
    }

    func messages(conversationID: String) async throws -> [Message] {
        let request = try makeRequest("GET", "/api/conversations/\(conversationID)/messages")
        return try await perform(request, as: MessagesResponse.self).messages
    }

    private struct SendBody: Encodable, Sendable {
        let conversation_id: String
        let workspace_id: String
        let body: String
        /// The server collapses a replay of the same key instead of sending
        /// twice, which is what makes a retry safe. Must be 8–64 characters.
        let client_message_id: String
    }

    func send(body: String, conversationID: String, workspaceID: String, clientMessageID: String) async throws {
        let request = try makeRequest(
            "POST",
            "/api/conversations/send-message",
            body: SendBody(
                conversation_id: conversationID,
                workspace_id: workspaceID,
                body: body,
                client_message_id: clientMessageID
            )
        )
        try await performIgnoringBody(request)
    }

    /// Takes no body: the route authorises against the conversation's own
    /// `workspace_id`, so a client-supplied one could only ever disagree.
    func markSeen(conversationID: String) async throws {
        let request = try makeRequest("POST", "/api/conversations/\(conversationID)/seen")
        try await performIgnoringBody(request)
    }

    private struct StatusBody: Encodable, Sendable {
        let workspace_id: String
        let status: String
    }

    func setStatus(_ status: ConversationStatus, conversationID: String, workspaceID: String) async throws {
        let request = try makeRequest(
            "PATCH",
            "/api/conversations/\(conversationID)",
            body: StatusBody(workspace_id: workspaceID, status: status.rawValue)
        )
        try await performIgnoringBody(request)
    }

    // MARK: - Contacts

    func contacts(workspaceID: String) async throws -> [Contact] {
        let request = try makeRequest(
            "GET",
            "/api/contacts",
            query: [URLQueryItem(name: "workspace_id", value: workspaceID)]
        )
        return try await perform(request, as: ContactsResponse.self).contacts
    }
}

/// The three inbox filters, expressed the way the API wants them.
enum InboxFilter: String, CaseIterable, Identifiable, Sendable {
    case open
    case ai
    case resolved

    var id: String { rawValue }

    var queue: String {
        switch self {
        case .open, .resolved: "main"
        case .ai: "automated"
        }
    }

    var status: String? {
        switch self {
        case .open: "open"
        case .resolved: "resolved"
        case .ai: nil
        }
    }

    func title(_ language: Language) -> String {
        switch self {
        case .open: Str.filterOpen(language)
        case .ai: Str.filterAI(language)
        case .resolved: Str.filterResolved(language)
        }
    }
}

/// Timestamps arrive from Postgres in more than one shape — with and without
/// fractional seconds, occasionally with a space instead of `T`. Rather than
/// let one variant break an entire response, every known form is tried.
enum DateParsing {
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

    private static let postgres: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(secondsFromGMT: 0)
        f.dateFormat = "yyyy-MM-dd HH:mm:ss.SSSSSSZZZZZ"
        return f
    }()

    static func parse(_ raw: String) -> Date? {
        if let d = withFraction.date(from: raw) { return d }
        if let d = plain.date(from: raw) { return d }
        if let d = postgres.date(from: raw) { return d }
        return nil
    }
}
