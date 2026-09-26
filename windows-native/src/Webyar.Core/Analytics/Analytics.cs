using System.Globalization;
using Webyar.Core.Inbox;
using Webyar.Core.Localization;

namespace Webyar.Core.Analytics;

/// <summary>The website analytics' pages, in the order the list shows them (as the Mac app).</summary>
public enum AnalyticsSection
{
    Overview,
    Sources,
    Pages,
    Geography,
    Technology,
    Events,
}

/// <summary>The date range every report shares: the last 7, 28 or 90 days, today included.</summary>
public enum AnalyticsRange
{
    Week = 7,
    Month = 28,
    Quarter = 90,
}

public static class AnalyticsSections
{
    public static readonly AnalyticsSection[] All = Enum.GetValues<AnalyticsSection>();

    public static string TitleKey(this AnalyticsSection section) => section switch
    {
        AnalyticsSection.Sources => "waSources",
        AnalyticsSection.Pages => "waPages",
        AnalyticsSection.Geography => "waGeography",
        AnalyticsSection.Technology => "waTechnology",
        AnalyticsSection.Events => "waEvents",
        _ => "waOverview",
    };

    public static string HintKey(this AnalyticsSection section) => section.TitleKey() + "Hint";

    /// <summary>Each report's own colour (RGB), for its tile in the list and its accents on the page.</summary>
    public static uint Tint(this AnalyticsSection section) => section switch
    {
        AnalyticsSection.Sources => 0x6E56CF,
        AnalyticsSection.Pages => 0x0EA5A4,
        AnalyticsSection.Geography => 0x30A46C,
        AnalyticsSection.Technology => 0xF76B15,
        AnalyticsSection.Events => 0xD6409F,
        _ => 0x3B7AF2,
    };

    /// <summary>A Segoe Fluent Icons glyph for the report.</summary>
    public static string Glyph(this AnalyticsSection section) => section switch
    {
        AnalyticsSection.Sources => "",
        AnalyticsSection.Pages => "",
        AnalyticsSection.Geography => "",
        AnalyticsSection.Technology => "",
        AnalyticsSection.Events => "",
        _ => "",
    };

    public static string RangeKey(this AnalyticsRange range) => $"waRange{(int)range}";

    /// <summary>YYYY-MM-DD bounds, in UTC as the server counts days.</summary>
    public static (string Start, string End) Bounds(this AnalyticsRange range, DateTimeOffset now) => Bounds(range, now, 0);

    /// <summary>The same number of days just before, for "compared with the period before".</summary>
    public static (string Start, string End) PreviousBounds(this AnalyticsRange range, DateTimeOffset now) => Bounds(range, now, (int)range);

    private static (string, string) Bounds(AnalyticsRange range, DateTimeOffset now, int offset)
    {
        var end = now.UtcDateTime.Date.AddDays(-offset);
        var start = end.AddDays(-((int)range - 1));
        return (Day(start), Day(end));
    }

    private static string Day(DateTime d) => d.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
}

/// <summary>Numbers, shares, durations, dates and names the way each language writes them (the Mac app's AnalyticsFormat).</summary>
public static class AnalyticsFormat
{
    public static string Count(int n, Strings s) => Digits.Localize(n.ToString("N0", s.Culture), s.Language);

    public static string Decimal(double v, Strings s) => Digits.Localize(v.ToString("N1", s.Culture), s.Language);

    /// <summary>`fraction` is 0–1; a small non-zero share keeps one decimal.</summary>
    public static string Percent(double fraction, Strings s)
    {
        var digits = fraction is > 0 and < 0.1 ? 1 : 0;
        var number = Math.Round(fraction * 100, digits, MidpointRounding.AwayFromZero).ToString("N" + digits, s.Culture);
        var text = s.Language switch
        {
            Language.Fa => number + "٪",
            Language.Tr => "%" + number,
            _ => number + "%",
        };
        return Digits.Localize(text, s.Language);
    }

    public static string Duration(double seconds, Strings s)
    {
        var total = Math.Max(0, (int)Math.Round(seconds));
        int m = total / 60, sec = total % 60;
        if (m == 0) return $"{Count(sec, s)} {s["waSeconds"]}";
        return $"{Count(m, s)} {s["waMinutes"]} {Count(sec, s)} {s["waSeconds"]}";
    }

    /// <summary>The relative change from the period before, when both are known and the old one is not zero.</summary>
    public static double? Change(double? now, double? before) =>
        now is { } n && before is { } b && b > 0 ? (n - b) / b : null;

    /// <summary>A server day (YYYY-MM-DD), as a UTC date.</summary>
    public static DateTime? ParseDay(string? text) =>
        DateTime.TryParseExact(text, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.AdjustToUniversal | DateTimeStyles.AssumeUniversal, out var d)
            ? DateTime.SpecifyKind(d, DateTimeKind.Utc)
            : null;

    /// <summary>"12 Mehr" / "4 Oct" (long: "Saturday 4 October"), in the Persian calendar for Persian.</summary>
    public static string DayLabel(DateTime date, Strings s, bool longForm = false)
    {
        var culture = (CultureInfo)s.Culture.Clone();
        if (s.Language == Language.Fa) culture.DateTimeFormat.Calendar = new PersianCalendar();
        return Digits.Localize(date.ToString(longForm ? "dddd d MMMM" : "d MMM", culture), s.Language);
    }

    /// <summary>A channel's key ("organic_search") in the reader's language.</summary>
    public static string Channel(string key, Strings s) => Keyed("waChannel_" + key, key, s);

