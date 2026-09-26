using System.Globalization;
using Webyar.Core.Api;

namespace Webyar.Core.Calls;

/// <summary>An operator the call can be handed to, with their state on the desk and how many calls they are on.</summary>
public sealed record TransferOperator(string UserId, string Name, string Status, int ActiveCalls);

/// <summary>
/// Who a call-center call can go to, as the Mac's transfer panel lists them:
/// the workspace's people who can take calls, joined with their desk presence
/// and ordered available, on a call, away, offline; and the departments that
/// take this kind of call.
/// </summary>
public static class TransferTargets
{
    /// <summary>The roles the server lets a call be assigned to. A member without a role is not ruled out.</summary>
    public static readonly IReadOnlySet<string> AssignableRoles =
        new HashSet<string>(StringComparer.Ordinal) { "owner", "admin", "agent", "support_agent", "team_lead" };

    public static IReadOnlyList<TransferOperator> Operators(IEnumerable<WorkspaceMember> members, IEnumerable<CallAgentPresence> presence, string? me, CultureInfo? culture = null)
    {
        var byUser = new Dictionary<string, CallAgentPresence>(StringComparer.Ordinal);
        foreach (var p in presence) byUser.TryAdd(p.UserId, p);
        var names = StringComparer.Create(culture ?? CultureInfo.CurrentCulture, CompareOptions.IgnoreCase);
        return members
            .Where(m => m.SuspendedAt is null && m.UserId != me && (m.Role is null || AssignableRoles.Contains(m.Role)))
            .Select(m =>
            {
                byUser.TryGetValue(m.UserId, out var p);
                return new TransferOperator(m.UserId, m.DisplayName, p?.Status is { Length: > 0 } status ? status : "offline", Math.Max(0, p?.ActiveCallCount ?? 0));
            })
            .OrderBy(o => Rank(o.Status))
            .ThenBy(o => o.Name, names)
            .ToList();
    }

    /// <summary>Available first, then on a call, away, and offline (or unknown) last.</summary>
    public static int Rank(string? status) => status switch
    {
        "available" => 0,
        "busy" => 1,
        "away" => 2,
        _ => 3,
    };

    /// <summary>The string key for an operator's state in the panel.</summary>
    public static string StatusKey(string? status) => status switch
    {
        "available" => "callAgentAvailable",
        "busy" => "callAgentBusy",
        "away" => "callAgentAway",
        _ => "callAgentOffline",
    };

    /// <summary>Switched-on departments that take this kind of call (a missing switch counts as on, as on the Mac).</summary>
    public static IReadOnlyList<CallDepartment> Departments(IEnumerable<CallDepartment> all, bool video) =>
        all.Where(d => d.Enabled != false && (video ? d.CcVideoEnabled != false : d.CcVoiceEnabled != false)).ToList();
}

/// <summary>Small rules shared by the call window and the shell's call bar.</summary>
public static class CallRules
{
    /// <summary>
    /// The running time as the call page shows it: mm:ss, with hours in front
    /// (hh:mm:ss) once past the hour, in the language's digits.
    /// </summary>
    public static string Clock(TimeSpan elapsed, Localization.Language language)
    {
        var total = Math.Max(0, (long)elapsed.TotalSeconds);
        long h = total / 3600, m = total % 3600 / 60, s = total % 60;
        var text = (h > 0 ? h.ToString("00", CultureInfo.InvariantCulture) + ":" : string.Empty)
                   + m.ToString("00", CultureInfo.InvariantCulture) + ":" + s.ToString("00", CultureInfo.InvariantCulture);
        return Localization.Digits.Localize(text, language);
    }

    /// <summary>
    /// A failure of one poll that is worth trying again rather than giving up
    /// the call: no answer (offline a moment) or a server error. A refusal (4xx)
    /// or a 401 is final.
    /// </summary>
    public static bool IsTransient(Exception error) =>
        error is ApiException e && (e.Failure == ApiFailure.Transport || (e.Failure == ApiFailure.Server && e.Status >= 500));

    /// <summary>How many failed invitation polls in a row still leave the call ringing.</summary>
    public const int InvitationMisses = 5;
}
