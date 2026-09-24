import SwiftUI
import Observation

// Temporary stand-ins while each section is written.

@MainActor @Observable final class VisitorsModel { init(app: AppModel) {}; func stop() {} }
@MainActor @Observable final class CallCenterModel { init(app: AppModel) {}; func stop() {} }

struct VisitorsList: View { let model: VisitorsModel; var body: some View { Text("Visitors") } }
struct VisitorDetail: View { let model: VisitorsModel; var body: some View { Text("Visitor") } }
struct CallCenterList: View { let model: CallCenterModel; var body: some View { Text("Calls") } }
struct CallCenterDetail: View { let model: CallCenterModel; var body: some View { Text("Call") } }

@MainActor final class CallCoordinator {
    static let shared = CallCoordinator()
    var isBusy = false
    func start(app: AppModel, conversation: Conversation, channel: String) {}
}
