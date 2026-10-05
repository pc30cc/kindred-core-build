import Foundation
import XCTest
@testable import Webyar

/// Who is asking, read from the server's snapshot
/// (server/services/platformSupport/requester.ts) — the same keys the
/// Android and Windows cards read, and the plan's dates beside them.
final class RequesterCardTests: XCTestCase {
    private func metadata(_ json: String) throws -> [String: JSONValue] {
        try JSONDecoder().decode([String: JSONValue].self, from: Data(json.utf8))
    }

    private let snapshot = #"""
    {"kind":"platform_support_requester","internal":true,
     "user":{"id":"u1","name":"Sara Ahmadi","email":"sara@example.com","phone":"+989121234567","company":"Sara Shop",
             "website":null,"member_since":"2026-08-01T09:00:00.000Z","client_platform":"android","source_workspace":"Shop"},
     "workspace_count":12,
     "workspaces":[
      {"id":"w1","name":"Shop","role":"owner","status":"active","created_at":"2026-08-01T09:00:00+00:00",
       "plan":{"name":"Startup","names":{"fa":"شروع"},"slug":"pro","is_free":false,"status":"active",
               "period_start":"2026-09-15T00:00:00+00:00","period_end":"2026-10-15T00:00:00+00:00","trial_end":null,
               "cancel_at_period_end":true,"billing_interval":"monthly","started_at":"2026-06-01T08:00:00.000Z"},
       "operators":{"used":2,"limit":3},"contacts":{"used":1,"limit":500},
       "usage":{"period":"2026-10","conversations":{"used":42,"limit":1000},"visitors":{"used":900,"limit":-1},
                "messages":310,"ai_credits":{"used":0,"limit":0},"call_minutes":0,"storage_bytes":1024,"storage_limit_gb":1}},
      {"id":"w2","name":"Other","role":"agent","plan":null,"operators":{"used":"5","limit":null},"contacts":{"used":0,"limit":null},
       "usage":{"conversations":{"used":0,"limit":null},"visitors":{"used":0,"limit":null},"messages":0,
                "ai_credits":{"used":0,"limit":null},"storage_bytes":0,"storage_limit_gb":null}}],
     "captured_at":"2026-10-02T10:00:00.000Z"}
    """#

    func testTheSnapshotIsReadInFull() throws {
        let card = try XCTUnwrap(RequesterCard.parse(metadata(snapshot)))
        XCTAssertEqual(card.name, "Sara Ahmadi")
        XCTAssertEqual(card.email, "sara@example.com")
        XCTAssertEqual(card.phone, "+989121234567")
        XCTAssertEqual(card.company, "Sara Shop")
        XCTAssertNil(card.website)
        XCTAssertEqual(card.clientPlatform, "Android")
        XCTAssertEqual(card.sourceWorkspace, "Shop")
        XCTAssertEqual(card.workspaceCount, 12, "every workspace they belong to, not only the ones listed")
        XCTAssertEqual(card.workspaces.map(\.id), ["w1", "w2"])
        XCTAssertNotNil(card.memberSince)
        XCTAssertNotNil(card.capturedAt)

        let shop = card.workspaces[0]
        XCTAssertEqual(shop.role, "owner")
        XCTAssertEqual(shop.operators, RequesterCard.Metered(used: 2, limit: 3))
        XCTAssertEqual(shop.conversations.fraction, 0.042)
        XCTAssertTrue(shop.visitors.isUnlimited)
        XCTAssertNil(shop.visitors.fraction)
        XCTAssertNil(shop.aiCredits.fraction, "a limit of nothing is no bar")
        XCTAssertEqual(shop.messages, 310)
        XCTAssertEqual(shop.storage.limit, 1_073_741_824)

        // A number sent as a string is still a number.
        XCTAssertEqual(card.workspaces[1].operators.used, 5)
        XCTAssertNil(card.workspaces[1].plan)
    }

    func testThePlanWithTheDayItWasBoughtAndTheDayItRunsOut() throws {
        let plan = try XCTUnwrap(RequesterCard.parse(metadata(snapshot))?.workspaces.first?.plan)
        XCTAssertEqual(plan.title(.fa), "شروع")
        XCTAssertEqual(plan.title(.en), "Startup", "a language Super Admin did not name it in")
        XCTAssertEqual(plan.status, "active")
        XCTAssertEqual(plan.billingInterval, "monthly")
        XCTAssertTrue(plan.cancelAtPeriodEnd)
        let start = try XCTUnwrap(plan.periodStart)
        let end = try XCTUnwrap(plan.endsAt)
        XCTAssertEqual(end.timeIntervalSince(start), 30 * 86_400)
        XCTAssertNotNil(plan.startedAt)

        // Twelve and a half days to go: thirteen days left, and 17.5 of 30 gone.
        let now = end.addingTimeInterval(-12.5 * 86_400)
        XCTAssertEqual(plan.daysLeft(now: now), 13)
        XCTAssertEqual(try XCTUnwrap(plan.elapsed(now: now)), 17.5 / 30, accuracy: 0.0001)
        // Run out three days ago.
        XCTAssertEqual(plan.daysLeft(now: end.addingTimeInterval(3 * 86_400 + 60)), -3)
        XCTAssertEqual(plan.elapsed(now: end.addingTimeInterval(86_400)), 1)
    }

    func testATrialRunsOutWhenTheTrialDoes() throws {
        let json = snapshot
            .replacingOccurrences(of: #""is_free":false,"status":"active""#, with: #""is_free":false,"status":"trialing""#)
            .replacingOccurrences(of: #""trial_end":null"#, with: #""trial_end":"2026-09-29T00:00:00Z""#)
        let plan = try XCTUnwrap(RequesterCard.parse(metadata(json))?.workspaces.first?.plan)
        XCTAssertTrue(plan.isTrial)
        XCTAssertEqual(plan.endsAt, DateParsing.parse("2026-09-29T00:00:00Z"))
    }

    func testACardFromBeforeTheDatesStillReads() throws {
        // Written by a server from before period_start and started_at.
        let json = snapshot
            .replacingOccurrences(of: #""period_start":"2026-09-15T00:00:00+00:00","#, with: "")
            .replacingOccurrences(of: #","billing_interval":"monthly","started_at":"2026-06-01T08:00:00.000Z""#, with: "")
        let plan = try XCTUnwrap(RequesterCard.parse(metadata(json))?.workspaces.first?.plan)
        XCTAssertNil(plan.periodStart)
        XCTAssertNil(plan.startedAt)
        XCTAssertNil(plan.billingInterval)
        XCTAssertNotNil(plan.periodEnd)
        XCTAssertNil(plan.elapsed(), "no bar without a start")
    }

    func testAnyOtherMessageIsNotACard() throws {
        XCTAssertNil(RequesterCard.parse(nil))
        XCTAssertNil(RequesterCard.parse(try metadata(#"{"kind":"conversation_resolved"}"#)))
        XCTAssertNil(RequesterCard.parse(try metadata(#"{"client_message_id":"x"}"#)))
    }

    func testTheWordsForStatesAndRoles() {
        XCTAssertEqual(RequesterStr.status(.fa, "active"), "فعال")
        XCTAssertEqual(RequesterStr.status(.en, "past_due"), "Past due")
        XCTAssertEqual(RequesterStr.status(.en, "paused"), "paused", "an unknown state as the server named it")
        XCTAssertEqual(RequesterStr.role(.fa, "owner"), "مالک")
        XCTAssertEqual(RequesterStr.interval(.fa, "yearly"), "سالانه")
        XCTAssertNil(RequesterStr.interval(.en, "weird"))
        XCTAssertEqual(RequesterStr.purchased(.fa), "تاریخ خرید")
        XCTAssertEqual(RequesterStr.expires(.fa), "تاریخ اتمام")
    }
}
