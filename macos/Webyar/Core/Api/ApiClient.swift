import Foundation

enum ApiFailure: Sendable {
    /// No answer: offline, DNS, TLS, timeout.
    case transport
    /// 401 — the session is gone. The only failure that signs the operator out.
    case unauthorized
    /// Any other non-2xx. A 403 means "not this", never "sign out".
    case server
    /// A 2xx whose body is not what the model expects.
    case decoding
}

struct ApiError: Error, Sendable, CustomStringConvertible {
    let failure: ApiFailure
    var status: Int?
    /// The server's own `error` string, when it sent one.
    var serverMessage: String?
    var body: String?
    var underlying: String?

    var description: String {
        "ApiError(\(failure), status: \(status.map(String.init) ?? "-"), \(serverMessage ?? underlying ?? ""))"
    }
}

extension Error {
    var apiError: ApiError? { self as? ApiError }
    var isTransport: Bool { apiError?.failure == .transport }
    var isUnauthorized: Bool { apiError?.failure == .unauthorized }
}

/// Where the Bearer session token lives between launches: the Keychain in the
/// app, memory in tests.
protocol SessionStore: AnyObject {
    func read() -> String?
    func write(_ token: String?)
}

final class MemorySessionStore: SessionStore {
    private var token: String?
    init(_ token: String? = nil) { self.token = token }
    func read() -> String? { token }
    func write(_ token: String?) { self.token = token }
}

/// One HTTP client for the whole app. Bearer transport, like the iOS and
/// Windows apps: the login asks for `client: "mobile"`, which the server
/// honours only for a request with no Origin header — which a native client
/// never sends.
@MainActor
final class ApiClient {
    /// The bootstrap the very first request goes to — the same one every native build compiles in.
    static let defaultOrigin = AppBrand.apiOrigin

    typealias Query = [(String, String?)]

    private let session: URLSession
    private let store: SessionStore
    private(set) var origin: URL
    private let userAgent: String

    /// Called on any 401, wherever it comes from, so the app can return to the sign-in screen.
    var onUnauthorized: (() -> Void)?

    init(store: SessionStore, origin: URL? = nil, appVersion: String = "0", session: URLSession? = nil) {
        self.store = store
        // A remembered origin this brand may not use (RESPOK: outside respok.app) is ignored.
        self.origin = origin.flatMap(Self.normalized) ?? Self.defaultOrigin
        let os = ProcessInfo.processInfo.operatingSystemVersion
        userAgent = "Mozilla/5.0 (Macintosh; Mac OS X \(os.majorVersion)_\(os.minorVersion)) \(AppBrand.agentToken)/\(appVersion)"
        if let session {
            self.session = session
        } else {
            let config = URLSessionConfiguration.default
            config.httpCookieStorage = nil
            config.httpShouldSetCookies = false
            config.urlCache = nil
            config.waitsForConnectivity = false
            self.session = URLSession(configuration: config)
        }
    }

    var hasSession: Bool { !(store.read() ?? "").isEmpty }
    var token: String? { store.read() }

    func setOrigin(_ url: URL) {
        if let u = Self.normalized(url) { origin = u }
    }

    /// `https://host[:port]` of `url`, or nil when it is not https or not this brand's
    /// (`AppBrand.ownsOrigin`).
    static func normalized(_ url: URL) -> URL? {
        guard AppBrand.ownsOrigin(url), let host = url.host else { return nil }
        var c = URLComponents()
        c.scheme = "https"
        c.host = host
        c.port = url.port
        return c.url
    }

    // MARK: Requests

    func get<T: Decodable>(_ path: String, query: Query = [], as type: T.Type = T.self) async throws -> T {
        try await send("GET", path, query: query, body: nil, as: type)
    }

    func post<T: Decodable>(_ path: String, body: [String: Any?]? = nil, query: Query = [], as type: T.Type = T.self) async throws -> T {
        try await send("POST", path, query: query, body: body, as: type)
    }

    /// A request whose answer is not needed.
    /// `timeout` longer for a file sent as JSON: the server stores it before it answers.
    func call(_ method: String, _ path: String, body: [String: Any?]? = nil, query: Query = [], timeout: TimeInterval = 20) async throws {
        _ = try await raw(method, path, query: query, body: body, timeout: timeout)
    }

