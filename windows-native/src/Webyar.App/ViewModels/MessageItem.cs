using System.Collections.ObjectModel;
using CommunityToolkit.Mvvm.ComponentModel;
using Microsoft.UI.Xaml;
using Webyar.Core.Api;
using Webyar.Core.Inbox;
using Webyar.Core.Localization;

namespace Webyar.App.ViewModels;

public enum MessageSide
{
    Incoming,
    Outgoing,
    System,
    /// <summary>The "Yesterday" / date line between days.</summary>
    Day,
}

/// <summary>A row of the thread: a message, a notice, or a day separator.</summary>
public sealed partial class MessageItem : ObservableObject
{
    public MessageItem(Message m, Strings s)
    {
        Id = m.Id;
        CreatedAt = m.CreatedAt;
        Side = m.IsSystem ? MessageSide.System : m.IsOutgoing ? MessageSide.Outgoing : MessageSide.Incoming;
        Body = Side == MessageSide.System ? SystemText.For(m.Metadata, s) ?? m.Body : m.Body;
        Time = m.CreatedAt is { } at ? Display.ClockTime(at, s.Language) : string.Empty;
        IsAi = m.SenderType is SenderTypes.Ai or SenderTypes.Bot;
        SenderId = m.SenderId;
        ReplyToId = m.ReplyToMessageId;
        if (Side == MessageSide.Outgoing)
        {
            _avatarUrl = IsAi ? null : m.SenderAvatar;
            _avatarName = IsAi ? string.Empty : m.SenderName ?? string.Empty;
        }
        SenderName = m.SenderType switch
        {
            SenderTypes.Ai or SenderTypes.Bot => m.SenderName is { Length: > 0 } n ? n : s["aiReply"],
            SenderTypes.Agent => m.SenderName ?? string.Empty,
            _ => m.SenderName ?? string.Empty,
        };
        _meta = Side == MessageSide.Outgoing && SenderName.Length > 0 ? $"{SenderName} · {Time}" : Time;
        foreach (var a in m.Attachments ?? []) Attachments.Add(new AttachmentItem(a, s));
        AttachmentsVisibility = Attachments.Count > 0 ? Visibility.Visible : Visibility.Collapsed;
        BodyVisibility = Body.Trim().Length > 0 ? Visibility.Visible : Visibility.Collapsed;
        SenderVisibility = Side == MessageSide.Outgoing && IsAi ? Visibility.Visible : Visibility.Collapsed;
        SetActionText(s);
    }

    private void SetActionText(Strings s)
    {
        ReplyLabel = s["reply"];
        ReplyTip = s["replyToMessage"];
        CopyLabel = s["copy"];
        CopyTip = s["copyMessage"];
    }

    /// <summary>An optimistic bubble for a reply that is on its way.</summary>
    public MessageItem(string clientId, string body, Strings s, AttachmentItem? attachment = null, MessageItem? replyTo = null)
    {
        Id = clientId;
        if (replyTo is not null)
        {
            ReplyToId = replyTo.Id;
            SetQuote(replyTo, s);
        }
        ClientId = clientId;
        Side = MessageSide.Outgoing;
        Body = body;
        CreatedAt = DateTimeOffset.Now;
        Time = Display.ClockTime(DateTimeOffset.Now, s.Language);
        _meta = Time;
        _pending = true;
        _opacity = 0.6;
        _actionsVisibility = Visibility.Collapsed;
        SetActionText(s);
        if (attachment is not null) Attachments.Add(attachment);
        AttachmentsVisibility = Attachments.Count > 0 ? Visibility.Visible : Visibility.Collapsed;
        BodyVisibility = body.Trim().Length > 0 ? Visibility.Visible : Visibility.Collapsed;
    }

    private MessageItem(string id, string day)
    {
        Id = id;
        Side = MessageSide.Day;
        Body = day;
    }

    public static MessageItem DaySeparator(DateTimeOffset when, Strings s)
    {
        var local = when.ToLocalTime().Date;
        var today = DateTime.Now.Date;
        var label = local == today ? s["today"] : local == today.AddDays(-1) ? s["yesterday"] : Display.ShortDate(local, s.Language);
        return new MessageItem($"day:{local:yyyyMMdd}", label);
    }

