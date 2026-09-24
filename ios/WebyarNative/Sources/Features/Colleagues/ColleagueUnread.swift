import Foundation
import Observation

/// How many internal messages are waiting, across every colleague.
///
/// Kept outside any one screen because three of them would otherwise
/// disagree about it: the chip on the inbox strip shows the number, the
/// Colleagues list already knows it row by row, and opening a thread marks
/// it read. One owner is what makes the badge fall the moment a thread is
/// read rather than one refresh later.
@MainActor
@Observable
final class ColleagueUnread {

    static let shared = ColleagueUnread()

    private(set) var count = 0

    private let api: any WebyarAPI
    /// True while a read is out. Internal messages arrive in bursts — three
    /// lines typed in a row are three doorbells — and they all have the same
    /// answer, so the ones that ring during a read join it instead of
    /// starting their own.
    private var isReading = false

    init(api: any WebyarAPI = Backend.current) {
        self.api = api
    }

    /// Asks the server, for the screens that do not hold the list.
    ///
    /// Quiet by construction: a failure leaves the last number where it is,
    /// because a badge that drops to nothing on a dropped connection would
    /// read as the messages having been dealt with.
    func refresh(workspaceID: String?) async {
        guard let workspaceID else {
            count = 0
            return
        }
        guard !isReading else { return }
        isReading = true
        defer { isReading = false }

        guard let response = try? await api.colleagues(workspaceID: workspaceID) else { return }
        count = response.totalUnread ?? Self.total(of: response.colleagues)
    }

    /// For the Colleagues list, which has just read the same rows the count
    /// is made of — asking the server again for a number it is already
    /// holding would be a round trip for nothing.
    func absorb(_ colleagues: [Colleague]) {
        count = Self.total(of: colleagues)
    }

    /// Nothing about the last operator survives a sign-out.
    func signedOut() {
        count = 0
        isReading = false
    }

    private static func total(of colleagues: [Colleague]) -> Int {
        colleagues.reduce(0) { $0 + ($1.unread ?? 0) }
    }
}
