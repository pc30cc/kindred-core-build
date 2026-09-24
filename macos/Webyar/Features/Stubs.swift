import SwiftUI
import Observation

// Temporary stand-ins while each section is written.

@MainActor @Observable final class CallCenterModel { init(app: AppModel) {}; func stop() {} }

struct CallCenterList: View { let model: CallCenterModel; var body: some View { Text("Calls") } }
struct CallCenterDetail: View { let model: CallCenterModel; var body: some View { Text("Call") } }

@MainActor final class CallCoordinator {
    static let shared = CallCoordinator()
    var isBusy = false
    func start(app: AppModel, conversation: Conversation, channel: String) {}
}
