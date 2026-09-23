using System.Globalization;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Webyar.Core.Localization;

public enum Language
{
    Fa,
    En,
    Tr,
}

/// <summary>
/// The app's copy in Persian, English and Turkish — the same sentences the iOS
/// app and the web console use (see scripts/export-strings.mjs). `{name}`
/// placeholders are filled in, numbers in the language's own digits.
/// </summary>
public sealed partial class Strings
{
    private readonly Dictionary<Language, Dictionary<string, string>> _table;

    public Strings(Language language)
    {
        Language = language;
        _table = Shared.Value;
    }

    private static readonly Lazy<Dictionary<Language, Dictionary<string, string>>> Shared = new(Load);

    public Language Language { get; }

    public bool IsRightToLeft => Language == Language.Fa;

    public CultureInfo Culture => CultureOf(Language);

    public static CultureInfo CultureOf(Language language) => language switch
    {
        Language.Fa => CultureInfo.GetCultureInfo("fa-IR"),
        Language.Tr => CultureInfo.GetCultureInfo("tr-TR"),
        _ => CultureInfo.GetCultureInfo("en-US"),
    };

    public static string Code(Language language) => language switch
    {
        Language.Fa => "fa",
        Language.Tr => "tr",
        _ => "en",
    };

    public static Language? Parse(string? code) => code?.Trim().ToLowerInvariant() switch
    {
        "fa" or "fa-ir" => Language.Fa,
        "tr" or "tr-tr" => Language.Tr,
        "en" or "en-us" or "en-gb" => Language.En,
        _ => null,
    };

    /// <summary>The first launch follows Windows' language when it is one of ours, Persian otherwise.</summary>
    public static Language FromSystem(CultureInfo culture) =>
        Parse(culture.TwoLetterISOLanguageName) ?? Language.Fa;

    public string this[string key] => Get(key);

    public string Get(string key, IReadOnlyDictionary<string, object>? args = null)
    {
        var raw = Lookup(Language, key) ?? Lookup(Language.En, key) ?? key;
        if (args is null || args.Count == 0) return raw;
        return Placeholder().Replace(raw, m =>
        {
            if (!args.TryGetValue(m.Groups[1].Value, out var value)) return m.Value;
            return value switch
            {
                int i => Digits.Localize(i.ToString(CultureInfo.InvariantCulture), Language),
                long l => Digits.Localize(l.ToString(CultureInfo.InvariantCulture), Language),
                double d => Digits.Localize(d.ToString(CultureInfo.InvariantCulture), Language),
                _ => value?.ToString() ?? string.Empty,
            };
        });
    }

    public string Get(string key, string name, object value) =>
        Get(key, new Dictionary<string, object> { [name] = value });

    public bool Has(string key) => Lookup(Language.En, key) is not null;

    private string? Lookup(Language language, string key) =>
        _table.TryGetValue(language, out var dict) && dict.TryGetValue(key, out var s) && s.Length > 0 ? s : null;

    [GeneratedRegex(@"\{(\w+)\}")]
    private static partial Regex Placeholder();

    private static Dictionary<Language, Dictionary<string, string>> Load()
    {
        using var stream = typeof(Strings).Assembly.GetManifestResourceStream("Webyar.Core.strings.json")
            ?? throw new InvalidOperationException("strings.json is not embedded");
        var raw = JsonSerializer.Deserialize<Dictionary<string, Dictionary<string, string>>>(stream)
            ?? throw new InvalidOperationException("strings.json is empty");
        var table = new Dictionary<Language, Dictionary<string, string>>();
        foreach (var (code, dict) in raw)
        {
            if (Parse(code) is { } language) table[language] = dict;
        }
        return table;
    }
}

/// <summary>Western digits to Persian ones, the way every Persian UI in the product writes numbers.</summary>
public static class Digits
{
    private const string Persian = "۰۱۲۳۴۵۶۷۸۹";

    public static string Localize(string text, Language language)
    {
        if (language != Language.Fa) return text;
        return string.Create(text.Length, text, (span, source) =>
        {
            for (var i = 0; i < source.Length; i++)
            {
                var c = source[i];
                span[i] = c is >= '0' and <= '9' ? Persian[c - '0'] : c;
            }
        });
    }
}
