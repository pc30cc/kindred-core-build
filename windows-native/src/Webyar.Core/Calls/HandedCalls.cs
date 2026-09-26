using Webyar.Core.Api;

namespace Webyar.Core.Calls;

/// <summary>
/// Calls a colleague handed to this operator (the Mac's noticeHandedCalls). A
/// transfer leaves the call live and assigned to this operator, with the
/// colleague still in the room until they join — long after it left the
/// waiting line, so the line alone never shows it. The shell feeds this the
/// calls under way every other queue poll; it keeps the one to offer in the
/// banner and says which call is new, so the chime and the notification sound
/// once per call.
/// </summary>
public sealed class HandedCalls
{
    private readonly HashSet<string> _seen = new(StringComparer.Ordinal);

    /// <summary>The call the banner offers to join, if any.</summary>
    public CallSession? Current { get; private set; }

    /// <summary>
    /// Mine: assigned to me, handed on by someone else, and not the call I am
    /// already on (a desk call answered here, or a handed call already joined).
    /// </summary>
    public static IReadOnlyList<CallSession> Mine(IEnumerable<CallSession> active, string me, string? onCallId) =>
        active.Where(c => c.AssignedAgentId == me
                          && c.TransferFromAgentId is { Length: > 0 } from && from != me
                          && c.Id != onCallId)
              .ToList();

    /// <summary>
    /// Takes the newest list of calls under way. The banner's call goes when it
    /// is over or joined from elsewhere; with no banner up, the first call not
    /// offered before becomes it and is returned (null otherwise).
    /// </summary>
    public CallSession? Notice(IEnumerable<CallSession> active, string? me, string? onCallId)
    {
        if (string.IsNullOrEmpty(me)) return null;
        var mine = Mine(active, me, onCallId);
        if (Current is { } shown && mine.All(c => c.Id != shown.Id)) Current = null;
        if (Current is not null) return null;
        var fresh = mine.FirstOrDefault(c => !_seen.Contains(c.Id));
        if (fresh is null) return null;
        _seen.Add(fresh.Id);
        Current = fresh;
        return fresh;
    }

    /// <summary>Closed from the banner, or joined: gone, and not offered again.</summary>
    public void Dismiss() => Current = null;

    /// <summary>Another workspace or operator: nothing from the old one is offered.</summary>
    public void Reset()
    {
        _seen.Clear();
        Current = null;
    }
}

/// <summary>After a transfer: whether whoever took the call is in the room yet.</summary>
public static class Handover
{
    /// <summary>Operators join the room as `operator:&lt;user id&gt;` (the server's LiveKit identity); visitors as anything else.</summary>
    public const string OperatorPrefix = "operator:";

    public static bool IsOperator(string? identity) => identity?.StartsWith(OperatorPrefix, StringComparison.Ordinal) == true;

    /// <summary>
    /// The colleague the call went to is in the room — for a department, any
    /// operator other than me, since the server picks who takes it.
    /// </summary>
    public static bool Joined(IEnumerable<string?> remoteIdentities, string? localIdentity, string? targetUserId) =>
        remoteIdentities.Any(id => IsOperator(id) && id != localIdentity
                                   && (string.IsNullOrEmpty(targetUserId) || id == OperatorPrefix + targetUserId));
}
