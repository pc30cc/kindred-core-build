import Foundation
import XCTest
@testable import Webyar

/// A spam endpoint that records what it was asked and can refuse.
private actor SpamAPI: TestAPIBase {
    private(set) var calls: [(spam: Bool, conversation: String, workspace: String)] = []
    private var failing = false

    func setFailing(_ value: Bool) { failing = value }

    func setSpam(_ spam: Bool, conversationID: String, workspaceID: String) async throws {
        calls.append((spam, conversationID, workspaceID))
        if failing { throw APIError.transport }
    }
}

/// The conversation menu's "Mark as spam" and "Not spam": the operator's way
/// to report a sender from the phone (App Store Review Guideline 1.2).
@MainActor
final class ConversationSpamTests: XCTestCase {
    private var api: SpamAPI!
    private var appState: AppState!

    override func setUp() async throws {
        api = SpamAPI()
        appState = AppState(api: api)
    }

    private func spamConversation(_ id: String) throws -> Conversation {
        let json = #"{"id":"\#(id)","workspace_id":"w1","status":"open","is_spam":true}"#
        return try StoreCoding.decoder().decode(Conversation.self, from: Data(json.utf8))
    }

    func testTheFlagIsReadFromTheServerRow() throws {
        XCTAssertEqual(try spamConversation("c1").isSpam, true)
        XCTAssertNil(try conversation("c2").isSpam, "a row without the column is not spam")
        XCTAssertFalse(ConversationActionsModel(conversation: try conversation("c2"), api: api).isSpam)
    }

    func testMarkingCallsTheServerAndSaysSo() async throws {
        let model = ConversationActionsModel(conversation: try conversation("c1"), api: api)
        await model.setSpam(true, appState: appState)

        let calls = await api.calls
        XCTAssertEqual(calls.count, 1)
        XCTAssertEqual(calls.first?.spam, true)
        XCTAssertEqual(calls.first?.conversation, "c1")
        XCTAssertEqual(calls.first?.workspace, "w1")
        XCTAssertTrue(model.isSpam)
        XCTAssertTrue(model.spamChanged)
        XCTAssertFalse(model.saveFailed)
    }

    func testTakingItBackOut() async throws {
        let model = ConversationActionsModel(conversation: try spamConversation("c1"), api: api)
        XCTAssertTrue(model.isSpam)
        await model.setSpam(false, appState: appState)

        let calls = await api.calls
        XCTAssertEqual(calls.first?.spam, false)
        XCTAssertFalse(model.isSpam)
        XCTAssertTrue(model.spamChanged)
    }

    /// The flag moves only once the server has taken it.
    func testARefusalLeavesItAsItWas() async throws {
        await api.setFailing(true)
        let model = ConversationActionsModel(conversation: try conversation("c1"), api: api)
        await model.setSpam(true, appState: appState)

        XCTAssertFalse(model.isSpam)
        XCTAssertFalse(model.spamChanged)
        XCTAssertTrue(model.saveFailed)
    }

    func testAskingForWhatItAlreadyIsSendsNothing() async throws {
        let model = ConversationActionsModel(conversation: try spamConversation("c1"), api: api)
        await model.setSpam(true, appState: appState)
        let calls = await api.calls
        XCTAssertTrue(calls.isEmpty)
        XCTAssertFalse(model.spamChanged)
    }
}
