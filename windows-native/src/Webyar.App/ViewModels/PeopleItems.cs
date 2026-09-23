using CommunityToolkit.Mvvm.ComponentModel;
using Microsoft.UI.Xaml;
using Webyar.Core.Api;
using Webyar.Core.Inbox;
using Webyar.Core.Localization;

namespace Webyar.App.ViewModels;

public sealed partial class ColleagueItem : ObservableObject
{
    public ColleagueItem(Colleague c, Strings s) => Update(c, s);

    public string Id { get; private set; } = string.Empty;

    [ObservableProperty]
    private string _name = string.Empty;

    [ObservableProperty]
    private string? _avatarUrl;

    [ObservableProperty]
    private string _preview = string.Empty;

    [ObservableProperty]
    private string _stamp = string.Empty;

    [ObservableProperty]
    private string _unreadText = string.Empty;

    [ObservableProperty]
    private Visibility _unreadVisibility = Visibility.Collapsed;

    /// <summary>active, away, disconnected or offline — the team presence the shell already follows.</summary>
    [ObservableProperty]
    private string? _presence;

    public string? Role { get; private set; }
    public string? Email { get; private set; }

    public void Update(Colleague c, Strings s)
    {
        Id = c.UserId;
        Role = c.Role;
        Email = c.Email;
        Name = c.DisplayName;
        AvatarUrl = c.AvatarUrl;
        var last = c.LastMessage;
        var body = Display.OneLine(last?.Body);
        if (body.Length == 0 && last?.AttachmentKind is { } kind) body = Display.AttachmentPreview(kind, last.Outgoing == true, c.DisplayName, s);
        Preview = body.Length == 0 ? (c.Role ?? c.Email ?? string.Empty) : (last?.Outgoing == true ? $"{s["you"]}: {body}" : body);
        Stamp = last?.CreatedAt is { } at ? Display.ListStamp(at, DateTimeOffset.Now, s) : string.Empty;
        var n = Math.Max(0, c.Unread ?? 0);
        UnreadText = Digits.Localize(n.ToString(System.Globalization.CultureInfo.InvariantCulture), s.Language);
        UnreadVisibility = n > 0 ? Visibility.Visible : Visibility.Collapsed;
    }
}

/// <summary>
/// A contact row, as the web contacts table draws it: the display name
/// ("Visitor from Tehran · AB12" for the anonymous) seeds the avatar, which
/// shows the visitor's OS and country from the network profile.
/// </summary>
public sealed class ContactItem(Contact c, VisitorProfile? profile, Strings s)
{
    public Contact Contact { get; } = c;
    public VisitorProfile? Profile { get; } = profile;
    public string Id => Contact.Id;
    public string Name { get; } = Display.VisitorName(c.Name, c.VisitorCode ?? c.MetaString("anon_code"), c.Id,
        profile?.Geo?.City, profile?.Geo?.Region, profile?.Geo?.CountryCode, s);
    public string? Email => Contact.Email;
    public string? AvatarUrl => Contact.AvatarUrl;
    public string? Os => Profile?.Device?.Os;
    public string? CountryCode => Profile?.Geo?.CountryCode;
    public string Subtitle => Contact.Email ?? Contact.Phone ?? Contact.Company ?? string.Empty;

    /// <summary>"Tehran, Iran" — the web's location column.</summary>
    public string Location { get; } = string.Join(s.IsRightToLeft ? "، " : ", ",
        new[] { profile?.Geo?.City, profile?.Geo?.Country }.Where(x => !string.IsNullOrWhiteSpace(x)));

    public Visibility LocationVisibility => Location.Length > 0 ? Visibility.Visible : Visibility.Collapsed;

    public bool Matches(string q) => q.Length == 0 ||
        Name.Contains(q, StringComparison.CurrentCultureIgnoreCase) ||
        (Contact.Email?.Contains(q, StringComparison.OrdinalIgnoreCase) ?? false) ||
        (Contact.Phone?.Contains(q, StringComparison.OrdinalIgnoreCase) ?? false) ||
        (Contact.VisitorCode?.Contains(q, StringComparison.OrdinalIgnoreCase) ?? false) ||
        (Contact.Company?.Contains(q, StringComparison.CurrentCultureIgnoreCase) ?? false);
}

public sealed partial class EmailThreadItem : ObservableObject
{
    public EmailThreadItem(EmailThreadSummary t, Strings s) => Update(t, s);