    func send<T: Decodable>(_ method: String, _ path: String, query: Query = [], body: [String: Any?]?, as type: T.Type = T.self) async throws -> T {
        let (data, status) = try await raw(method, path, query: query, body: body, timeout: 20)
        do {
            return try JSON.decoder().decode(T.self, from: data.isEmpty ? Data("null".utf8) : data)
        } catch {
            Log.write("[api] decode \(path): \(error)")
            throw ApiError(failure: .decoding, status: status, underlying: String(describing: error))
        }
    }

    func bytes(_ path: String) async throws -> Data {
        try await raw("GET", path, query: [], body: nil, timeout: 60).0
    }

    /// Raw bytes as the request body (a file upload), answered with JSON.
    func upload<T: Decodable>(_ path: String, query: Query = [], data: Data, contentType: String, as type: T.Type = T.self) async throws -> T {
        let (answer, status) = try await raw("POST", path, query: query, body: nil, timeout: 120, upload: (data, contentType))
        do {
            return try JSON.decoder().decode(T.self, from: answer)
        } catch {
            throw ApiError(failure: .decoding, status: status, underlying: String(describing: error))
        }
    }

    /// A GET that revalidates what the caller already has: `etag` goes out as If-None-Match, and a
    /// 304 comes back as `notModified` with no body instead of as an error. The app keeps its own
    /// copy (LocalStore) rather than a URLCache, so nothing else on this client is cached.
    struct Conditional: Sendable {
        var data: Data
        var etag: String?
        var notModified: Bool
    }

    func conditionalGet(_ path: String, query: Query = [], etag: String?) async throws -> Conditional {
        var headers: [String: String] = [:]
        if let etag, !etag.isEmpty { headers["If-None-Match"] = etag }
        let (data, response) = try await exchange("GET", path, query: query, body: nil, timeout: 20, headers: headers, accept304: true)
        let status = response?.statusCode ?? 0
        let tag = response?.value(forHTTPHeaderField: "ETag")
        return Conditional(data: data, etag: tag ?? (status == 304 ? etag : nil), notModified: status == 304)
    }

    private func raw(_ method: String, _ path: String, query: Query, body: [String: Any?]?, timeout: TimeInterval, upload: (Data, String)? = nil) async throws -> (Data, Int) {
        let (data, response) = try await exchange(method, path, query: query, body: body, timeout: timeout, upload: upload)
        return (data, response?.statusCode ?? 0)
    }

