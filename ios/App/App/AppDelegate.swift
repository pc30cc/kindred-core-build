import UIKit
import Capacitor
import FirebaseCore

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        // Both of these have to run before the Capacitor bridge is built, which
        // happens when the scene connects — see SceneDelegate.
        configureFirebase()

        // The action buttons on a push banner come from a category registered
        // by the app, not from the payload — so this has to run before the
        // first notification can arrive.
        NotificationCategories.register()
        return true
    }

    /// Configures Firebase, tolerating a missing `GoogleService-Info.plist`.
    ///
    /// The Capacitor Firebase Messaging plugin calls `FirebaseApp.configure()`
    /// from its `load()`, and that call raises when the plist is absent. The
    /// plugin loads while the bridge builds its view, so the raise happens
    /// before the first frame and kills the process — a fresh clone, a CI
    /// machine or a simulator run could not start the app at all.
    ///
    /// The plugin skips its own call when an app is already configured, so we
    /// configure first. With the plist present this is the ordinary path. With
    /// it absent we configure an inert placeholder instead: the app launches
    /// and everything except push works, which is the honest outcome — there
    /// is no Firebase project to obtain a token from. Super Admin surfaces the
    /// same gap as the `pushFirebasePlist` readiness check.
    private func configureFirebase() {
        guard FirebaseApp.app() == nil else { return }

        if Bundle.main.url(forResource: "GoogleService-Info", withExtension: "plist") != nil {
            FirebaseApp.configure()
            return
        }

        NSLog("[Webyar] GoogleService-Info.plist is missing — push notifications are disabled for this build. Add the file from your Firebase project to enable them.")
        // FirebaseInstallations is an eager component and validates these, so
        // they have to be well-formed and non-empty even though no Firebase
        // project answers to them. Token registration fails and logs; nothing
        // raises.
        let options = FirebaseOptions(googleAppID: "1:000000000000:ios:0000000000000000",
                                      gcmSenderID: "000000000000")
        options.apiKey = "AIzaSyDISABLED0000000000000000000000000"
        options.projectID = "webyar-push-disabled"
        options.bundleID = Bundle.main.bundleIdentifier ?? "com.webyar.app"
        FirebaseApp.configure(options: options)
    }

    func applicationWillResignActive(_ application: UIApplication) {
        // Sent when the application is about to move from active to inactive state. This can occur for certain types of temporary interruptions (such as an incoming phone call or SMS message) or when the user quits the application and it begins the transition to the background state.
        // Use this method to pause ongoing tasks, disable timers, and invalidate graphics rendering callbacks. Games should use this method to pause the game.
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
        // Use this method to release shared resources, save user data, invalidate timers, and store enough application state information to restore your application to its current state in case it is terminated later.
        // If your application supports background execution, this method is called instead of applicationWillTerminate: when the user quits.
    }

    func applicationWillEnterForeground(_ application: UIApplication) {
        // Called as part of the transition from the background to the active state; here you can undo many of the changes made on entering the background.
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        // Restart any tasks that were paused (or not yet started) while the application was inactive. If the application was previously in the background, optionally refresh the user interface.
    }

    func applicationWillTerminate(_ application: UIApplication) {
        // Called when the application is about to terminate. Save data if appropriate. See also applicationDidEnterBackground:.
    }

    func application(_ application: UIApplication,
                     configurationForConnecting connectingSceneSession: UISceneSession,
                     options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        let config = UISceneConfiguration(name: "Default Configuration",
                                          sessionRole: connectingSceneSession.role)
        config.delegateClass = SceneDelegate.self
        return config
    }
}
