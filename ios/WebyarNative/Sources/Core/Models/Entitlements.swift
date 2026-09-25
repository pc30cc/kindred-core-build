import Foundation

/// One capability's resolved state, and where the value came from.
struct EffectiveState<Value: Codable & Sendable>: Codable, Sendable {
    let value: Value?
    let source: String?
    let note: String?
}

/// The plan snapshot for a workspace: what this account is actually entitled to.
///
/// Mirrors `GET /api/plans/workspace/:id/effective`. Only the buckets the app
/// gates on are decoded; the plan and usage objects the admin console needs
/// are left alone.
struct Entitlements: Codable, Sendable {
    let workspaceId: String?
    let features: [String: EffectiveState<Bool>]?
    let modules: [String: EffectiveState<Bool>]?
    let channels: [String: EffectiveState<Bool>]?
    let limits: [String: EffectiveState<Int>]?
    let plan: PlanSummary?

    struct PlanSummary: Codable, Sendable {
        let slug: String?
        let name: String?
        let tier: String?
    }

    enum CodingKeys: String, CodingKey {
        case workspaceId
        case features, modules, channels, limits, plan
    }

    // MARK: - Gates
    //
    // The web console's one rule (src/lib/planAccess.ts): a capability is
    // available only when its value is exactly `true`. A key the snapshot does
    // not carry is not available — the server sends every key it knows and
    // denies the ones it does not.

    /// Whether a top-level section belongs in this plan.
    func moduleInPlan(_ key: String) -> Bool {
        modules?[key]?.value == true
    }

    /// Whether a capability is actually granted. Fail-closed: a missing key or
    /// an unresolved lookup is never treated as enabled.
    func moduleEnabled(_ key: String) -> Bool {
        modules?[key]?.value == true
    }

    /// Fail-closed, for individual features inside a section.
    func featureEnabled(_ key: String) -> Bool {
        features?[key]?.value == true
    }

    func channelEnabled(_ key: String) -> Bool {
        channels?[key]?.value == true
    }

    /// Channel keys the plan itself governs; any other channel inbox is decided
    /// by the plugin's own plan check (the catalog's `planAllowed`).
    static let planChannels: Set<String> = [
        "chat_widget", "email", "whatsapp", "sms", "instagram", "telegram", "bale", "gmail", "yahoomail", "voice", "video",
    ]

    func limit(_ key: String) -> Int? {
        limits?[key]?.value
    }
}

/// How far the plan snapshot has got.
///
/// The distinction between `loading` and `failed` is what stops a plan-gated
/// tab from appearing for a moment and then disappearing: nothing gated is
/// rendered until this resolves either way.
enum EntitlementsState: Sendable {
    case loading
    case loaded(Entitlements)
    case failed

    var value: Entitlements? {
        if case .loaded(let entitlements) = self { return entitlements }
        return nil
    }

    var isResolved: Bool {
        switch self {
        case .loading: false
        case .loaded, .failed: true
        }
    }
}
