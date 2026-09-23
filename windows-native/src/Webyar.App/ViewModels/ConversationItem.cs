using CommunityToolkit.Mvvm.ComponentModel;
using Microsoft.UI.Xaml;
using Webyar.Core.Api;
using Windows.UI.Text;
using Webyar.Core.Inbox;
using Webyar.Core.Localization;

namespace Webyar.App.ViewModels;

/// <summary>One row of the conversation list, updated in place so the list never flickers.</summary>
public sealed partial class ConversationItem : ObservableObject
{
    public ConversationItem(Conversation c, Strings s, DateTimeOffset now)
    {
        Id = c.Id;
        _conversation = c;
        Update(c, s, now);
    }

    public string Id { get; }

    [ObservableProperty]
    private Conversation _conversation;

    [ObservableProperty]
    private string _name = string.Empty;

    [ObservableProperty]
    private string _initials = string.Empty;

    [ObservableProperty]
    private string _preview = string.Empty;

    [ObservableProperty]
    private string _stamp = string.Empty;

    [ObservableProperty]
    private string _unreadText = string.Empty;

    [ObservableProperty]
    private Visibility _unreadVisibility = Visibility.Collapsed;

    [ObservableProperty]
    private FontWeight _nameWeight = Microsoft.UI.Text.FontWeights.Normal;

    public void Update(Conversation c, Strings s, DateTimeOffset now)
    {
        Conversation = c;
        Name = Display.ContactName(c.Contacts, s);
        Initials = Display.Initials(Name);
        Preview = Display.Preview(c.LastMessage, s);
        Stamp = c.LastActivity is { } when ? Display.ListStamp(when, now, s) : string.Empty;
        var unread = Math.Max(0, c.UnreadCount ?? 0);
        UnreadText = Digits.Localize(unread > 99 ? "99+" : unread.ToString(System.Globalization.CultureInfo.InvariantCulture), s.Language);
        UnreadVisibility = unread > 0 ? Visibility.Visible : Visibility.Collapsed;
        NameWeight = unread > 0 ? Microsoft.UI.Text.FontWeights.SemiBold : Microsoft.UI.Text.FontWeights.Normal;
    }

    public bool Matches(string query) =>
        query.Length == 0 ||
        Name.Contains(query, StringComparison.CurrentCultureIgnoreCase) ||
        Preview.Contains(query, StringComparison.CurrentCultureIgnoreCase) ||
        (Conversation.Contacts?.Email?.Contains(query, StringComparison.OrdinalIgnoreCase) ?? false);
}
