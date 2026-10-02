using System.Globalization;
using System.Text.Json;
using Webyar.Core.Api;
using Webyar.Core.Localization;

namespace Webyar.Core.Inbox;

/// <summary>
/// Who is asking — the card at the top of a platform-support conversation in
/// the support team's inbox (docs/PLATFORM_SUPPORT.md, "Who is asking"). The
/// server writes it as an internal notice when the conversation starts
/// (server/services/platformSupport/requester.ts): the site user, and each of
/// their workspaces with its plan, operators and this month's usage. Only read
/// here; as on the web (SupportRequesterCard.tsx) and Android (RequesterCard.kt).
/// </summary>
public sealed record RequesterCard(
    string? Name,
    string? Email,
    string? Phone,
    string? Company,
    string? Website,
    DateTimeOffset? MemberSince,
    string? ClientPlatform,
    string? SourceWorkspace,
    int WorkspaceCount,
    IReadOnlyList<RequesterWorkspace> Workspaces,
    DateTimeOffset? CapturedAt)
{
    public const string Kind = "platform_support_requester";

    /// <summary>The card a notice's metadata describes, or null when it is not one.</summary>
    public static RequesterCard? Parse(JsonElement? metadata)
    {
        if (metadata is not { ValueKind: JsonValueKind.Object } meta || Text(meta, "kind") != Kind) return null;
        var user = Child(meta, "user");
        var workspaces = new List<RequesterWorkspace>();
        if (meta.TryGetProperty("workspaces", out var list) && list.ValueKind == JsonValueKind.Array)
        {
            foreach (var ws in list.EnumerateArray())
            {
                if (ws.ValueKind != JsonValueKind.Object) continue;
                var plan = Child(ws, "plan");
                var usage = Child(ws, "usage");
                var names = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
                if (plan is { } p && p.TryGetProperty("names", out var n) && n.ValueKind == JsonValueKind.Object)
                {
                    foreach (var entry in n.EnumerateObject())
                    {
                        if (entry.Value.ValueKind == JsonValueKind.String && entry.Value.GetString() is { } v && v.Trim().Length > 0)
                            names[entry.Name] = v.Trim();
                    }
                }
                workspaces.Add(new RequesterWorkspace(
                    Name: Text(ws, "name") ?? Text(ws, "id") ?? string.Empty,
                    Role: Text(ws, "role"),
                    PlanName: plan is { } pl ? Text(pl, "name") ?? Text(pl, "slug") ?? string.Empty : null,
                    PlanNames: names,
                    PlanStatus: plan is { } ps ? Text(ps, "status") : null,
                    PeriodEnd: plan is { } pe ? Date(pe, "period_end") : null,
                    TrialEnd: plan is { } pt ? Date(pt, "trial_end") : null,
                    CancelAtPeriodEnd: plan is { } pc && pc.TryGetProperty("cancel_at_period_end", out var cancel) && cancel.ValueKind == JsonValueKind.True,
                    Operators: Metered(Child(ws, "operators")),
                    Contacts: Metered(Child(ws, "contacts")),
                    Conversations: Metered(usage is { } u1 ? Child(u1, "conversations") : null),
                    Visitors: Metered(usage is { } u2 ? Child(u2, "visitors") : null),
                    AiCredits: Metered(usage is { } u3 ? Child(u3, "ai_credits") : null),
                    Messages: usage is { } u4 ? Number(u4, "messages") ?? 0 : 0,
                    CallMinutes: usage is { } u5 ? Number(u5, "call_minutes") ?? 0 : 0,
                    StorageBytes: usage is { } u6 ? Number(u6, "storage_bytes") ?? 0 : 0,
                    StorageLimitGb: usage is { } u7 ? Number(u7, "storage_limit_gb") : null));
            }
        }
        return new RequesterCard(
            Name: user is { } a ? Text(a, "name") : null,
            Email: user is { } b ? Text(b, "email") : null,
            Phone: user is { } c ? Text(c, "phone") : null,
            Company: user is { } d ? Text(d, "company") : null,
            Website: user is { } e ? Text(e, "website") : null,
            MemberSince: user is { } f ? Date(f, "member_since") : null,
            ClientPlatform: user is { } g ? ClientPlatforms.Normalize(Text(g, "client_platform")) : null,
            SourceWorkspace: user is { } h ? Text(h, "source_workspace") : null,
            WorkspaceCount: (int)(Number(meta, "workspace_count") ?? workspaces.Count),
            Workspaces: workspaces,
            CapturedAt: Date(meta, "captured_at"));
    }

    private static JsonElement? Child(JsonElement e, string key) =>
        e.TryGetProperty(key, out var v) && v.ValueKind == JsonValueKind.Object ? v : null;

    private static string? Text(JsonElement e, string key) =>
        e.TryGetProperty(key, out var v) && v.ValueKind == JsonValueKind.String && v.GetString()?.Trim() is { Length: > 0 } t ? t : null;

    private static long? Number(JsonElement e, string key)
    {
        if (!e.TryGetProperty(key, out var v)) return null;
        return v.ValueKind switch
        {
            JsonValueKind.Number when v.TryGetDouble(out var d) => (long)Math.Round(d),
            JsonValueKind.String when double.TryParse(v.GetString(), NumberStyles.Float, CultureInfo.InvariantCulture, out var d) => (long)Math.Round(d),
            _ => null,
        };
    }

    private static DateTimeOffset? Date(JsonElement e, string key) =>
        Text(e, key) is { } t && DateTimeOffset.TryParse(t, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var d) ? d : null;

    private static Metered Metered(JsonElement? e) =>
        e is { } m ? new Metered(Number(m, "used") ?? 0, Number(m, "limit")) : new Metered(0, null);
}

