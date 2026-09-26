using System.Net;
using Webyar.Core.Analytics;
using Webyar.Core.Api;
using Webyar.Core.Localization;
using Xunit;

namespace Webyar.Core.Tests;

public class AnalyticsTests
{
    private static readonly Strings En = new(Language.En);
    private static readonly Strings Fa = new(Language.Fa);
    private static readonly Strings Tr = new(Language.Tr);

    private static (WebyarApi Api, FakeHttp Http) Make(Func<HttpRequestMessage, string?, (HttpStatusCode, string)> route)
    {
        var http = new FakeHttp(route);
        return (new WebyarApi(new ApiClient(new MemorySessionStore("t"), handler: http)), http);
    }

    [Fact]
    public async Task Reports_decode_the_camel_case_answers_and_send_the_range()
    {
        var (api, http) = Make((req, _) => req.RequestUri!.AbsolutePath switch
        {
            "/api/web-analytics/w1/overview" => (HttpStatusCode.OK,
                """{"sessions":120,"pageviews":300,"avgPagesPerSession":2.5,"uniqueVisitors":90,"bounceRate":41.5,"avgVisitDurationSeconds":75,"trend":[{"date":"2026-09-20","sessions":4,"pageviews":9}],"topChannels":[{"key":"organic_search","label":"Organic Search","sessions":60,"pageviews":150}],"topPages":[{"path":"/pricing","views":40}],"truncated":false}"""),
            "/api/web-analytics/w1/live-visitors" => (HttpStatusCode.OK, """{"count":7}"""),
            "/api/web-analytics/w1/events" => (HttpStatusCode.OK, """{"rows":[{"eventName":"signup","count":12,"uniqueSessions":10,"conversionRate":0.08}],"truncated":true}"""),
            _ => (HttpStatusCode.OK, """{"rows":[],"truncated":false}"""),
        });

        var o = await api.AnalyticsOverviewAsync("w1", "2026-08-29", "2026-09-25");
        Assert.Equal(120, o.Sessions);
        Assert.Equal(90, o.UniqueVisitors);
        Assert.Equal(2.5, o.AvgPagesPerSession);
        Assert.Equal(41.5, o.BounceRate);
        Assert.Equal(75, o.AvgVisitDurationSeconds);
        Assert.Equal("2026-09-20", o.Trend!.Single().Date);
        Assert.Equal("organic_search", o.TopChannels!.Single().Key);
        Assert.Equal(40, o.TopPages!.Single().Views);
        Assert.Contains("startDate=2026-08-29", http.Requests[0].Request.RequestUri!.Query);
        Assert.Contains("endDate=2026-09-25", http.Requests[0].Request.RequestUri!.Query);

        Assert.Equal(7, await api.AnalyticsLiveVisitorsAsync("w1"));

        var events = await api.AnalyticsEventsAsync("w1", "2026-08-29", "2026-09-25");
        Assert.True(events.Truncated);
        var e = events.Rows!.Single();
        Assert.Equal("signup", e.EventName);
        Assert.Equal(10, e.UniqueSessions);
        Assert.Equal(0.08, e.ConversionRate);

        await api.AnalyticsTrafficSourcesAsync("w1", "campaign", "a", "b");
        Assert.Equal("/api/web-analytics/w1/traffic-sources", http.Requests[^1].Request.RequestUri!.AbsolutePath);
        Assert.Contains("dimension=campaign", http.Requests[^1].Request.RequestUri!.Query);
        await api.AnalyticsTechnologyAsync("w1", "os", "a", "b");
        Assert.Equal("/api/web-analytics/w1/browsers-systems", http.Requests[^1].Request.RequestUri!.AbsolutePath);
        await api.AnalyticsPagesAsync("w1", "exit", "a", "b");
        Assert.Contains("kind=exit", http.Requests[^1].Request.RequestUri!.Query);
    }

    [Fact]
    public void Ranges_end_today_in_utc_and_the_previous_one_ends_where_it_starts()
    {
        var now = new DateTimeOffset(2026, 9, 25, 23, 30, 0, TimeSpan.FromHours(-5)); // 04:30 UTC on the 26th
        Assert.Equal(("2026-08-30", "2026-09-26"), AnalyticsRange.Month.Bounds(now));
        Assert.Equal(("2026-08-02", "2026-08-29"), AnalyticsRange.Month.PreviousBounds(now));
        Assert.Equal(("2026-09-20", "2026-09-26"), AnalyticsRange.Week.Bounds(now));
        Assert.Equal(("2026-06-29", "2026-09-26"), AnalyticsRange.Quarter.Bounds(now));
    }