    private func exchange(_ method: String, _ path: String, query: Query, body: [String: Any?]?, timeout: TimeInterval, upload: (Data, String)? = nil,
                          headers: [String: String] = [:], accept304: Bool = false) async throws -> (Data, HTTPURLResponse?) {
        precondition(path.hasPrefix("/api/"), "Only /api/ paths are allowed.")
        var components = URLComponents(url: origin, resolvingAgainstBaseURL: false)!
        components.percentEncodedPath = path
        let items = query.compactMap { k, v in v.map { URLQueryItem(name: k, value: $0) } }
        if !items.isEmpty {
            components.percentEncodedQuery = items.map { "\(Self.escape($0.name))=\(Self.escape($0.value ?? ""))" }.joined(separator: "&")
        }
        guard let url = components.url else { throw ApiError(failure: .transport, underlying: "bad url \(path)") }
        var request = URLRequest(url: url, timeoutInterval: timeout)
        request.httpMethod = method
        request.setValue(userAgent, forHTTPHeaderField: "User-Agent")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        let sentToken = store.read()
        if let token = sentToken, !token.isEmpty {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        for (k, v) in headers { request.setValue(v, forHTTPHeaderField: k) }
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: Self.clean(body), options: [])
        } else if case let (data, type)? = upload {
            request.setValue(type, forHTTPHeaderField: "Content-Type")
            request.httpBody = data
        }

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch is CancellationError {
            throw CancellationError()
        } catch let e as URLError where e.code == .cancelled {
            throw CancellationError()
        } catch {
            throw ApiError(failure: .transport, underlying: error.localizedDescription)
        }
        let http = response as? HTTPURLResponse
        let status = http?.statusCode ?? 0
        if (200..<300).contains(status) || (accept304 && status == 304) { return (data, http) }
        let text = String(data: data, encoding: .utf8)
        if status == 401 {
            // Only for the session this went out with: a slow request from before a new sign-in
            // must not sign the new session out (and delete its token).
            if store.read() == sentToken { onUnauthorized?() }
            throw ApiError(failure: .unauthorized, status: 401, body: text)
        }
        var message: String?
        if let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any], let err = obj["error"] as? String {
            message = err
        }
        throw ApiError(failure: .server, status: status, serverMessage: message, body: text)
    }

    /// `[String: Any?]` with the nils dropped (and nested ones too), as the
    /// Windows client's `WhenWritingNull` does — except `NSNull()`, which is an
    /// explicit JSON null the caller asked for.
    private static func clean(_ dict: [String: Any?]) -> [String: Any] {
        var out: [String: Any] = [:]
        for (k, v) in dict {
            guard let v else { continue }
            if let nested = v as? [String: Any?] { out[k] = clean(nested) } else { out[k] = v }
        }
        return out
    }

    /// RFC 3986's unreserved characters, ASCII only: `alphanumerics` would let Persian or Turkish
    /// letters through unencoded, and a query with them in it is refused by URLComponents.
    private static let allowed = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")

    static func escape(_ s: String) -> String {
        s.addingPercentEncoding(withAllowedCharacters: allowed) ?? s
    }

    // MARK: Session

    private struct LoginResponse: Decodable {
        let sessionToken: String?
        let user: User?
    }

    /// Signs in and keeps the Bearer token. Returns the signed-in user.
    func login(email: String, password: String) async throws -> User {
        let r: LoginResponse = try await post("/api/auth/login", body: ["email": email, "password": password, "client": "mobile"])
        guard let token = r.sessionToken, !token.isEmpty, let user = r.user else { throw ApiError(failure: .decoding) }
        store.write(token)
        return user
    }

    /// Only a confirmed revocation, or a session the server no longer knows, clears the token.
    func logout() async throws {
        do {
            try await call("POST", "/api/auth/logout")
        } catch let e as ApiError where e.failure == .unauthorized {
        }
        store.write(nil)
    }

    func discardSession() { store.write(nil) }

    /// Asks the platform where it lives and moves there if the answer differs,
    /// as the other native apps do at launch.
    @discardableResult
    ///
    /// The fallback matters, as on iOS, Android and Windows: if the origin this Mac
    /// remembered has gone dark (a domain typed wrong in Super Admin, a lapsed
    /// certificate) the built-in one is asked instead, and once it answers the Mac
    /// moves back to it. Without that, one bad edit would brick every installed
    /// copy for good, even after Super Admin was put right.
    func refreshOrigin() async -> PlatformOrigins? {
        if let origins = await askOrigins(at: origin) {
            adopt(origins, unless: nil)
            return origins
        }
        let failed = origin
        guard failed != Self.defaultOrigin else { return nil }
        // Left only once the built-in origin answers: offline, neither does, and
        // the remembered origin is not the one at fault.
        guard let origins = await askOrigins(at: Self.defaultOrigin) else { return nil }
        Log.write("[api] \(failed.absoluteString) does not answer: back to \(Self.defaultOrigin.absoluteString)")
        origin = Self.defaultOrigin
        // The platform may still name the origin that just failed: stay on the one that answers.
        adopt(origins, unless: failed)
        return origins
    }

    private func adopt(_ origins: PlatformOrigins, unless failed: URL?) {
        guard let api = origins.apiBaseUrl.flatMap(URL.init(string:)).flatMap(Self.normalized),
              api != origin, api != failed
        else { return }
        origin = api
    }

    /// Its own request rather than `get`: it carries no session (the route is public),
    /// so a host we are about to stop trusting never sees the token, and a 401 from it
    /// never signs the operator out.
    private func askOrigins(at base: URL) async -> PlatformOrigins? {
        var components = URLComponents(url: base, resolvingAgainstBaseURL: false)
        components?.percentEncodedPath = "/api/platform/origins"
        guard let url = components?.url else { return nil }
        var request = URLRequest(url: url, timeoutInterval: 8)
        request.setValue(userAgent, forHTTPHeaderField: "User-Agent")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        guard let (data, response) = try? await session.data(for: request),
              let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode)
        else { return nil }
        return try? JSON.decoder().decode(PlatformOrigins.self, from: data)
    }

    /// An absolute URL for a server path such as `/storage/…`.
    func absolute(_ path: String) -> URL? {
        if path.hasPrefix("https://") || path.hasPrefix("http://") { return URL(string: path) }
        // A protocol-relative CDN link ("//cdn.example.com/…").
        if path.hasPrefix("//") { return URL(string: "https:" + path) }
        if path.hasPrefix("/") { return URL(string: path, relativeTo: origin)?.absoluteURL }
        return nil
    }
}

/// `GET /api/platform/origins` — where the platform actually lives.
struct PlatformOrigins: Codable, Sendable {
    var apiBaseUrl: String?
    var supportUrl: String?
    var helpCenterUrl: String?
    var publicBaseUrl: String?
}
