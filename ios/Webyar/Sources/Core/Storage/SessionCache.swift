import Foundation

/// The last operator known to be signed in.
///
/// Exists so a flaky moment at launch does not look like being signed out.
/// `restore()` can only confirm a session by asking the server, and on a cold
/// launch — a train, a lift, a simulator whose network is not up yet — that
/// question goes unanswered. Without something to fall back on the app has to
/// choose between showing the login screen to somebody who is signed in, or
/// showing the app to somebody who is not. This makes the first case
/// unnecessary: the token is still in the Keychain, so the session is almost
/// certainly fine, and every screen will discover otherwise the moment a
/// request comes back `401`.
///
/// Deliberately not the Keychain: this is a name and an email the operator
/// typed into their own phone, not a credential. The token stays where it is.
enum SessionCache {
    private static let key = "session.lastUser"

    static func save(_ user: User) {
        guard let data = try? JSONEncoder().encode(Stored(user)) else { return }
        UserDefaults.standard.set(data, forKey: key)
    }

    static func read() -> User? {
        guard let data = UserDefaults.standard.data(forKey: key),
              let stored = try? JSONDecoder().decode(Stored.self, from: data)
        else { return nil }
        return stored.user
    }

    static func clear() {
        UserDefaults.standard.removeObject(forKey: key)
    }

    /// `User` decodes from the server's shape, which is not the shape worth
    /// writing to disk. This is the small, stable subset.
    private struct Stored: Codable {
        let id: String
        let email: String?
        let fullName: String?

        init(_ user: User) {
            self.id = user.id
            self.email = user.email
            self.fullName = user.fullName
        }

        var user: User {
            User(id: id, email: email, fullName: fullName, emailVerified: nil)
        }
    }
}
