using CommunityToolkit.Mvvm.ComponentModel;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Media;
using Webyar.App.Helpers;
using Webyar.App.Services;
using Webyar.Core.Api;
using Webyar.Core.Localization;

namespace Webyar.App.ViewModels;

/// <summary>A call waiting in the queue, with a wait clock that ticks every second.</summary>
public sealed partial class QueueItem : ObservableObject
{
    public QueueItem(QueueEntry q, int rank, Strings s)
    {
        Id = q.CallSessionId;
        _entry = q;
        Update(q, rank, s);
    }

    public string Id { get; }

    [ObservableProperty] private QueueEntry _entry;
    [ObservableProperty] private string _name = string.Empty;
    [ObservableProperty] private string? _email;
    // The caller's device and country, from their visitor session, for the face.
    [ObservableProperty] private string? _os;
    [ObservableProperty] private string? _countryCode;
    [ObservableProperty] private string _detail = string.Empty;
    [ObservableProperty] private string _rankText = string.Empty;
    [ObservableProperty] private string _waitText = string.Empty;
    [ObservableProperty] private Brush? _waitBrush;
    [ObservableProperty] private Brush? _waitBack;
    [ObservableProperty] private string _channelGlyph = "";
    [ObservableProperty] private string _channelText = string.Empty;
    [ObservableProperty] private Visibility _priorityVisibility = Visibility.Collapsed;
    [ObservableProperty] private string _priorityText = string.Empty;
    [ObservableProperty] private bool _busy;

    private Visibility _detailVisibility = Visibility.Collapsed;

    /// <summary>The line under the name shows only when there is something to say.</summary>
    public Visibility DetailVisibility
    {
        get => _detailVisibility;
        private set => SetProperty(ref _detailVisibility, value);
    }

    public DateTimeOffset Since => Entry.CreatedAt ?? Entry.CallSession?.CreatedAt ?? DateTimeOffset.Now;

    public void Update(QueueEntry q, int rank, Strings s)
    {
        Entry = q;
        Name = CallNames.Caller(q, s);
        Email = q.CallSession?.VisitorEmail;
        ShowDevice();
        Detail = q.CallSession?.Subject is { Length: > 0 } subject ? subject
            : q.CallSession?.PageTitle is { Length: > 0 } title ? title
            : Views.CallText.ShortUrl(q.CallSession?.PageUrl);
        DetailVisibility = string.IsNullOrEmpty(Detail) ? Visibility.Collapsed : Visibility.Visible;
        RankText = Digits.Localize($"#{rank}", s.Language);
        ChannelGlyph = q.IsVideo ? "" : "";
        ChannelText = s[q.IsVideo ? "ccVideo" : "ccVoice"];
        PriorityVisibility = q.Priority is > 0 ? Visibility.Visible : Visibility.Collapsed;
        PriorityText = Digits.Localize($"P{q.Priority ?? 0}", s.Language);
        Tick(s, DateTimeOffset.Now);
    }

    /// <summary>The caller's OS and country once known (asked for once, in a batch with the other faces).</summary>
    public void ShowDevice()
    {
        var profile = AppHost.Current.Callers.For(Entry.CallSession?.VisitorSessionId ?? Entry.VisitorSessionId);
        Os = profile?.Device?.Os;
        CountryCode = profile?.Geo?.CountryCode;
    }

    /// <summary>m:ss since the call came in, amber after a minute and red after three (the web desk's SLA).</summary>
    public void Tick(Strings s, DateTimeOffset now)
    {
        var wait = now - Since;
        if (wait < TimeSpan.Zero) wait = TimeSpan.Zero;
        WaitText = Digits.Localize($"{(int)wait.TotalMinutes}:{wait.Seconds:00}", s.Language);
        var (fore, back) = wait.TotalSeconds switch
        {
            > 180 => ("DangerBrush", "DangerSoftBrush"),
            > 60 => ("WarningBrush", "WarningSoftBrush"),
            _ => ("SuccessBrush", "SuccessSoftBrush"),
        };
        WaitBrush = Palette.Resource(fore);
        WaitBack = Palette.Resource(back);
    }

    public bool Matches(string q, string channel)
    {
        if (channel == "voice" && Entry.IsVideo) return false;
        if (channel == "video" && !Entry.IsVideo) return false;
        if (q.Length == 0) return true;
        var c = Entry.CallSession;
        return new[] { Name, c?.VisitorEmail, c?.VisitorPhone, c?.Subject, c?.PageTitle, c?.PageUrl }
            .Any(t => t?.Contains(q, StringComparison.OrdinalIgnoreCase) == true);
    }
}

/// <summary>A finished or ongoing call in the history list: the caller's face, with the channel in the state's colour.</summary>
public sealed class CallHistoryItem : ObservableObject
{
    public CallHistoryItem(CallSession c, Strings s)
    {
        Call = c;
        Name = CallNames.Caller(c, c.ContactId ?? c.VisitorSessionId ?? c.Id, s);
        AvatarName = c.VisitorName ?? Name;
        Email = c.VisitorEmail;
        IconGlyph = c.IsVideo ? "\uE714" : "\uE717";
        StateText = Views.CallText.State(c.State, s);
        var (fore, back) = Views.CallText.StateColors(c.State);
        StateBrush = Palette.Resource(fore);
        StateBack = Palette.Resource(back);
        DurationText = c.DurationSeconds is > 0 and var d ? Digits.Localize($"{d / 60}:{d % 60:00}", s.Language) : "—";
        WhenText = c.CreatedAt is { } at ? Webyar.Core.Inbox.Display.ListStamp(at, DateTimeOffset.Now, s) : string.Empty;
        SpamText = c.IsSpam ? s["callSpam"] : string.Empty;
        SpamVisibility = c.IsSpam ? Visibility.Visible : Visibility.Collapsed;
        ShowDevice();
    }

    public CallSession Call { get; }
    public string Name { get; }
    /// <summary>The name the face is drawn from: the visitor's own, else the caller's label.</summary>
    public string AvatarName { get; }
    public string? Email { get; }
    public string IconGlyph { get; }
    public string StateText { get; }
    public Brush StateBrush { get; }
    public Brush StateBack { get; }
    // Not "Duration" / "When": x:Bind would read Duration as the XAML type.
    public string DurationText { get; }
    public string WhenText { get; }
    /// <summary>Marked as spam on the desk.</summary>
    public string SpamText { get; }
    public Visibility SpamVisibility { get; }

    private string? _os;
    private string? _countryCode;

    /// <summary>The caller's device, from their visitor session, for the face.</summary>
    public string? Os
    {
        get => _os;
        private set => SetProperty(ref _os, value);
    }

    /// <summary>The caller's country, from their visitor session, for the face.</summary>
    public string? CountryCode
    {
        get => _countryCode;
        private set => SetProperty(ref _countryCode, value);
    }

    /// <summary>The caller's OS and country once known (asked for once, in a batch with the other faces).</summary>
    public void ShowDevice()
    {
        var profile = AppHost.Current.Callers.For(Call.VisitorSessionId);
        Os = profile?.Device?.Os;
        CountryCode = profile?.Geo?.CountryCode;
    }
}
