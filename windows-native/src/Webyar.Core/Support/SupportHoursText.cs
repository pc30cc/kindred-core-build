using Webyar.Core.Localization;

namespace Webyar.Core.Support;

/// <summary>
/// The team's week as the offline banner reads it: days in a row that keep
/// the same hours are one line — «شنبه تا چهارشنبه ۹:۰۰ تا ۱۷:۰۰»,
/// «پنجشنبه ۹:۰۰ تا ۱۳:۰۰», «جمعه تعطیل». The times are the support
/// workspace's own wall clock; <see cref="ZoneDiffers"/> says whether that
/// clock needs naming on this PC.
/// </summary>
public static class SupportHoursText
{
    /// <summary>The week Saturday first, as `/status` keys it.</summary>
    public static readonly IReadOnlyList<string> Week = ["sat", "sun", "mon", "tue", "wed", "thu", "fri"];

    /// <summary>Days in a row with the same hours; no intervals is closed.</summary>
    public sealed record DayGroup(string First, string Last, IReadOnlyList<SupportInterval> Intervals);

    public static IReadOnlyList<DayGroup> Groups(SupportHours hours)
    {
        var groups = new List<DayGroup>();
        foreach (var day in Week)
        {
            IReadOnlyList<SupportInterval> given = hours.Weekly is { } w && w.TryGetValue(day, out var list) && list is not null ? list : [];
            var intervals = given
                .Where(i => !string.IsNullOrWhiteSpace(i.From) && !string.IsNullOrWhiteSpace(i.To))
                .OrderBy(i => i.From, StringComparer.Ordinal)
                .Select(i => new SupportInterval(i.From!.Trim(), i.To!.Trim()))
                .ToList();
            if (groups.Count > 0 && groups[^1].Intervals.SequenceEqual(intervals))
                groups[^1] = groups[^1] with { Last = day };
            else
                groups.Add(new DayGroup(day, day, intervals));
        }
        // A week with no opening at all says nothing useful as seven closed days.
        return groups.All(g => g.Intervals.Count == 0) ? [] : groups;
    }

    public static string Weekday(string key, Strings s) => s["supportWeekday" + char.ToUpperInvariant(key[0]) + key[1..]];

    /// <summary>One line per group of days.</summary>
    public static IReadOnlyList<string> Lines(SupportHours hours, Strings s) => Groups(hours).Select(g =>
    {
        var first = Weekday(g.First, s);
        var days = g.First == g.Last ? first : s.Get("supportDayRange", new Dictionary<string, object> { ["first"] = first, ["last"] = Weekday(g.Last, s) });
        if (g.Intervals.Count == 0) return s.Get("supportClosedDays", "days", days);
        var times = string.Join(s.Language == Language.Fa ? "، " : ", ", g.Intervals.Select(i =>
            s.Get("supportInterval", new Dictionary<string, object>
            {
                ["from"] = SupportRules.OpeningTime(i.From!, s.Language),
                ["to"] = SupportRules.OpeningTime(i.To!, s.Language),
            })));
        return s.Get("supportHoursLine", new Dictionary<string, object> { ["days"] = days, ["times"] = times });
    }).ToList();

    /// <summary>
    /// Whether <paramref name="timezone"/> keeps another clock than
    /// <paramref name="device"/>, and so has to be named under the hours.
    /// An id nobody knows is named as it is.
    /// </summary>
    public static bool ZoneDiffers(string? timezone, TimeZoneInfo? device = null)
    {
        if (string.IsNullOrWhiteSpace(timezone)) return false;
        device ??= TimeZoneInfo.Local;
        var zone = Find(timezone);
        if (zone is null) return true;
        return zone.Id != device.Id && !zone.HasSameRules(device);
    }

    /// <summary>A time zone as Windows names it, or its IANA id when it has no name for it.</summary>
    public static string ZoneName(string timezone) =>
        Find(timezone) is { } zone && !string.IsNullOrWhiteSpace(zone.DisplayName) ? zone.DisplayName : timezone;

    private static TimeZoneInfo? Find(string id)
    {
        try
        {
            return TimeZoneInfo.FindSystemTimeZoneById(id.Trim());
        }
        catch (Exception e) when (e is TimeZoneNotFoundException or InvalidTimeZoneException or ArgumentException)
        {
            return null;
        }
    }
}
