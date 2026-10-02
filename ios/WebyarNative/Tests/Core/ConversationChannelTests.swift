import Foundation
import XCTest
@testable import WebyarNative

/// Where a conversation is written from, and what its label says — the same
/// rules as the Android app's `ConversationChannel`.
final class ConversationChannelTests: XCTestCase {
    private func thread(metadata: String? = nil, contactMetadata: String? = nil) throws -> Conversation {
        var json = #"{"id":"c1","workspace_id":"w1","status":"open","unread_count":0,"#
        if let metadata { json += #""metadata":\#(metadata),"# }
        json += #""contacts":{"name":"Sara","email":null,"avatar_url":null,"visitor_code":null"#
        if let contactMetadata { json += #","metadata":\#(contactMetadata)"# }
        json += "}}"
        return try StoreCoding.decoder().decode(Conversation.self, from: Data(json.utf8))
    }

    func testTheWebsiteIsTheDefault() throws {
        XCTAssertEqual(ConversationChannel.of(try thread()), ConversationChannel.web)
        XCTAssertEqual(ConversationChannel.of(nil), ConversationChannel.web)
        XCTAssertEqual(ConversationChannel.of(try thread(metadata: #"{"channel":"widget"}"#)), ConversationChannel.web)
    }

    func testTheConversationsChannelThenTheContacts() throws {
        XCTAssertEqual(ConversationChannel.of(try thread(metadata: #"{"channel":"Telegram"}"#)), "telegram")
        XCTAssertEqual(ConversationChannel.of(try thread(contactMetadata: #"{"channel":"whatsapp"}"#)), "whatsapp")
        XCTAssertEqual(
            ConversationChannel.of(try thread(metadata: #"{"channel":"bale"}"#, contactMetadata: #"{"channel":"whatsapp"}"#)),
            "bale"
        )
        // Another name for the same provider.
        XCTAssertEqual(ConversationChannel.of(try thread(metadata: #"{"source":"twitter"}"#)), "x")
    }

    func testHowAThreadBeganIsNotWhereItIsWrittenFrom() throws {
        // `metadata.source` also says `ai_agent_intro`, an import…: passed over.
        XCTAssertEqual(ConversationChannel.of(try thread(metadata: #"{"source":"ai_agent_intro"}"#)), ConversationChannel.web)
        XCTAssertEqual(
            ConversationChannel.of(try thread(metadata: #"{"source":"import"}"#, contactMetadata: #"{"channel":"telegram"}"#)),
            "telegram"
        )
    }

    func testASupportConversationNamesTheAppItCameFrom() throws {
        let android = try thread(metadata: #"{"channel":"platform_support","client_platform":"android"}"#)
        XCTAssertEqual(ConversationChannel.of(android), ConversationChannel.platformSupport)
        XCTAssertEqual(ConversationChannel.clientPlatform(android), "Android")

        // From the contact when the conversation does not say.
        let windows = try thread(metadata: #"{"channel":"platform_support"}"#, contactMetadata: #"{"client_platform":"Windows"}"#)
        XCTAssertEqual(ConversationChannel.clientPlatform(windows), "Windows")

        for (raw, shown) in [("ios", "iOS"), ("macos", "macOS"), ("web", "Web"), (" ANDROID ", "Android")] {
            let conversation = try thread(metadata: #"{"channel":"platform_support","client_platform":"\#(raw)"}"#)
            XCTAssertEqual(ConversationChannel.clientPlatform(conversation), shown, raw)
        }
        // A value it does not know is not shown.
        XCTAssertNil(ConversationChannel.clientPlatform(
            try thread(metadata: #"{"channel":"platform_support","client_platform":"fridge"}"#)
        ))
    }

    func testOnlyASupportConversationHasAnApp() throws {
        XCTAssertNil(ConversationChannel.clientPlatform(try thread(metadata: #"{"channel":"telegram","client_platform":"android"}"#)))
        XCTAssertNil(ConversationChannel.clientPlatform(try thread()))
    }

    func testTheLabelsWords() {
        let support = ConversationChannel.platformSupport
        XCTAssertEqual(ConversationChannel.label(support, language: .en, platform: "Android"), "Site user · Android")
        XCTAssertEqual(ConversationChannel.label(support, language: .fa, platform: "Windows"), "کاربر سایت · Windows")
        XCTAssertEqual(ConversationChannel.label(support, language: .tr, platform: "macOS"), "Site kullanıcısı · macOS")
        XCTAssertEqual(ConversationChannel.label(support, language: .en), "Site user")
        // Only a support conversation carries the app.
        XCTAssertEqual(ConversationChannel.label("telegram", language: .fa, platform: "Android"), "Telegram")
        XCTAssertEqual(ConversationChannel.label("bale", language: .fa), "بله")
        XCTAssertEqual(ConversationChannel.label(ConversationChannel.web, language: .fa), "وب‌سایت")
        XCTAssertEqual(ConversationChannel.label("email", language: .tr), "E-posta")
    }
}
