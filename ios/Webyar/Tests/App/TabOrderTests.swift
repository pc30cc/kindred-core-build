import XCTest
@testable import Webyar

/// The inbox sits in the middle of the tab bar, whichever tabs the plan
/// leaves around it.
@MainActor
final class TabOrderTests: XCTestCase {

    func testEveryTabPutsTheInboxInTheMiddle() {
        XCTAssertEqual(
            MainTabView.order(inbox: .inbox, among: [.contacts, .visitors, .analytics, .settings]),
            [.contacts, .visitors, .inbox, .analytics, .settings]
        )
    }

    func testTwoOthersPutTheInboxBetweenThem() {
        XCTAssertEqual(
            MainTabView.order(inbox: .inbox, among: [.visitors, .settings]),
            [.visitors, .inbox, .settings]
        )
    }

    func testThreeOthersPutTheInboxOnTheLeadingMiddle() {
        XCTAssertEqual(
            MainTabView.order(inbox: .inbox, among: [.contacts, .visitors, .settings]),
            [.contacts, .inbox, .visitors, .settings]
        )
    }

    func testWithOnlySettingsTheInboxLeads() {
        // Nothing to be in the middle of: the inbox keeps the leading end,
        // as it has before the plan resolves.
        XCTAssertEqual(MainTabView.order(inbox: .inbox, among: [.settings]), [.inbox, .settings])
    }
}
