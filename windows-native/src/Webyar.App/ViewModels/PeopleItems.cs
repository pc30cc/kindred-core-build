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

    public void Update(Colleague c, Strings s)
    {
        Id = c.UserId;
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

public sealed class ContactItem(Contact c, Strings s)
{
    public Contact Contact { get; } = c;
    public string Id => Contact.Id;
    public string Name { get; } = Display.ContactName(new ConversationContact(c.Name, c.Email, c.AvatarUrl, c.VisitorCode), s);
    public string? AvatarUrl => Contact.AvatarUrl;
    public string Subtitle => Contact.Email ?? Contact.Phone ?? Contact.VisitorCode ?? string.Empty;

    public bool Matches(string q) => q.Length == 0 ||
        Name.Contains(q, StringComparison.CurrentCultureIgnoreCase) ||
        (Contact.Email?.Contains(q, StringComparison.OrdinalIgnoreCase) ?? false) ||
        (Contact.Phone?.Contains(q, StringComparison.OrdinalIgnoreCase) ?? false);
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
public sealed class TeamMessageItem
{
    public TeamMessageItem(TeamMessage m, string? me, Strings s)
    {
        Id = m.Id;
        Side = m.SenderId == me ? MessageSide.Outgoing : MessageSide.Incoming;
        Body = m.Body ?? string.Empty;
        Meta = m.CreatedAt is { } at ? Display.ClockTime(at, s.Language) : string.Empty;
        if (m.Attachment is { } a) Attachments.Add(new AttachmentItem(a, s));
        BodyVisibility = Body.Trim().Length > 0 ? Visibility.Visible : Visibility.Collapsed;
        AttachmentsVisibility = Attachments.Count > 0 ? Visibility.Visible : Visibility.Collapsed;
    }

    public string Id { get; }
    public MessageSide Side { get; }
    public string Body { get; }
    public string Meta { get; }
    public System.Collections.ObjectModel.ObservableCollection<AttachmentItem> Attachments { get; } = [];
    public Visibility BodyVisibility { get; }
    public Visibility AttachmentsVisibility { get; }
}
