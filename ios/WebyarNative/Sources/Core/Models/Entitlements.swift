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
    // These mirror `AppSidebar.tsx` exactly, including the difference between
    // the two. Getting them the same way round matters: one decides whether a
    // whole menu exists, the other whether a single action is allowed.

    /// Whether a top-level section belongs in this plan.
    ///
    /// A key the registry does not know about counts as visible, so a module
    /// added server-side does not vanish from an older build. An explicit
    /// `false` hides it.
    func moduleInPlan(_ key: String) -> Bool {
        guard let modules else { return false }
        guard let state = modules[key] else { return true }
        return state.value == true
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