    public string Id { get; }
    public string? ClientId { get; }
    public MessageSide Side { get; }
    public string Body { get; }
    public string Time { get; } = string.Empty;
    public DateTimeOffset? CreatedAt { get; }
    public bool IsAi { get; }

    /// <summary>Who sent it; a change of sender starts a new run of bubbles.</summary>
    public string? SenderId { get; set; }

    /// <summary>How the avatar is drawn: a visitor (null), an operator, or the AI.</summary>
    public string? AvatarKind => Side == MessageSide.Outgoing ? (IsAi ? "ai" : "operator") : null;

    public string RunKey => Side == MessageSide.Outgoing ? (IsAi ? "ai" : SenderId ?? "agent") : Side.ToString();
    public string SenderName { get; } = string.Empty;
    public ObservableCollection<AttachmentItem> Attachments { get; } = [];
    public Visibility AttachmentsVisibility { get; }
    public Visibility BodyVisibility { get; }
    public Visibility SenderVisibility { get; } = Visibility.Collapsed;

    /// <summary>Only the first of a run of visitor messages shows the avatar.</summary>
    [ObservableProperty]
    private Visibility _avatarVisibility = Visibility.Visible;

    [ObservableProperty]
    private string _avatarName = string.Empty;

    [ObservableProperty]
    private string? _avatarUrl;

    [ObservableProperty]
    private string? _avatarEmail;

    [ObservableProperty]
    private string? _avatarOs;

    /// <summary>Name and time show once, under the last bubble of a run, as on the web.</summary>
    [ObservableProperty]
    private Visibility _metaVisibility = Visibility.Visible;

    [ObservableProperty]
    private string _meta;

    /// <summary>
    /// For a reply the server has stored: the first sync numbered at least
    /// this started after the send returned, so its answer holds the stored
    /// copy. 0 while the reply is still on its way (or failed).
    /// </summary>
    public int ConfirmedBySync { get; set; }

    [ObservableProperty]
    private bool _pending;

    [ObservableProperty]
    private bool _failed;

    [ObservableProperty]
    private double _opacity = 1;

    partial void OnPendingChanged(bool value) => Opacity = value ? 0.6 : 1;

    public string ReplyLabel { get; private set; } = string.Empty;
    public string ReplyTip { get; private set; } = string.Empty;
    public string CopyLabel { get; private set; } = string.Empty;
    public string CopyTip { get; private set; } = string.Empty;

    /// <summary>Reply is offered once the message exists on the server.</summary>
    [ObservableProperty]
    private Visibility _actionsVisibility = Visibility.Visible;

    /// <summary>The message this one answers, when it does.</summary>
    public string? ReplyToId { get; set; }

    [ObservableProperty]
    private string _quoteSender = string.Empty;

    [ObservableProperty]
    private string _quoteText = string.Empty;

    [ObservableProperty]
    private Visibility _quoteVisibility = Visibility.Collapsed;

    /// <summary>Who wrote it, as a reply quote names them.</summary>
    public string AuthorLabel(Strings s) => Side switch
    {
        MessageSide.Outgoing => SenderName.Length > 0 ? SenderName : s["you"],
        _ => AvatarName.Length > 0 ? AvatarName : s["visitor"],
    };

    /// <summary>One line standing for the message: its text, or what it carries.</summary>
    public string Snippet(Strings s)
    {
        var text = Body.Trim().Replace('\n', ' ');
        if (text.Length > 0) return text.Length > 120 ? text[..120] + "…" : text;
        return Attachments.Count > 0 ? "📎 " + Attachments[0].FileName : string.Empty;
    }

    /// <summary>Shows <paramref name="target"/> as the quote above this bubble.</summary>
    public void SetQuote(MessageItem target, Strings s)
    {
        QuoteSender = target.AuthorLabel(s);
        QuoteText = target.Snippet(s);
        QuoteVisibility = Visibility.Visible;
    }

    /// <summary>Same content, so the row can stay where it is.</summary>
    public bool SameAs(MessageItem other) => Id == other.Id && Body == other.Body && Attachments.Count == other.Attachments.Count && QuoteText == other.QuoteText;
}