/// <summary>A used amount against the plan's limit: no limit when the plan sets none, a negative one when unlimited.</summary>
public sealed record Metered(long Used, long? Limit)
{
    /// <summary>"12 / 200", "900 / ∞", or "12" when the plan sets no limit.</summary>
    public string Text(Language language)
    {
        var used = RequesterText.Number(Used, language);
        return Limit switch
        {
            null => used,
            < 0 => $"{used} / ∞",
            { } l => $"{used} / {RequesterText.Number(l, language)}",
        };
    }

    /// <summary>How much of the limit is used, 0..1; null when there is no finite limit.</summary>
    public double? Share => Limit is > 0 and { } l ? Math.Clamp(Used / (double)l, 0, 1) : null;
}

public sealed record RequesterWorkspace(
    string Name,
    string? Role,
    string? PlanName,
    IReadOnlyDictionary<string, string> PlanNames,
    string? PlanStatus,
    DateTimeOffset? PeriodEnd,
    DateTimeOffset? TrialEnd,
    bool CancelAtPeriodEnd,
    Metered Operators,
    Metered Contacts,
    Metered Conversations,
    Metered Visitors,
    Metered AiCredits,
    long Messages,
    long CallMinutes,
    long StorageBytes,
    long? StorageLimitGb)
{
    public bool HasPlan => PlanName is not null;

    /// <summary>The plan's name in the reader's language when Super Admin wrote one, else its name.</summary>
    public string PlanLabel(Strings s) =>
        PlanName is null ? s["requesterNoPlan"]
        : PlanNames.TryGetValue(Strings.Code(s.Language), out var local) ? local
        : PlanName;
}

/// <summary>The app a site user wrote to support from (`client_platform`), and how the inbox names it.</summary>
public static class ClientPlatforms
{
    public const string SupportChannel = "platform_support";

    private static readonly string[] Known = ["android", "ios", "macos", "windows", "web"];

    public static string? Normalize(string? raw) =>
        raw?.Trim().ToLowerInvariant() is { } v && Array.IndexOf(Known, v) >= 0 ? v : null;

