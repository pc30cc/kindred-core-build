import UIKit

/// Exists for one reason: PushKit.
///
/// A VoIP push can launch the app from not running at all, and iOS delivers
/// that push to whatever registry exists by the time
/// `didFinishLaunchingWithOptions` returns. A registry created later — in a
/// SwiftUI `.task`, or when a screen appears — is created after the push has
/// already been dropped, which is precisely the case the whole feature exists
/// for: the phone was in a pocket and somebody called.
final class AppDelegate: NSObject, UIApplicationDelegate {

    /// Created here and handed to the SwiftUI tree, so the app has exactly one
    /// provider and one registry for its whole lifetime.
    let calls = CallCenterService()

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        MainActor.assumeIsolated {
            calls.start()
        }
        return true
    }
}
