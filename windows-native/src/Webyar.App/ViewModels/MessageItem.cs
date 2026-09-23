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
}

/// <summary>A message as the thread shows it; a message still being sent carries its own client id.</summary>
public sealed partial class MessageItem : ObservableObject
{
    public MessageItem(Message m, Strings s)
    {
        Id = m.Id;
        Side = m.IsSystem ? MessageSide.System : m.IsOutgoing ? MessageSide.Outgoing : MessageSide.Incoming;
        Body = Side == MessageSide.System ? SystemText.For(m.Metadata, s) ?? m.Body : m.Body;
        Time = m.CreatedAt is { } at ? Display.ClockTime(at, s.Language) : string.Empty;
        var sender = m.SenderType switch
        {
            SenderTypes.Ai or SenderTypes.Bot => m.SenderName is { Length: > 0 } n ? n : "AI",
            SenderTypes.Agent => m.SenderName ?? string.Empty,
            _ => string.Empty,
        };
        Meta = sender.Length > 0 ? $"{sender} · {Time}" : Time;
        var files = (m.Attachments ?? []).Select(a => "📎 " + (a.FileName is { Length: > 4 } f && f.Contains('.') ? f : s["file"])).ToList();
        Attachments = string.Join("\n", files);
        AttachmentsVisibility = files.Count > 0 ? Visibility.Visible : Visibility.Collapsed;
        BodyVisibility = Body.Trim().Length > 0 ? Visibility.Visible : Visibility.Collapsed;
    }

    /// <summary>An optimistic bubble for a reply that is on its way.</summary>
    public MessageItem(string clientId, string body, Strings s)
    {
        Id = clientId;
        ClientId = clientId;
        Side = MessageSide.Outgoing;
        Body = body;
        Time = Display.ClockTime(DateTimeOffset.Now, s.Language);
        Meta = Time;
        Pending = true;
        BodyVisibility = Visibility.Visible;
    }

    public string Id { get; }
    public string? ClientId { get; }
    public MessageSide Side { get; }
    public string Body { get; }
    public string Time { get; }
    public string Attachments { get; } = string.Empty;
    public Visibility AttachmentsVisibility { get; } = Visibility.Collapsed;
    public Visibility BodyVisibility { get; }

    [ObservableProperty]
    private string _meta;

    [ObservableProperty]
    private bool _pending;

    [ObservableProperty]
    private bool _failed;

    [ObservableProperty]
    private double _opacity = 1;

    partial void OnPendingChanged(bool value) => Opacity = value ? 0.6 : 1;
}
