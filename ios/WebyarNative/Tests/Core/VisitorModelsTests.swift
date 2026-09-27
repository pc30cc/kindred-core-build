import Foundation
import XCTest
@testable import WebyarNative

/// The visitors, analytics and app-config shapes, read from JSON the way the
/// server actually writes it (`server/routes/visitors.ts`,
/// `server/services/webAnalytics/reportService.ts`,
/// `server/services/mobileApp/settings.ts`) — snake case for the visitors,
/// camel case for the reports, and the odd value a live list will contain.
final class VisitorModelsTests: XCTestCase {

    /// The app's own decoder: no key strategy, its own date parser.
    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let raw = try decoder.singleValueContainer().decode(String.self)
            guard let date = DateParsing.parse(raw) else {
                throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: raw))
            }
            return date
        }
        return try decoder.decode(T.self, from: Data(json.utf8))
    }

    // MARK: - Live visitors

    func testALiveVisitorReadsEveryFieldTheServerSends() throws {
        let response = try decode(LiveVisitorsResponse.self, """
        {"items":[{
          "id":"6b0c1c1e-1111-4f7a-9d55-3a2b1c0d9e8f","visitor_id":"v_abc","workspace_id":"w1",
          "status":"online","current_page":"https://shop.example/pricing",
          "last_activity_at":"2026-09-27T10:15:30.123Z","started_at":"2026-09-27T10:01:00Z",
          "browser":"Chrome 128","device":"desktop","os":"Windows","referrer":"https://www.google.com/",
          "geo":{"country":"Iran","country_code":"IR","region":"Tehran","city":"Tehran",
                 "latitude":35.6892,"longitude":"51.3890","timezone":"Asia/Tehran","source":"ip","provider":"maxmind"},
          "ip_display":"5.160.xxx.xxx","ip_raw":null,"can_view_raw_ip":false,"ip_locked":false,
          "contact":{"id":"c1","name":"Maryam","email":"m@example.com","avatar_url":null,"visitor_code":"K7Q2"},
          "conversation":{"id":"conv1","status":"open","subject":null}
        }]}
        """)
        let visitor = try XCTUnwrap(response.items.first)
        XCTAssertEqual(visitor.id, "6b0c1c1e-1111-4f7a-9d55-3a2b1c0d9e8f")
        XCTAssertEqual(visitor.visitorID, "v_abc")
        XCTAssertEqual(visitor.presence, .online)
        XCTAssertEqual(visitor.currentPage, "https://shop.example/pricing")
        XCTAssertNotNil(visitor.lastActivityAt)
        XCTAssertNotNil(visitor.startedAt)
        XCTAssertEqual(visitor.browser, "Chrome 128")
        XCTAssertEqual(visitor.geo?.countryCode, "IR")
        XCTAssertEqual(visitor.geo?.latitude, 35.6892)
        XCTAssertEqual(visitor.geo?.longitude, 51.389, "a coordinate sent as a string still reads")
        XCTAssertEqual(visitor.ipDisplay, "5.160.xxx.xxx")
        XCTAssertFalse(visitor.ipLocked)
        XCTAssertEqual(visitor.contact?.code, "K7Q2")
        XCTAssertEqual(visitor.conversation?.id, "conv1")
        XCTAssertNil(visitor.conversation?.subject)
    }

    func testTheSparestVisitorStillReads() throws {
        let response = try decode(LiveVisitorsResponse.self, """
        {"items":[{"id":"s1","status":"unknown","current_page":null,"last_activity_at":"not a date",
                   "geo":{"country":null,"country_code":null,"latitude":null,"longitude":null,"source":"none"},
                   "ip_display":"","contact":null,"conversation":null}]}
        """)
        let visitor = try XCTUnwrap(response.items.first)
        XCTAssertEqual(visitor.presence, .offline, "unknown presence is never shown as online")
        XCTAssertNil(visitor.lastActivityAt, "an odd date is dropped, not the row")
        XCTAssertNil(visitor.ipDisplay, "a blank value reads as nothing")
        XCTAssertNil(visitor.contact)
    }

    func testOneUnreadableVisitorDoesNotCostTheRestOfTheList() throws {
        let response = try decode(LiveVisitorsResponse.self, """
        {"items":[{"id":"a","status":"online"},{"status":"online"},{"id":"c","status":"idle"}]}
        """)
        XCTAssertEqual(response.items.map(\.id), ["a", "c"])
        XCTAssertEqual(response.items.last?.presence, .idle)
    }

    func testTheAnonCodeInOlderContactMetadataIsUsed() throws {
        let contact = try decode(VisitorContactRef.self, """
        {"id":"c9","name":null,"email":null,"avatar_url":null,"metadata":{"anon_code":"Z3P1","source":"widget"}}
        """)
        XCTAssertEqual(contact.code, "Z3P1")
    }

    // MARK: - Page history, map, start chat

    func testPageHistoryReadsItsThreeParts() throws {
        let history = try decode(VisitorPageHistory.self, """
        {"items":[{"id":42,"url":"https://s.example/b","title":"B","viewed_at":"2026-09-27T10:10:00Z"},
                  {"id":"41","url":"https://s.example/a","title":null,"viewed_at":"2026-09-27T10:05:00Z"}],
         "entry":{"landing_url":"https://s.example/","landing_title":null,"landed_at":"2026-09-27T10:00:00Z","referrer":null},
         "current":{"url":"https://s.example/b","title":"B","viewed_at":"2026-09-27T10:10:00Z"}}
        """)
        XCTAssertEqual(history.items.map(\.url), ["https://s.example/b", "https://s.example/a"])
        XCTAssertEqual(history.entry?.landingURL, "https://s.example/")
        XCTAssertEqual(history.current?.title, "B")
    }

    func testAnEmptyPageHistoryIsNotAnError() throws {
        let history = try decode(VisitorPageHistory.self, #"{"items":[],"entry":{"landing_url":null,"landing_title":null,"landed_at":null,"referrer":null},"current":null}"#)
        XCTAssertTrue(history.items.isEmpty)
        XCTAssertNil(history.current)
    }

    func testTheMapKeepsOnlyMarkersWithUsableCoordinates() throws {
        let map = try decode(VisitorMap.self, """
        {"markers":[{"id":"s1","status":"online","lat":41.0082,"lng":28.9784,"country":"Türkiye","country_code":"TR",
                     "city":"Istanbul","current_page":"/","source":"ip","last_activity_at":"2026-09-27T10:00:00Z"},
                    {"id":"s2","status":"idle","lat":null,"lng":null},
                    {"id":"s3","status":"online","lat":123,"lng":10}],
         "total":5,"without_location":3,"source_counts":{"ip":2,"none":3}}
        """)
        XCTAssertEqual(map.markers.map(\.id), ["s1"])
        XCTAssertEqual(map.markers.first?.place, "Istanbul, Türkiye")
        XCTAssertEqual(map.total, 5)
        XCTAssertEqual(map.withoutLocation, 3)
    }

    func testStartingAChatReadsTheConversation() throws {
        let result = try decode(StartVisitorChatResult.self, #"{"ok":true,"conversation_id":"conv9","created":false}"#)
        XCTAssertEqual(result.conversationID, "conv9")
        XCTAssertEqual(result.created, false)
    }

    // MARK: - Analytics

    func testTheOverviewReadsInCamelCase() throws {
        let overview = try decode(WebAnalyticsOverview.self, """
        {"sessions":1200,"pageviews":3400,"avgPagesPerSession":2.83,"uniqueVisitors":900,"bounceRate":41.5,
         "avgVisitDurationSeconds":154.2,
         "trend":[{"date":"2026-09-26","sessions":40,"pageviews":110},{"date":"2026-09-27","sessions":44,"pageviews":120}],
         "topChannels":[{"key":"organic_search","label":"organic_search","sessions":500,"pageviews":1500}],
         "topPages":[{"path":"/pricing","views":300}],"truncated":false}
        """)
        XCTAssertEqual(overview.sessions, 1200)
        XCTAssertEqual(overview.avgPagesPerSession, 2.83)
        XCTAssertEqual(overview.trend.map(\.date), ["2026-09-26", "2026-09-27"])
        XCTAssertEqual(overview.topChannels.first?.key, "organic_search")
        XCTAssertEqual(overview.topPages.first?.views, 300)
        XCTAssertFalse(overview.truncated)
    }

    func testReportRowsAndEventsRead() throws {
        let rows = try decode(WebAnalyticsRows<WebAnalyticsRow>.self, """
        {"rows":[{"key":"Iran","label":"Iran","sessions":20,"pageviews":61},{"key":"(unknown)","label":"(unknown)","sessions":3,"pageviews":3}],
         "truncated":true}
        """)
        XCTAssertEqual(rows.rows.map(\.key), ["Iran", "(unknown)"])
        XCTAssertTrue(rows.truncated)

        let pages = try decode(WebAnalyticsRows<WebAnalyticsPage>.self, #"{"rows":[{"path":"/","views":9}],"truncated":false}"#)
        XCTAssertEqual(pages.rows.first?.path, "/")

        let events = try decode(WebAnalyticsRows<WebAnalyticsEvent>.self, """
        {"rows":[{"eventName":"signup","count":12,"uniqueSessions":10,"conversionRate":0.05}],"truncated":false}
        """)
        XCTAssertEqual(events.rows.first?.eventName, "signup")
        XCTAssertEqual(events.rows.first?.conversionRate, 0.05)

        let live = try decode(WebAnalyticsLiveCount.self, #"{"count":7}"#)
        XCTAssertEqual(live.count, 7)
    }

    // MARK: - App configuration

    func testTheAppConfigReadsTheServersSwitches() throws {
        let config = try decode(MobileAppConfig.self, """
        {"platform":"ios","showContacts":true,"showVisitors":false,"showWebAnalytics":true}
        """)
        XCTAssertEqual(config, MobileAppConfig(showContacts: true, showVisitors: false, showWebAnalytics: true))
    }

    func testOnlyAnExplicitFalseHidesASection() throws {
        let config = try decode(MobileAppConfig.self, #"{"platform":"ios","showVisitors":null}"#)
        XCTAssertEqual(config, .defaults, "an older server that sends fewer keys hides nothing")
    }
}
