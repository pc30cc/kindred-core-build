import Foundation
import XCTest
@testable import WebyarNative

/// The Centrifugo frames the server sends, read the way the console and the
/// desktop apps read them.
final class RealtimeProtocolTests: XCTestCase {

    func testCommandsAreNumberedJSON() throws {
        let connect = try JSONSerialization.jsonObject(with: Data(CentrifugoProtocol.connect(id: 1, token: "t", name: "webyar-ios").utf8)) as? [String: Any]
        XCTAssertEqual(connect?["id"] as? Int, 1)
        XCTAssertEqual((connect?["connect"] as? [String: Any])?["token"] as? String, "t")
        let subscribe = try JSONSerialization.jsonObject(with: Data(CentrifugoProtocol.subscribe(id: 2, channel: "ws:w1:inbox", token: "s").utf8)) as? [String: Any]
        XCTAssertEqual((subscribe?["subscribe"] as? [String: Any])?["channel"] as? String, "ws:w1:inbox")
    }

    func testPingRepliesAndDisconnectAreRecognised() {
        XCTAssertEqual(CentrifugoProtocol.parse("{}"), [.ping])
        XCTAssertEqual(CentrifugoProtocol.parse(#"{"id":1,"connect":{"client":"x"}}"#), [.reply(id: 1, error: nil)])
        XCTAssertEqual(CentrifugoProtocol.parse(#"{"id":2,"error":{"code":103,"message":"permission denied"}}"#),
                       [.reply(id: 2, error: "permission denied")])
        XCTAssertEqual(CentrifugoProtocol.parse(#"{"push":{"disconnect":{"code":3000}}}"#), [.disconnect])
    }

    func testSeveralFramesInOneMessage() {
        let frames = CentrifugoProtocol.parse("{}\n{\"id\":1}\n\n")
        XCTAssertEqual(frames, [.ping, .reply(id: 1, error: nil)])
    }

    func testAMessageEnvelopeCarriesItsRow() throws {
        let text = #"""
        {"push":{"channel":"ws:w1:inbox","pub":{"data":{"type":"message","payload":{
          "id":"m1","conversation_id":"c1","sender_type":"contact","body":"salam","text":"salam",
          "created_at":"2026-09-25T10:00:00.123Z","metadata":{"client_message_id":"k-1"},
          "sender_id":null,"sender_name":null,"sender_avatar":null}}}}}
        """#.replacingOccurrences(of: "\n", with: "")
        guard case .publication(let channel, let data)? = CentrifugoProtocol.parse(text).first else {
            return XCTFail("not a publication")
        }
        XCTAssertEqual(channel, "ws:w1:inbox")
        let event = try XCTUnwrap(CentrifugoProtocol.event(data))
        XCTAssertTrue(event.isMessage)
        XCTAssertEqual(event.conversationID, "c1")
        XCTAssertEqual(event.messageID, "m1")
        XCTAssertEqual(event.message?.body, "salam")
        XCTAssertEqual(event.message?.clientMessageID, "k-1")
        XCTAssertNil(event.message?.updatedAt, "a realtime row is the row as inserted")
    }

    func testAnOperatorEventNamesItsConversation() throws {
        let text = #"{"push":{"channel":"ws:w1:inbox","pub":{"data":{"type":"event","payload":{"kind":"conversation_resolved","conversation_id":"c7","workspace_id":"w1"}}}}}"#
        guard case .publication(_, let data)? = CentrifugoProtocol.parse(text).first else { return XCTFail() }
        let event = try XCTUnwrap(CentrifugoProtocol.event(data))
        XCTAssertFalse(event.isMessage)
        XCTAssertEqual(event.kind, "conversation_resolved")
        XCTAssertEqual(event.conversationID, "c7")
        XCTAssertNil(event.message)
    }

    func testAMessageRowItCannotReadStillNamesTheConversation() throws {
        // No created_at: not shown as a row, but the thread still reads what changed.
        let text = #"{"push":{"pub":{"data":{"type":"message","payload":{"id":"m1","conversation_id":"c1"}}}}}"#
        guard case .publication(_, let data)? = CentrifugoProtocol.parse(text).first else { return XCTFail() }
        let event = try XCTUnwrap(CentrifugoProtocol.event(data))
        XCTAssertEqual(event.conversationID, "c1")
        XCTAssertNil(event.message)
    }

    func testTypingNeedsNoRead() throws {
        let text = #"{"push":{"pub":{"data":{"type":"typing","payload":{"conversation_id":"c1"}}}}}"#
        guard case .publication(_, let data)? = CentrifugoProtocol.parse(text).first else { return XCTFail() }
        XCTAssertEqual(CentrifugoProtocol.event(data)?.needsNoRead, true)
    }

    func testTokensDecodeLeniently() throws {
        let connect = try JSONDecoder().decode(RealtimeConnect.self, from: Data(#"{"vendor":"centrifugo","ws_url":"wss://rt.example/connection/websocket","token":"t","expires_at":1790000000000}"#.utf8))
        XCTAssertEqual(connect.vendor, "centrifugo")
        XCTAssertEqual(connect.expiresAt, 1_790_000_000_000)
        let polling = try JSONDecoder().decode(RealtimeConnect.self, from: Data(#"{"vendor":"polling_builtin","effective_policy":{}}"#.utf8))
        XCTAssertEqual(polling.vendor, "polling_builtin")
        XCTAssertNil(polling.token)
    }
}
