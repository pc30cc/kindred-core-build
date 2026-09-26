using System.Text.Json;
using Webyar.Core.Api;

namespace Webyar.Core.Config;

/// <summary>
/// Super Admin → Windows app, as served by `GET /api/platform/desktop-app`:
/// where updates come from, how often to look, and how hard to poll. Read on
/// launch and hourly, so a change reaches every installed copy without a release.
/// </summary>
public sealed record DesktopConfig(
    UpdateSettings Update,
    bool RealtimeEnabled,
    int PollIntervalSeconds,
    int PollWithRealtimeSeconds,
    bool CallsEnabled)
{
    public static readonly DesktopConfig Defaults = new(
        new UpdateSettings(
            FeedUrl: null,
            Channel: "stable",
            LatestVersion: null,
            MinimumSupportedVersion: null,
            DownloadUrl: null,
            ReleaseNotes: null,
            AutoUpdate: true,
            CheckIntervalMinutes: 240),
        RealtimeEnabled: true,
        PollIntervalSeconds: 15,
        PollWithRealtimeSeconds: 120,
        CallsEnabled: true);

    /// <summary>
    /// Reads whatever the server sent defensively: a missing or out-of-range
    /// field falls back on its own, never the whole answer.
    /// </summary>
    public static DesktopConfig Parse(JsonElement root)
    {
        var d = Defaults;
        var update = Obj(root, "update");
        var realtime = Obj(root, "realtime");
        var polling = Obj(root, "polling");
        var features = Obj(root, "features");
        return new DesktopConfig(
            new UpdateSettings(
                FeedUrl: Https(Str(update, "feedUrl")),
                Channel: Str(update, "channel") == "beta" ? "beta" : "stable",
                LatestVersion: Str(update, "latestVersion"),
                MinimumSupportedVersion: Str(update, "minimumSupportedVersion"),
                DownloadUrl: Https(Str(update, "downloadUrl")),
                ReleaseNotes: Str(update, "releaseNotes"),
                AutoUpdate: Bool(update, "autoUpdate") ?? d.Update.AutoUpdate,
                CheckIntervalMinutes: Clamp(Int(update, "checkIntervalMinutes"), 15, 1440, d.Update.CheckIntervalMinutes)),
            RealtimeEnabled: Bool(realtime, "enabled") ?? d.RealtimeEnabled,
            PollIntervalSeconds: Clamp(Int(polling, "intervalSeconds"), 5, 300, d.PollIntervalSeconds),
            PollWithRealtimeSeconds: Clamp(Int(polling, "withRealtimeSeconds"), 15, 900, d.PollWithRealtimeSeconds),
            CallsEnabled: Bool(features, "calls") ?? d.CallsEnabled);
    }

    /// <summary>The platform's settings, or null when it could not be asked.</summary>
    public static async Task<DesktopConfig?> FetchAsync(ApiClient client, CancellationToken ct = default)
    {
        try
        {
            var root = await client.GetAsync<JsonElement>("/api/platform/desktop-app", ct: ct).ConfigureAwait(false);
            return root.ValueKind == JsonValueKind.Object ? Parse(root) : null;
        }
        catch (ApiException)
        {
            return null;
        }
    }

    private static JsonElement? Obj(JsonElement e, string name) =>
        e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Object ? v : null;

    private static string? Str(JsonElement? e, string name) =>
        e is { } o && o.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String && v.GetString() is { } s && s.Trim().Length > 0 ? s.Trim() : null;

    private static bool? Bool(JsonElement? e, string name) =>
        e is { } o && o.TryGetProperty(name, out var v) && v.ValueKind is JsonValueKind.True or JsonValueKind.False ? v.GetBoolean() : null;

    private static int? Int(JsonElement? e, string name) =>
        e is { } o && o.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Number && v.TryGetDouble(out var n) && double.IsFinite(n) ? (int)Math.Round(n) : null;

    private static int Clamp(int? v, int min, int max, int fallback) => v is { } n ? Math.Clamp(n, min, max) : fallback;

    private static string? Https(string? v) =>
        v is not null && Uri.TryCreate(v, UriKind.Absolute, out var u) && u.Scheme == Uri.UriSchemeHttps ? v.TrimEnd('/') : null;
}

public sealed record UpdateSettings(
    string? FeedUrl,
    string Channel,
    string? LatestVersion,
    string? MinimumSupportedVersion,
    string? DownloadUrl,
    string? ReleaseNotes,
    bool AutoUpdate,
    int CheckIntervalMinutes)
{
    /// <summary>True when <paramref name="current"/> is older than the minimum the platform still supports.</summary>
    public bool IsBelowMinimum(Version current) =>
        SemVer.TryParse(MinimumSupportedVersion, out var min) && SemVer.Compare(current, min) < 0;
}

/// <summary>Just enough semver for "is this build too old": major.minor.patch, pre-release ignored.</summary>
public static class SemVer
{
    public static bool TryParse(string? text, out Version version)
    {
        version = new Version(0, 0, 0);
        if (string.IsNullOrWhiteSpace(text)) return false;
        var core = text.Trim().TrimStart('v', 'V').Split('-', '+')[0];
        var parts = core.Split('.');
        if (parts.Length is < 1 or > 3) return false;
        var nums = new int[3];
        for (var i = 0; i < parts.Length; i++)
        {
            if (!int.TryParse(parts[i], System.Globalization.NumberStyles.None, System.Globalization.CultureInfo.InvariantCulture, out nums[i])) return false;
        }
        version = new Version(nums[0], nums[1], nums[2]);
        return true;
    }

    /// <summary>
    /// The version a release tag carries, wherever it sits in the tag:
    /// "native-v2.5.0", "v2.5.0" and "2.5.0" are all "2.5.0". Null when the tag has none.
    /// </summary>
    public static string? FromTag(string? tag)
    {
        if (string.IsNullOrWhiteSpace(tag)) return null;
        var m = System.Text.RegularExpressions.Regex.Match(tag, @"(?<![\d.])\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z.-]+)?");
        return m.Success ? m.Value : null;
    }

    public static int Compare(Version a, Version b) =>
        new Version(a.Major, a.Minor, Math.Max(a.Build, 0)).CompareTo(new Version(b.Major, b.Minor, Math.Max(b.Build, 0)));
}