    /// <summary>"mobile" → "Mobile" in the reader's language.</summary>
    public static string Device(string key, Strings s) => Keyed("waDevice_" + key.ToLowerInvariant(), key, s);

    private static string Keyed(string key, string fallback, Strings s)
    {
        var v = s[key];
        return v == key ? fallback : v;
    }

    /// <summary>The server's "(unknown)" bucket, in the reader's language.</summary>
    public static string Unknown(string? label, Strings s) =>
        string.IsNullOrEmpty(label) || label == "(unknown)" ? s["waUnknown"] : label;

    public static string DeviceGlyph(string key)
    {
        var k = key.ToLowerInvariant();
        if (k.Contains("mobile") || k.Contains("phone")) return "";
        if (k.Contains("tablet") || k.Contains("ipad")) return "";
        return "";
    }

    public static string OsGlyph(string key) => AvatarArt.OsOf(key) switch
    {
        AvatarOs.Windows => "",
        AvatarOs.Apple => "",
        AvatarOs.Android => "",
        AvatarOs.Linux => "",
        _ => "",
    };

    /// <summary>The country's two letters and its name in the reader's language, from the English name the server keeps.</summary>
    public static (string? Badge, string Name) Country(string name, Strings s)
    {
        if (LocalNames.RegionCode(name) is not { } code) return (null, name);
        return (AvatarArt.CountryBadge(code), LocalNames.Country(code, s.Language) ?? name);
    }

    /// <summary>"fa-IR" → "Persian (Iran)", in the reader's language.</summary>
    public static string LanguageName(string tag, Strings s) => LocalNames.LanguageName(tag, s.Language) ?? tag;
}

/// <summary>
/// Country and language names in Persian, Turkish or English, from the
/// system's own locale data (ICU): the country's name is read out of a
/// culture of that country ("آلمانی (آلمان)" → "آلمان").
/// </summary>
public static class LocalNames
{
    private static readonly object Gate = new();
    private static Dictionary<string, string>? _codeByName;
    private static Dictionary<string, string>? _cultureByRegion;
    private static readonly Dictionary<(Language, string), string?> Cache = [];

    /// <summary>The names the geo databases use where they differ from the system's.</summary>
    private static readonly Dictionary<string, string> Aliases = new(StringComparer.OrdinalIgnoreCase)
    {
        ["iran"] = "IR", ["russia"] = "RU", ["south korea"] = "KR", ["united states"] = "US", ["united kingdom"] = "GB",
        ["turkey"] = "TR", ["türkiye"] = "TR", ["czech republic"] = "CZ", ["czechia"] = "CZ", ["vietnam"] = "VN",
        ["syria"] = "SY", ["hong kong"] = "HK", ["the netherlands"] = "NL", ["uae"] = "AE",
    };

    public static string? RegionCode(string englishName)
    {
        var key = englishName.Trim();
        if (key.Length == 0) return null;
        if (Aliases.TryGetValue(key, out var alias)) return alias;
        lock (Gate)
        {
            Load();
            return _codeByName!.TryGetValue(key, out var code) ? code : null;
        }
    }

    public static string? Country(string code, Language language)
    {
        code = code.ToUpperInvariant();
        lock (Gate)
        {
            if (Cache.TryGetValue((language, "c:" + code), out var hit)) return hit;
            Load();
            string? name = null;
            if (_cultureByRegion!.TryGetValue(code, out var culture))
            {
                var display = Display(culture, language);
                var open = display?.LastIndexOf('(') ?? -1;
                var close = display?.LastIndexOf(')') ?? -1;
                if (display is not null && open >= 0 && close > open) name = display[(open + 1)..close].Trim();
            }
            if (string.IsNullOrEmpty(name))
            {
                try { name = new RegionInfo(code).EnglishName; } catch (ArgumentException) { name = null; }
            }
            Cache[(language, "c:" + code)] = name;
            return name;
        }
    }

    public static string? LanguageName(string tag, Language language)
    {
        lock (Gate)
        {
            if (Cache.TryGetValue((language, "l:" + tag), out var hit)) return hit;
            var name = Display(tag.Replace('_', '-'), language);
            Cache[(language, "l:" + tag)] = name;
            return name;
        }
    }

    private static string? Display(string cultureName, Language language)
    {
        var ui = CultureInfo.CurrentUICulture;
        try
        {
            CultureInfo.CurrentUICulture = Strings.CultureOf(language);
            var c = new CultureInfo(cultureName);
            // An unknown tag comes back as itself; that is no name.
            return string.IsNullOrEmpty(c.DisplayName) || string.Equals(c.DisplayName, cultureName, StringComparison.OrdinalIgnoreCase) ? null : c.DisplayName;
        }
        catch (CultureNotFoundException)
        {
            return null;
        }
        finally
        {
            CultureInfo.CurrentUICulture = ui;
        }
    }

    private static void Load()
    {
        if (_codeByName is not null) return;
        var byName = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        var byRegion = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var c in CultureInfo.GetCultures(CultureTypes.SpecificCultures))
        {
            RegionInfo r;
            try { r = new RegionInfo(c.Name); } catch (ArgumentException) { continue; }
            var code = r.TwoLetterISORegionName;
            if (code.Length != 2 || !char.IsAsciiLetter(code[0])) continue;
            byName.TryAdd(r.EnglishName, code);
            // A plain language-country culture ("de-DE"), not one with a script ("sr-Latn-RS").
            if (c.Name.Split('-').Length == 2 && (!byRegion.TryGetValue(code, out var had) || had.Length > c.Name.Length)) byRegion[code] = c.Name;
        }
        _codeByName = byName;
        _cultureByRegion = byRegion;
    }
}