    [Fact]
    public void Numbers_and_shares_are_written_the_way_each_language_writes_them()
    {
        Assert.Equal("1,234", AnalyticsFormat.Count(1234, En));
        Assert.Contains("۱", AnalyticsFormat.Count(1234, Fa));
        Assert.Equal("12%", AnalyticsFormat.Percent(0.12, En));
        Assert.Equal("%12", AnalyticsFormat.Percent(0.12, Tr));
        Assert.Equal("۱۲٪", AnalyticsFormat.Percent(0.12, Fa));
        // A small non-zero share keeps a decimal.
        Assert.Equal("4.5%", AnalyticsFormat.Percent(0.045, En));
        Assert.Equal("0%", AnalyticsFormat.Percent(0, En));
        Assert.Equal($"45 {En["waSeconds"]}", AnalyticsFormat.Duration(45, En));
        Assert.Equal($"2 {En["waMinutes"]} 5 {En["waSeconds"]}", AnalyticsFormat.Duration(125, En));
    }

    [Fact]
    public void The_change_is_only_given_against_a_period_that_had_something()
    {
        Assert.Equal(0.5, AnalyticsFormat.Change(150, 100));
        Assert.Equal(-0.25, AnalyticsFormat.Change(75, 100));
        Assert.Null(AnalyticsFormat.Change(10, 0));
        Assert.Null(AnalyticsFormat.Change(null, 10));
    }

    [Fact]
    public void Days_are_read_in_utc_and_persian_uses_its_own_calendar()
    {
        var day = AnalyticsFormat.ParseDay("2026-09-23");
        Assert.Equal(new DateTime(2026, 9, 23, 0, 0, 0, DateTimeKind.Utc), day);
        Assert.Null(AnalyticsFormat.ParseDay("not a day"));
        Assert.Equal("23 Sep", AnalyticsFormat.DayLabel(day!.Value, En));
        // 23 September 2026 is 1 Mehr 1405.
        var fa = AnalyticsFormat.DayLabel(day.Value, Fa);
        Assert.StartsWith("۱ ", fa);
        Assert.DoesNotContain("Sep", fa);
    }

    [Fact]
    public void Keys_are_translated_and_unknown_ones_stay_as_they_are()
    {
        Assert.Equal(En["waChannel_organic_search"], AnalyticsFormat.Channel("organic_search", En));
        Assert.NotEqual("organic_search", AnalyticsFormat.Channel("organic_search", Fa));
        Assert.Equal("carrier_pigeon", AnalyticsFormat.Channel("carrier_pigeon", Fa));
        Assert.Equal(Fa["waDevice_mobile"], AnalyticsFormat.Device("Mobile", Fa));
        Assert.Equal(Tr["waUnknown"], AnalyticsFormat.Unknown("(unknown)", Tr));
        Assert.Equal("Berlin", AnalyticsFormat.Unknown("Berlin", Tr));
    }

    [Fact]
    public void Every_analytics_line_is_in_every_language()
    {
        var keys = new List<string> { "navAnalytics", "waSubtitle", "waLiveNow", "waVsPrevious", "waLocked", "waLockedHint", "waTruncated", "waLeader", "waDistinct" };
        foreach (var section in AnalyticsSections.All)
        {
            keys.Add(section.TitleKey());
            keys.Add(section.HintKey());
        }
        foreach (AnalyticsRange r in Enum.GetValues<AnalyticsRange>()) keys.Add(r.RangeKey());
        foreach (var s in new[] { En, Fa, Tr })
            foreach (var key in keys)
                Assert.NotEqual(key, s[key]);
        Assert.Contains("۱۲", Fa.Get("waLiveNow", "count", AnalyticsFormat.Count(12, Fa)));
    }

    [Fact]
    public void Countries_get_their_code_and_a_name_in_the_readers_language()
    {
        Assert.Equal("IR", LocalNames.RegionCode("Iran"));
        Assert.Equal("TR", LocalNames.RegionCode("Turkey"));
        Assert.Equal("DE", LocalNames.RegionCode("Germany"));
        Assert.Null(LocalNames.RegionCode("Atlantis"));
        var (badge, name) = AnalyticsFormat.Country("Germany", Fa);
        Assert.Equal("DE", badge);
        Assert.Equal("آلمان", name);
        Assert.Equal("Almanya", AnalyticsFormat.Country("Germany", Tr).Name);
        Assert.Equal("Germany", AnalyticsFormat.Country("Germany", En).Name);
        Assert.Equal((null, "Atlantis"), AnalyticsFormat.Country("Atlantis", En));
        Assert.Equal("Persian (Iran)", AnalyticsFormat.LanguageName("fa-IR", En));
        Assert.Equal("Farsça (İran)", AnalyticsFormat.LanguageName("fa-IR", Tr));
    }
}
