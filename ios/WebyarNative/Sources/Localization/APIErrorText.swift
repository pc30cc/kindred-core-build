import Foundation

extension APIError {
    /// What to put in front of the operator when a request fails.
    ///
    /// The API answers in English to every client. `server/routes/auth.ts`
    /// returns `Invalid email or password` whoever is asking, and the server
    /// deliberately never consults `Accept-Language` — that is a documented
    /// decision there, not an oversight. So the raw `message` on
    /// `.server(status:message:)` is an English sentence, and putting it on
    /// screen is exactly how a Persian operator ends up reading English under
    /// a Persian heading.
    ///
    /// The app therefore says it in the operator's language, chosen by status
    /// code, and shows the server's own wording only when the interface is
    /// already English — where it is strictly more specific than anything
    /// here. Nothing is lost: the server's sentence is still in the response
    /// for anyone reading a log.
    ///
    /// `unauthorized` means different things in different places — on the
    /// login screen it is a wrong password, everywhere else it is a session
    /// that has gone — so the caller names it.
    func text(_ language: Language, unauthorized: String? = nil) -> String {
        switch self {
        case .transport:
            return Str.offlineBody(language)

        case .unauthorized:
            return unauthorized ?? Str.sessionExpired(language)

        case .decoding:
            return Str.errorUnreadableAnswer(language)

        case .server(let status, let message):
            if language == .en, let message, !message.isEmpty { return message }
            switch status {
            case 400, 422: return Str.errorInvalidInput(language)
            case 404: return Str.errorNotFound(language)
            case 409: return Str.errorConflict(language)
            case 429: return Str.errorTooManyRequests(language)
            // 401 and 403 never arrive here — `APIClient` turns both into
            // `.unauthorized` — but any other refusal is still the caller's
            // fault rather than the server's, and reads better as one.
            case 400...499: return Str.errorNotAllowed(language)
            default: return Str.errorServerProblem(language)
            }
        }
    }
}
