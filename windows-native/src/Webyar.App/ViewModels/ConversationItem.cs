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

    [ObservableProperty]
    private string? _avatarUrl;

    // The avatar is drawn from the raw contact fields, like the web's ContactAvatar.
    [ObservableProperty]
    private string? _rawName;

    [ObservableProperty]
    private string? _email;

    [ObservableProperty]
    private string? _os;

    [ObservableProperty]
    private string? _countryCode;

    /// <summary>The status dot on the avatar: open, pending, resolved or closed.</summary>
    [ObservableProperty]
    private string? _statusDot;

    [ObservableProperty]
    private string _priorityText = string.Empty;

    [ObservableProperty]
    private Visibility _priorityVisibility = Visibility.Collapsed;

    [ObservableProperty]
    private Visibility _aiVisibility = Visibility.Collapsed;

    [ObservableProperty]
    private Microsoft.UI.Xaml.Media.Brush? _previewBrush;

    /// <summary>Where the conversation came from (Telegram, Bale, the site widget…), as a chip.</summary>
    [ObservableProperty]
    private string _channelText = string.Empty;

    [ObservableProperty]
    private string _channelGlyph = string.Empty;

    [ObservableProperty]
    private Microsoft.UI.Xaml.Media.Brush? _channelBrush;

    [ObservableProperty]
    private Microsoft.UI.Xaml.Media.Brush? _channelSoftBrush;

    private string? _channelKey;

    public void Update(Conversation c, Strings s, DateTimeOffset now)
    {
        Conversation = c;
        var channel = c.ChannelKey;
        ChannelText = Services.ChannelInfo.Label(channel, s);
        if (channel != _channelKey)
        {
            _channelKey = channel;
            ChannelGlyph = Services.ChannelInfo.Glyph(channel);
            ChannelBrush = Services.ChannelInfo.Brush(channel);
            ChannelSoftBrush = Services.ChannelInfo.SoftBrush(channel);
        }
        Name = Display.ConversationName(c, s);
        RawName = c.Contacts?.Name;
        Email = c.Contacts?.Email;
        Os = c.VisitorOs;
        CountryCode = c.VisitorCountryCode;
        StatusDot = c.Status;
        Initials = Display.Initials(Name);
        Preview = Display.Preview(c.LastMessage, s);
        Stamp = c.LastActivity is { } when ? Display.ListStamp(when, now, s) : string.Empty;
        var unread = Math.Max(0, c.UnreadCount ?? 0);
        UnreadText = Digits.Localize(unread > 99 ? "99+" : unread.ToString(System.Globalization.CultureInfo.InvariantCulture), s.Language);
        UnreadVisibility = unread > 0 ? Visibility.Visible : Visibility.Collapsed;
        NameWeight = unread > 0 ? Microsoft.UI.Text.FontWeights.Bold : Microsoft.UI.Text.FontWeights.SemiBold;
        AvatarUrl = c.Contacts?.AvatarUrl;
        var urgent = c.Priority is ConversationPriorities.High or ConversationPriorities.Urgent;
        PriorityText = urgent ? s[c.Priority == ConversationPriorities.Urgent ? "priorityUrgent" : "priorityHigh"] : string.Empty;
        PriorityVisibility = urgent ? Visibility.Visible : Visibility.Collapsed;
        // The AI agent is still answering this one.
        AiVisibility = c.IsAiManaged ? Visibility.Visible : Visibility.Collapsed;
        PreviewBrush = Helpers.Palette.Resource(unread > 0 ? "TextBrush" : "Text2Brush");
    }

    public bool Matches(string query) =>
        query.Length == 0 ||
        Name.Contains(query, StringComparison.CurrentCultureIgnoreCase) ||
        Preview.Contains(query, StringComparison.CurrentCultureIgnoreCase) ||
        (Conversation.Contacts?.Email?.Contains(query, StringComparison.OrdinalIgnoreCase) ?? false);
}
