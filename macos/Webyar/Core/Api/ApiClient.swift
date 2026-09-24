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
    static let defaultOrigin = URL(string: "https://api.webyar.ai")!

    typealias Query = [(String, String?)]

    private let session: URLSession
    private let store: SessionStore
    private(set) var origin: URL
    private let userAgent: String

    /// Called on any 401, wherever it comes from, so the app can return to the sign-in screen.
    var onUnauthorized: (() -> Void)?

    init(store: SessionStore, origin: URL? = nil, appVersion: String = "0", session: URLSession? = nil) {
        self.store = store
        self.origin = origin ?? Self.defaultOrigin
        let os = ProcessInfo.processInfo.operatingSystemVersion
        userAgent = "Mozilla/5.0 (Macintosh; Mac OS X \(os.majorVersion)_\(os.minorVersion)) WebyarMac/\(appVersion)"
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
        guard url.scheme == "https", let host = url.host else { return }
        var c = URLComponents()
        c.scheme = "https"
        c.host = host
        c.port = url.port
        if let u = c.url { origin = u }
    }

    // MARK: Requests

    func get<T: Decodable>(_ path: String, query: Query = [], as type: T.Type = T.self) async throws -> T {
        try await send("GET", path, query: query, body: nil, as: type)
    }

    func post<T: Decodable>(_ path: String, body: [String: Any?]? = nil, query: Query = [], as type: T.Type = T.self) async throws -> T {
        try await send("POST", path, query: query, body: body, as: type)
    }

    /// A request whose answer is not needed.
    func call(_ method: String, _ path: String, body: [String: Any?]? = nil, query: Query = []) async throws {
        _ = try await raw(method, path, query: query, body: body, timeout: 20)
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

    private func raw(_ method: String, _ path: String, query: Query, body: [String: Any?]?, timeout: TimeInterval) async throws -> (Data, Int) {
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
        if let token = store.read(), !token.isEmpty {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: Self.clean(body), options: [])
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
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        if (200..<300).contains(status) { return (data, status) }
        let text = String(data: data, encoding: .utf8)
        if status == 401 {
            onUnauthorized?()
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

    private static let allowed: CharacterSet = {
        var s = CharacterSet.alphanumerics
        s.insert(charactersIn: "-._~")
        return s
    }()

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
    func refreshOrigin() async -> PlatformOrigins? {
        guard let origins: PlatformOrigins = try? await get("/api/platform/origins") else { return nil }
        if let api = origins.apiBaseUrl, let url = URL(string: api), url.scheme == "https" { setOrigin(url) }
        return origins
    }

    /// An absolute URL for a server path such as `/storage/…`.
    func absolute(_ path: String) -> URL? {
        if path.hasPrefix("https://") || path.hasPrefix("http://") { return URL(string: path) }
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