    public EmailThreadSummary Thread { get; private set; } = null!;
    public string Id => Thread.Id;

    [ObservableProperty]
    private string _subject = string.Empty;

    [ObservableProperty]
    private string _from = string.Empty;

    [ObservableProperty]
    private string _snippet = string.Empty;

    [ObservableProperty]
    private string _stamp = string.Empty;

    [ObservableProperty]
    private Windows.UI.Text.FontWeight _weight = Microsoft.UI.Text.FontWeights.Normal;

    [ObservableProperty]
    private Visibility _starVisibility = Visibility.Collapsed;

    [ObservableProperty]
    private Visibility _unreadVisibility = Visibility.Collapsed;

    public void Update(EmailThreadSummary t, Strings s)
    {
        Thread = t;
        Subject = string.IsNullOrWhiteSpace(t.Subject) ? s["emailNoSubject"] : t.Subject!;
        From = string.Join(", ", (t.Participants ?? []).Select(p => p.Email).Take(3));
        Snippet = Display.OneLine(t.LastMessageSnippet);
        Stamp = t.LastMessageAt is { } at ? Display.ListStamp(at, DateTimeOffset.Now, s) : string.Empty;
        var unread = t.IsRead == false;
        Weight = unread ? Microsoft.UI.Text.FontWeights.Bold : Microsoft.UI.Text.FontWeights.SemiBold;
        UnreadVisibility = unread ? Visibility.Visible : Visibility.Collapsed;
        StarVisibility = t.IsStarred == true ? Visibility.Visible : Visibility.Collapsed;
    }
}

/// <summary>A message between two colleagues.</summary>
/// <summary>
/// One line of a colleague chat: a message (text and/or a file), or a day
/// separator. Runs from one sender are grouped: only the last bubble of a
/// run shows the avatar and time, like the visitor thread.
/// </summary>
public sealed partial class TeamMessageItem : ObservableObject
{
    public TeamMessageItem(TeamMessage m, string? me, Strings s)
    {
        Id = m.Id;
        SenderId = m.SenderId;
        CreatedAt = m.CreatedAt;
        Side = m.SenderId == me ? MessageSide.Outgoing : MessageSide.Incoming;
        Body = m.Body ?? string.Empty;
        _meta = m.CreatedAt is { } at ? Display.ClockTime(at, s.Language) : string.Empty;
        if (Side == MessageSide.Outgoing && m.ReadAt is not null) _meta += " · " + s["seen"];
        if (m.Attachment is { } a) Attachments.Add(new AttachmentItem(a, s));
        BodyVisibility = Body.Trim().Length > 0 ? Visibility.Visible : Visibility.Collapsed;
        AttachmentsVisibility = Attachments.Count > 0 ? Visibility.Visible : Visibility.Collapsed;
    }

    /// <summary>A message the operator is sending now, shown at once.</summary>
    public TeamMessageItem(string body, AttachmentItem? file, Strings s)
    {
        Id = "local:" + Guid.NewGuid();
        Side = MessageSide.Outgoing;
        Body = body;
        CreatedAt = DateTimeOffset.Now;
        if (file is not null) Attachments.Add(file);
        BodyVisibility = Body.Trim().Length > 0 ? Visibility.Visible : Visibility.Collapsed;
        AttachmentsVisibility = Attachments.Count > 0 ? Visibility.Visible : Visibility.Collapsed;
        _meta = s["sending"];
        _opacity = 0.6;
    }

    /// <summary>A day separator.</summary>
    public TeamMessageItem(string dayLabel)
    {
        Id = "day:" + dayLabel;
        Side = MessageSide.Day;
        Body = dayLabel;
    }

    public string Id { get; }
    public string? SenderId { get; }
    public DateTimeOffset? CreatedAt { get; }
    public MessageSide Side { get; }
    public string Body { get; }
    public System.Collections.ObjectModel.ObservableCollection<AttachmentItem> Attachments { get; } = [];
    public Visibility BodyVisibility { get; }
    public Visibility AttachmentsVisibility { get; }

    [ObservableProperty]
    private string _meta = string.Empty;

    [ObservableProperty]
    private Visibility _metaVisibility = Visibility.Visible;

    [ObservableProperty]
    private string _avatarName = string.Empty;

    [ObservableProperty]
    private string? _avatarUrl;

    [ObservableProperty]
    private Visibility _avatarVisibility = Visibility.Visible;

    [ObservableProperty]
    private double _opacity = 1;
}
