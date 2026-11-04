import XCTest
@testable import Webyar

/// Answers `/api/platform/origins` for the hosts listed in `answers`; any other host does not answer.
private final class OriginsStub: URLProtocol {
    nonisolated(unsafe) static var answers: [String: String] = [:]
    nonisolated(unsafe) static var sawAuthorization = false

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        if request.value(forHTTPHeaderField: "Authorization") != nil { Self.sawAuthorization = true }
        guard let url = request.url, let host = url.host, let api = Self.answers[host] else {
            client?.urlProtocol(self, didFailWithError: URLError(.cannotFindHost))
            return
        }
        let body = Data(#"{"apiBaseUrl":"\#(api)"}"#.utf8)
        let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: body)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

/// A bad API URL from Super Admin must not brick the Mac app: a remembered origin that stops
/// answering is left for the built-in one, as on iOS, Android and Windows.
@MainActor
final class OriginFallbackTests: XCTestCase {
    private func client(at origin: URL?) -> ApiClient {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [OriginsStub.self]
        return ApiClient(store: MemorySessionStore("token"), origin: origin, session: URLSession(configuration: config))
    }

    private let builtIn = ApiClient.defaultOrigin
    private let typo = URL(string: "https://api.typo.example")!

    override func setUp() async throws {
        OriginsStub.answers = [:]
        OriginsStub.sawAuthorization = false
    }

    func testADarkRememberedOriginFallsBackToTheBuiltInOne() async {
        OriginsStub.answers = [builtIn.host!: builtIn.absoluteString]
        let api = client(at: typo)
        XCTAssertEqual(api.origin, typo)
        let answered = await api.refreshOrigin()
        XCTAssertNotNil(answered)
        XCTAssertEqual(api.origin, builtIn)
    }

    func testStaysOnTheBuiltInOriginWhileThePlatformStillNamesTheDarkOne() async {
        OriginsStub.answers = [builtIn.host!: typo.absoluteString]
        let api = client(at: typo)
        await api.refreshOrigin()
        XCTAssertEqual(api.origin, builtIn)
    }

    func testOfflineKeepsTheRememberedOrigin() async {
        let api = client(at: typo)
        let answered = await api.refreshOrigin()
        XCTAssertNil(answered)
        XCTAssertEqual(api.origin, typo)
    }

    func testMovesWhereAnAnsweringPlatformSays() async {
        let moved = URL(string: "https://api2.\(builtIn.host!)")!
        OriginsStub.answers = [builtIn.host!: moved.absoluteString]
        let api = client(at: nil)
        await api.refreshOrigin()
        XCTAssertEqual(api.origin, moved)
    }

    func testTheOriginsRequestCarriesNoSession() async {
        OriginsStub.answers = [builtIn.host!: builtIn.absoluteString]
        await client(at: nil).refreshOrigin()
        XCTAssertFalse(OriginsStub.sawAuthorization)
    }

    func testOnlyHttpsOrigins() {
        XCTAssertEqual(client(at: URL(string: "http://api.webyar.ai")!).origin, builtIn)
        XCTAssertNil(ApiClient.normalized(URL(string: "http://api.webyar.ai")!))
        XCTAssertEqual(ApiClient.normalized(URL(string: "https://api.webyar.ai/x?y")!), URL(string: "https://api.webyar.ai")!)
    }
}