    /// <summary>
    /// For a platform-support conversation, the app it was written from:
    /// the conversation's own `client_platform` (the server keeps it current).
    /// Null for any other conversation, or when it is not known.
    /// </summary>
    public static string? Of(Conversation c)
    {
        if (c.ChannelKey != SupportChannel || c.Metadata is not { ValueKind: JsonValueKind.Object } m) return null;
        return m.TryGetProperty("client_platform", out var v) && v.ValueKind == JsonValueKind.String ? Normalize(v.GetString()) : null;
    }

    /// <summary>The product's name, never translated.</summary>
    public static string ProductName(string platform) => platform switch
    {
        "android" => "Android",
        "ios" => "iOS",
        "macos" => "macOS",
        "windows" => "Windows",
        _ => "Web",
    };

    /// <summary>"Windows user", "Android user"… — or "Site user" when the app is not known.</summary>
    public static string UserLabel(string? platform, Strings s) => platform switch
    {
        "android" => s["platformUserAndroid"],
        "ios" => s["platformUserIos"],
        "macos" => s["platformUserMacos"],
        "windows" => s["platformUserWindows"],
        "web" => s["platformUserWeb"],
        _ => s["platformUser"],
    };
}

/// <summary>How the card writes its numbers, dates and sizes in the reader's language.</summary>
public static class RequesterText
{
    public static string Number(long value, Language language) =>
        Digits.Localize(value.ToString("#,0", CultureInfo.InvariantCulture), language).Replace(",", language == Language.Fa ? "٬" : language == Language.Tr ? "." : ",");

    /// <summary>"12 Mehr 1405" / "4 October 2026", in the Persian calendar for Persian.</summary>
    public static string Date(DateTimeOffset when, Strings s)
    {
        var culture = (CultureInfo)s.Culture.Clone();
        if (s.Language == Language.Fa) culture.DateTimeFormat.Calendar = new PersianCalendar();
        return Digits.Localize(when.ToLocalTime().ToString("d MMMM yyyy", culture), s.Language);
    }

    public static string Bytes(long bytes, Language language)
    {
        string[] units = ["B", "KB", "MB", "GB", "TB"];
        double value = Math.Max(0, bytes);
        var unit = 0;
        while (value >= 1024 && unit < units.Length - 1)
        {
            value /= 1024;
            unit++;
        }
        var text = value.ToString(unit == 0 ? "0" : "0.#", CultureInfo.InvariantCulture);
        return $"{Digits.Localize(text, language)} {units[unit]}";
    }

    /// <summary>Storage used, against the plan's gigabytes when it sets them.</summary>
    public static string Storage(RequesterWorkspace ws, Language language)
    {
        var used = Bytes(ws.StorageBytes, language);
        return ws.StorageLimitGb switch
        {
            null => used,
            < 0 => $"{used} / ∞",
            { } gb => $"{used} / {Number(gb, language)} GB",
        };
    }

    /// <summary>"Owner", "Admin", "Operator" — or the role as stored.</summary>
    public static string Role(string role, Strings s) => role switch
    {
        "owner" => s["requesterRoleOwner"],
        "admin" => s["requesterRoleAdmin"],
        "agent" => s["requesterRoleAgent"],
        _ => role,
    };

    public static string PlanStatus(string status, Strings s) => status switch
    {
        "active" => s["requesterPlanActive"],
        "trialing" => s["requesterPlanTrialing"],
        "past_due" => s["requesterPlanPastDue"],
        "canceled" or "cancelled" => s["requesterPlanCanceled"],
        _ => status,
    };

    /// <summary>When the plan renews, ends, or its trial ends — or null when none is known.</summary>
    public static string? Renewal(RequesterWorkspace ws, Strings s)
    {
        if (ws.PlanStatus == "trialing" && ws.TrialEnd is { } trial) return s.Get("requesterTrialEnds", "date", Date(trial, s));
        if (ws.PeriodEnd is not { } end) return null;
        return s.Get(ws.CancelAtPeriodEnd ? "requesterEnds" : "requesterRenews", "date", Date(end, s));
    }
}
