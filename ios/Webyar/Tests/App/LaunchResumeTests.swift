import Foundation
import XCTest
@testable import Webyar

/// A returning operator is let into the app from this phone's saved copy at
/// once, and the server is asked afterwards whether the session still stands.
/// Only a first launch — nothing saved — waits on the launch screen.
@MainActor
final class LaunchResumeTests: XCTestCase {
    private actor LaunchAPI: TestAPIBase {
        enum Answer { case user(User), unauthorized, offline }
        var answer: Answer = .offline
        var token = true
        private(set) var currentUserCalls = 0

        func set(_ answer: Answer) { self.answer = answer }
        func setToken(_ value: Bool) { token = value }

        var hasToken: Bool { get async { token } }

        func currentUser() async throws -> User {
            currentUserCalls += 1
            switch answer {
            case .user(let user): return user
            case .unauthorized: throw APIError.unauthorized
            case .offline: throw APIError.transport
            }
        }
    }

    private let saved = User(id: "u1", email: "sara@example.com", fullName: "Sara", emailVerified: true)

    override func setUp() async throws {
        SessionCache.clear()
    }

    override func tearDown() async throws {
        SessionCache.clear()
    }

    func testTheSavedAccountIsOnScreenBeforeAnyRequest() async {
        SessionCache.save(saved)
        let api = LaunchAPI()
        let appState = AppState(api: api)
        await appState.resumeSavedSession()
        XCTAssertEqual(appState.session, .signedIn(saved))
        let calls = await api.currentUserCalls
        XCTAssertEqual(calls, 0, "nothing waited on the server")
    }

    func testTheServerThenConfirmsTheSession() async {
        SessionCache.save(saved)
        let fresh = User(id: "u1", email: "sara@example.com", fullName: "Sara Ahmadi", emailVerified: true)
        let api = LaunchAPI()
        await api.set(.user(fresh))
        let appState = AppState(api: api)
        await appState.resumeSavedSession()
        await appState.restore()
        XCTAssertEqual(appState.session, .signedIn(fresh))
        XCTAssertEqual(SessionCache.read()?.fullName, "Sara Ahmadi")
        // Asked once: the language rebuild runs `restore()` again.
        await appState.restore()
        let calls = await api.currentUserCalls
        XCTAssertEqual(calls, 1)
    }

    func testARevokedSessionSignsOutWithAReason() async {
        SessionCache.save(saved)
        let api = LaunchAPI()
        await api.set(.unauthorized)
        let appState = AppState(api: api)
        await appState.resumeSavedSession()
        await appState.restore()
        XCTAssertEqual(appState.session, .signedOut)
        XCTAssertNotNil(appState.sessionEndedMessage)
        XCTAssertNil(SessionCache.read())
    }

    func testOfflineTheSavedSessionStays() async {
        SessionCache.save(saved)
        let api = LaunchAPI()
        let appState = AppState(api: api)
        await appState.resumeSavedSession()
        await appState.restore()
        XCTAssertEqual(appState.session, .signedIn(saved))
    }

    func testATokenOfAnotherAccountReplacesTheSavedOne() async {
        SessionCache.save(saved)
        let other = User(id: "u2", email: "reza@example.com", fullName: "Reza", emailVerified: true)
        let api = LaunchAPI()
        await api.set(.user(other))
        let appState = AppState(api: api)
        await appState.resumeSavedSession()
        await appState.restore()
        XCTAssertEqual(appState.session, .signedIn(other))
        XCTAssertEqual(SessionCache.read()?.id, "u2")
    }

    func testWithNothingSavedTheLaunchStillWaits() async {
        let api = LaunchAPI()
        let appState = AppState(api: api)
        await appState.resumeSavedSession()
        XCTAssertEqual(appState.session, .restoring)
    }

    func testWithoutATokenTheSavedAccountIsNotShown() async {
        SessionCache.save(saved)
        let api = LaunchAPI()
        await api.setToken(false)
        let appState = AppState(api: api)
        await appState.resumeSavedSession()
        XCTAssertEqual(appState.session, .restoring)
        await appState.restore()
        XCTAssertEqual(appState.session, .signedOut)
    }
}
