using CommunityToolkit.Mvvm.ComponentModel;
using Microsoft.UI.Xaml;
using Webyar.Core.Api;
using Webyar.Core.Inbox;
using Webyar.Core.Localization;

namespace Webyar.App.ViewModels;

/// <summary>A row of the live visitors list, updated in place on every poll.</summary>
public sealed partial class VisitorItem : ObservableObject
{
    public VisitorItem(LiveVisitor v, Strings s, DateTimeOffset now)
    {
        Id = v.Id;
        _visitor = v;
        Update(v, s, now);
    }

    public string Id { get; }

    [ObservableProperty] private LiveVisitor _visitor;
    [ObservableProperty] private string _name = string.Empty;
    [ObservableProperty] private string? _rawName;
    [ObservableProperty] private string? _email;
    [ObservableProperty] private string? _avatarUrl;
    [ObservableProperty] private string? _os;
    [ObservableProperty] private string? _countryCode;
    [ObservableProperty] private string? _status;
    [ObservableProperty] private string _where = string.Empty;
    [ObservableProperty] private string _ago = string.Empty;
    // Not "Page": x:Bind would read it as the XAML type.
    [ObservableProperty] private string _pagePath = string.Empty;
    [ObservableProperty] private Visibility _chatVisibility = Visibility.Collapsed;
    [ObservableProperty] private string _chatText = string.Empty;

    public void Update(LiveVisitor v, Strings s, DateTimeOffset now)
    {
        Visitor = v;
        Name = VisitorText.Name(v, s);
        RawName = v.Contact?.Name;
        Email = v.Contact?.Email;
        AvatarUrl = v.Contact?.AvatarUrl;
        Os = v.Os;
        CountryCode = v.Geo?.CountryCode;
        Status = v.Status is "online" or "idle" ? v.Status : "offline";
        Where = VisitorText.Location(v.Geo) ?? s["visitorsUnknownLocation"];
        Ago = v.LastActivityAt is { } at ? VisitorText.Ago(at, now, s) : string.Empty;
        PagePath = VisitorText.ShortUrl(v.CurrentPage);
        ChatVisibility = v.Conversation is null ? Visibility.Collapsed : Visibility.Visible;
        ChatText = s["visitorInChat"];
    }

    public bool Matches(string query) =>
        query.Length == 0 ||
        Contains(Visitor.CurrentPage, query) || Contains(Visitor.Geo?.Country, query) || Contains(Visitor.Geo?.City, query) ||
        Contains(Visitor.Browser, query) || Contains(Visitor.Contact?.Name, query) || Contains(Visitor.Contact?.Email, query) || Contains(Name, query);

    private static bool Contains(string? text, string q) => text?.Contains(q, StringComparison.OrdinalIgnoreCase) == true;
}

/// <summary>The visitors page's wording, as on the web.</summary>
public static class VisitorText
{
    public static string Name(LiveVisitor v, Strings s) =>
        Display.VisitorName(v.Contact?.Name, v.Contact?.Code, v.Contact?.Id ?? v.Id, v.Geo?.City, v.Geo?.Region, v.Geo?.CountryCode, s);

    public static string? Location(VisitorGeoInfo? g)
    {
        if (g is null) return null;
        var parts = new[] { g.City, g.Region is { } r && r != g.City && g.CountryCode == "IR" ? r : null, g.Country }
            .Where(p => !string.IsNullOrWhiteSpace(p)).Distinct().ToList();
        return parts.Count == 0 ? null : string.Join("، ", parts);
    }

    public static string Ago(DateTimeOffset at, DateTimeOffset now, Strings s)
    {
        var sec = Math.Max(0, (now - at).TotalSeconds);
        if (sec < 60) return s["visitorsJustNow"];
        if (sec < 3600) return s.Get("visitorsMinutesAgo", "n", (int)(sec / 60));
        return s.Get("visitorsHoursAgo", "n", (int)(sec / 3600));
    }

    /// <summary>host/path without the scheme, as a line fits it.</summary>
    public static string ShortUrl(string? url)
    {
        if (string.IsNullOrWhiteSpace(url)) return string.Empty;
        if (!Uri.TryCreate(url, UriKind.Absolute, out var u)) return Unescape(url);
        var path = Uri.UnescapeDataString(u.PathAndQuery);
        return path == "/" ? u.Host : u.Host + path;
    }

    /// <summary>Persian slugs arrive percent-encoded; people read them decoded.</summary>
    private static string Unescape(string text)
    {
        try
        {
            return Uri.UnescapeDataString(text);
        }
        catch (UriFormatException)
        {
            return text;
        }
    }
}
