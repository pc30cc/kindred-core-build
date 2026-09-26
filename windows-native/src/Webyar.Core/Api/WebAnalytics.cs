using System.Text.Json.Serialization;

namespace Webyar.Core.Api;

// ── Website analytics (`/api/web-analytics/:workspaceId/…`), as the web's SEO → Web Analytics reads it ──
// These reports answer in camelCase, unlike the rest of the API, so every field names its key.

/// <summary>The headline numbers for a date range, and the day-by-day trend.</summary>
public sealed record WebAnalyticsOverview(
    [property: JsonPropertyName("sessions")] int? Sessions = null,
    [property: JsonPropertyName("pageviews")] int? Pageviews = null,
    [property: JsonPropertyName("avgPagesPerSession")] double? AvgPagesPerSession = null,
    [property: JsonPropertyName("uniqueVisitors")] int? UniqueVisitors = null,
    // Percentage, 0–100, of sessions with a single page view.
    [property: JsonPropertyName("bounceRate")] double? BounceRate = null,
    [property: JsonPropertyName("avgVisitDurationSeconds")] double? AvgVisitDurationSeconds = null,
    [property: JsonPropertyName("trend")] IReadOnlyList<WebAnalyticsDay>? Trend = null,
    [property: JsonPropertyName("topChannels")] IReadOnlyList<WebAnalyticsRow>? TopChannels = null,
    [property: JsonPropertyName("topPages")] IReadOnlyList<WebAnalyticsPage>? TopPages = null,
    [property: JsonPropertyName("truncated")] bool? Truncated = null);

public sealed record WebAnalyticsDay(
    // YYYY-MM-DD.
    [property: JsonPropertyName("date")] string Date,
    [property: JsonPropertyName("sessions")] int? Sessions = null,
    [property: JsonPropertyName("pageviews")] int? Pageviews = null);

/// <summary>One line of a "group by X, count sessions" report.</summary>
public sealed record WebAnalyticsRow(
    [property: JsonPropertyName("key")] string Key,
    [property: JsonPropertyName("label")] string? Label = null,
    [property: JsonPropertyName("sessions")] int? Sessions = null,
    [property: JsonPropertyName("pageviews")] int? Pageviews = null);

public sealed record WebAnalyticsPage(
    [property: JsonPropertyName("path")] string Path,
    [property: JsonPropertyName("views")] int? Views = null);

public sealed record WebAnalyticsEvent(
    [property: JsonPropertyName("eventName")] string EventName,
    [property: JsonPropertyName("count")] int? Count = null,
    [property: JsonPropertyName("uniqueSessions")] int? UniqueSessions = null,
    // 0–1: the share of the range's sessions that fired it.
    [property: JsonPropertyName("conversionRate")] double? ConversionRate = null);

/// <summary>A report's rows, and whether the server stopped short of the whole range.</summary>
public sealed record WebAnalyticsRows<TRow>(
    [property: JsonPropertyName("rows")] IReadOnlyList<TRow>? Rows = null,
    [property: JsonPropertyName("truncated")] bool? Truncated = null);

internal sealed record LiveVisitorsResponse([property: JsonPropertyName("count")] int? Count = null);

public sealed partial class WebyarApi
{
    private static string AnalyticsPath(string workspaceId, string tail) =>
        $"/api/web-analytics/{Uri.EscapeDataString(workspaceId)}/{tail}";

    private static KeyValuePair<string, string?>[] Range(string start, string end, params KeyValuePair<string, string?>[] more) =>
        [.. more, Q("startDate", start), Q("endDate", end)];

    public async Task<WebAnalyticsOverview> AnalyticsOverviewAsync(string workspaceId, string start, string end, CancellationToken ct = default) =>
        await _client.GetAsync<WebAnalyticsOverview>(AnalyticsPath(workspaceId, "overview"), Range(start, end), ct).ConfigureAwait(false) ?? new();

    /// <summary>Visitors on the site right now.</summary>
    public async Task<int> AnalyticsLiveVisitorsAsync(string workspaceId, CancellationToken ct = default) =>
        (await _client.GetAsync<LiveVisitorsResponse>(AnalyticsPath(workspaceId, "live-visitors"), ct: ct).ConfigureAwait(false))?.Count ?? 0;

    /// <summary>channel | source | campaign.</summary>
    public async Task<WebAnalyticsRows<WebAnalyticsRow>> AnalyticsTrafficSourcesAsync(string workspaceId, string dimension, string start, string end, CancellationToken ct = default) =>
        await _client.GetAsync<WebAnalyticsRows<WebAnalyticsRow>>(AnalyticsPath(workspaceId, "traffic-sources"), Range(start, end, Q("dimension", dimension)), ct).ConfigureAwait(false) ?? new();

    /// <summary>continent | country | city | language.</summary>
    public async Task<WebAnalyticsRows<WebAnalyticsRow>> AnalyticsGeographyAsync(string workspaceId, string dimension, string start, string end, CancellationToken ct = default) =>
        await _client.GetAsync<WebAnalyticsRows<WebAnalyticsRow>>(AnalyticsPath(workspaceId, "geography"), Range(start, end, Q("dimension", dimension)), ct).ConfigureAwait(false) ?? new();

    /// <summary>browser | os | device.</summary>
    public async Task<WebAnalyticsRows<WebAnalyticsRow>> AnalyticsTechnologyAsync(string workspaceId, string dimension, string start, string end, CancellationToken ct = default) =>
        await _client.GetAsync<WebAnalyticsRows<WebAnalyticsRow>>(AnalyticsPath(workspaceId, "browsers-systems"), Range(start, end, Q("dimension", dimension)), ct).ConfigureAwait(false) ?? new();

    /// <summary>top | entry | exit | new.</summary>
    public async Task<WebAnalyticsRows<WebAnalyticsPage>> AnalyticsPagesAsync(string workspaceId, string kind, string start, string end, CancellationToken ct = default) =>
        await _client.GetAsync<WebAnalyticsRows<WebAnalyticsPage>>(AnalyticsPath(workspaceId, "pages"), Range(start, end, Q("kind", kind)), ct).ConfigureAwait(false) ?? new();

    public async Task<WebAnalyticsRows<WebAnalyticsEvent>> AnalyticsEventsAsync(string workspaceId, string start, string end, CancellationToken ct = default) =>
        await _client.GetAsync<WebAnalyticsRows<WebAnalyticsEvent>>(AnalyticsPath(workspaceId, "events"), Range(start, end), ct).ConfigureAwait(false) ?? new();
}
