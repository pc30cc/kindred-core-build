using System.Globalization;
using Webyar.Core.Api;

namespace Webyar.Core.Inbox;

/// <summary>
/// Which conversations deserve a Windows notification — the rules the web
/// console and the Electron app apply, over the operator's own notification
/// preferences (the same row the web console edits).
/// </summary>
public sealed class NotificationRules
{
    private Dictionary<string, DateTimeOffset>? _seen;

    /// <summary>
    /// Conversations whose newest message is a visitor's, is newer than when we
    /// last looked, and is still unread. The first call only sets the baseline:
    /// nothing already there when the app opens is "new".
    /// </summary>
    public IReadOnlyList<Conversation> Fresh(IEnumerable<Conversation> conversations)
    {
        var list = conversations.ToList();
        if (_seen is null)
        {
            _seen = list.ToDictionary(c => c.Id, Stamp);
            return [];
        }
        var fresh = list.Where(c =>
                Stamp(c) > (_seen.TryGetValue(c.Id, out var before) ? before : DateTimeOffset.MinValue) &&
                c.LastMessage?.SenderType == SenderTypes.Contact &&
                (c.UnreadCount ?? 1) > 0)
            .ToList();
        foreach (var c in list) _seen[c.Id] = Stamp(c);
        return fresh;
    }

    /// <summary>Forget the baseline, e.g. after switching workspace.</summary>
    public void Reset() => _seen = null;

    private static DateTimeOffset Stamp(Conversation c) => c.LastMessage?.CreatedAt ?? DateTimeOffset.MinValue;

    public static bool Allowed(NotificationPrefs prefs, DateTimeOffset now) =>
        !prefs.DisableAll && prefs.PushScope != "none" && !InQuietHours(prefs, now);

    /// <summary>"Assigned" and "mentions" both mean: not every thread in the workspace.</summary>
    public static bool InScope(NotificationPrefs prefs, Conversation c, string? me) =>
        prefs.PushScope == "all" || (me is not null && c.AssignedTo == me);

    public static bool InQuietHours(NotificationPrefs p, DateTimeOffset now)
    {
        if (!p.QuietHoursEnabled || !TryMinutes(p.QuietHoursStart, out var start) || !TryMinutes(p.QuietHoursEnd, out var end)) return false;
        var zone = TimeZoneInfo.Local;
        if (!string.IsNullOrWhiteSpace(p.QuietHoursTimezone))
        {
            try
            {
                zone = TimeZoneInfo.FindSystemTimeZoneById(p.QuietHoursTimezone);
            }
            catch (Exception e) when (e is TimeZoneNotFoundException or InvalidTimeZoneException)
            {
            }
        }
        var t = TimeZoneInfo.ConvertTime(now, zone);
        var minutes = t.Hour * 60 + t.Minute;
        return start <= end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
    }

    private static bool TryMinutes(string? hhmm, out int minutes)
    {
        minutes = 0;
        if (string.IsNullOrWhiteSpace(hhmm)) return false;
        var parts = hhmm.Split(':');
        if (parts.Length < 2 ||
            !int.TryParse(parts[0], NumberStyles.None, CultureInfo.InvariantCulture, out var h) ||
            !int.TryParse(parts[1], NumberStyles.None, CultureInfo.InvariantCulture, out var m)) return false;
        minutes = h * 60 + m;
        return true;
    }
}
