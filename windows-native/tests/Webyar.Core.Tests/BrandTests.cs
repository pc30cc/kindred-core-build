using System.Globalization;
using System.Text.RegularExpressions;
using Webyar.Core.Analytics;
using Webyar.Core.Inbox;
using Webyar.Core.Api;
using Webyar.Core.Config;
using Webyar.Core.Localization;
using Xunit;

namespace Webyar.Core.Tests;

/// <summary>
/// One source, two apps (Directory.Build.props, Brand.cs): the default build is
/// WebYar exactly as before, and -p:Brand=Respok is RESPOK with no trace of WebYar.
/// CI runs these tests once per brand.
/// </summary>
public partial class BrandTests
{
    [GeneratedRegex(@"webyar|web yar|وب[‌ ]?یار|وبیار", RegexOptions.IgnoreCase)]
    private static partial Regex WebyarWords();

    private static readonly Language[] Languages = [Language.Fa, Language.En, Language.Tr];

#if BRAND_RESPOK
    [Fact]
    public void Respok_signs_in_to_respok_and_updates_from_respok()
    {
        Assert.Equal("respok", Brand.Id);
        Assert.Equal(new Uri("https://api.respok.app"), ApiClient.DefaultOrigin);
        Assert.Equal("https://app.respok.app/downloads/windows", UpdateFeeds.SiteFeed);
        Assert.Equal(["pc30cc/respok-releases"], UpdateFeeds.GithubRepos);
    }

    [Fact]
    public void No_line_of_the_respok_app_names_webyar()
    {
        foreach (var language in Languages)
        {
            var s = new Strings(language);
            Assert.Equal("RESPOK", s["appName"]);
            foreach (var key in Keys())
                Assert.False(WebyarWords().IsMatch(s[key]), $"{Strings.Code(language)}.{key}: {s[key]}");
        }
    }

    [Fact]
    public void Respok_starts_in_the_systems_language_or_english()
    {
        Assert.Equal(Language.Tr, Strings.FirstLaunch(CultureInfo.GetCultureInfo("tr-TR")));
        Assert.Equal(Language.Fa, Strings.FirstLaunch(CultureInfo.GetCultureInfo("fa-IR")));
        Assert.Equal(Language.En, Strings.FirstLaunch(CultureInfo.GetCultureInfo("de-DE")));
        Assert.Equal(Language.En, Strings.FirstLaunch(CultureInfo.InvariantCulture));
    }

    [Fact]
    public void Respok_writes_persian_dates_on_the_gregorian_calendar()
    {
        var day = new DateTime(2026, 10, 9, 12, 0, 0, DateTimeKind.Utc);
        Assert.Equal("۲۰۲۶/۱۰/۰۹", Display.ShortDate(day, Language.Fa));
        Assert.IsType<GregorianCalendar>(Strings.CultureOf(Language.Fa).DateTimeFormat.Calendar);
        Assert.IsType<GregorianCalendar>(Strings.DateCultureOf(Language.Fa).DateTimeFormat.Calendar);
        // October, not Mehr; the 9th, not the 17th.
        var label = AnalyticsFormat.DayLabel(day, new Strings(Language.Fa));
        Assert.StartsWith("۹ ", label);
        Assert.DoesNotContain("مهر", label);
    }

    [Fact]
    public void Turkish_suffixes_follow_respok()
    {
        var tr = new Strings(Language.Tr);
        Assert.Equal("RESPOK'u aç", tr["trayOpen"]);
        Assert.Equal("RESPOK'tan çıkılsın mı?", tr["signOutConfirm"]);
    }
#else
    [Fact]
    public void Webyar_is_exactly_as_before()
    {
        Assert.Equal("webyar", Brand.Id);
        Assert.Equal(new Uri("https://api.webyar.ai"), ApiClient.DefaultOrigin);
        Assert.Equal("https://app.webyar.ai/downloads/windows", UpdateFeeds.SiteFeed);
        Assert.Equal(["pc30cc/webyar-desktop-releases"], UpdateFeeds.GithubRepos);
        Assert.Equal("وب‌یار", new Strings(Language.Fa)["appName"]);
        Assert.Equal("Webyar", new Strings(Language.En)["appName"]);
        Assert.Equal("Webyar'ı aç", new Strings(Language.Tr)["trayOpen"]);
    }

    [Fact]
    public void Webyar_starts_in_persian_and_writes_jalali_dates_as_before()
    {
        Assert.Equal(Language.Fa, Strings.FirstLaunch(CultureInfo.GetCultureInfo("en-US")));
        Assert.Equal(Language.En, Strings.FromSystem(CultureInfo.GetCultureInfo("en-US")));
        Assert.Equal(Language.Fa, Strings.FromSystem(CultureInfo.GetCultureInfo("de-DE")));
        var day = new DateTime(2026, 10, 9, 12, 0, 0, DateTimeKind.Utc);
        Assert.Equal("۱۴۰۵/۰۷/۱۷", Display.ShortDate(day, Language.Fa));
        Assert.Same(CultureInfo.GetCultureInfo("fa-IR"), Strings.CultureOf(Language.Fa));
        Assert.IsType<PersianCalendar>(Strings.DateCultureOf(Language.Fa).DateTimeFormat.Calendar);
        Assert.StartsWith("۱۷ ", AnalyticsFormat.DayLabel(day, new Strings(Language.Fa)));
    }
#endif

    /// <summary>Every key of the shared table (strings.json is embedded in every build).</summary>
    private static IEnumerable<string> Keys()
    {
        using var stream = typeof(Strings).Assembly.GetManifestResourceStream("Webyar.Core.strings.json")!;
        var raw = System.Text.Json.JsonSerializer.Deserialize<Dictionary<string, Dictionary<string, string>>>(stream)!;
        return raw.Values.SelectMany(d => d.Keys).Distinct();
    }

    [Fact]
    public void The_shared_table_lists_keys()
    {
        Assert.Contains("appName", Keys());
    }
}
