using System.Collections.ObjectModel;
using System.Globalization;
using Microsoft.UI.Input;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Controls.Primitives;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Navigation;
using Webyar.App.Helpers;
using Webyar.App.Services;
using Webyar.App.ViewModels;
using Webyar.Core.Api;
using Webyar.Core.Inbox;
using Webyar.Core.Localization;
using Windows.System;
using Windows.UI.Core;

namespace Webyar.App.Views;

/// <summary>
/// The internal inbox: operator-to-operator chat. The team with presence on
/// the start side; the thread with one colleague — text, photos, voice notes
/// and files, grouped by day and sender — and a composer with files, emoji
/// and voice recording, gated by the plan like the visitor composer.
/// </summary>
public sealed partial class ColleaguesPage : Page
{
    private const long MaxUpload = 25 * 1024 * 1024;

    private readonly ObservableCollection<ColleagueItem> _items = [];
    private readonly Dictionary<string, ColleagueItem> _all = [];
    private readonly ObservableCollection<TeamMessageItem> _messages = [];

    /// <summary>The message the next send answers (the reply bar above the composer).</summary>
    private TeamMessageItem? _replyTo;
    private readonly List<TeamMessageItem> _outbox = [];
    private Poller? _listPoller;
    private Poller? _threadPoller;
    private string? _peer;
    private string? _me;
    private (string Name, string Mime, byte[] Data)? _pendingFile;

    public ColleaguesPage()
    {
        InitializeComponent();
        List.ItemsSource = _items;
        Messages.ItemsSource = _messages;
        EmojiGrid.ItemsSource = ChatView.Emojis;
    }

    private static AppHost Host => App.Current.Host;

    protected override void OnNavigatedTo(NavigationEventArgs e)
    {
        base.OnNavigatedTo(e);
        var s = Host.Strings;
        HeaderText.Text = s["colleagues"];
        Search.PlaceholderText = s["colleaguesSearch"];
        EmptyTitle.Text = s["colleaguesEmptyTitle"];
        EmptyBody.Text = s["colleaguesEmptyBody"];
        PlaceholderTitle.Text = s["noColleagueSelected"];
        PlaceholderBody.Text = s["noColleagueSelectedBody"];
        ThreadEmptyText.Text = s["colleagueThreadEmpty"];
        Composer.PlaceholderText = s["messagePlaceholder"];
        ComposerHint.Text = s["composerHint"];
        ToolTipService.SetToolTip(AttachButton, s["attachFile"]);
        ToolTipService.SetToolTip(EmojiButton, s["emoji"]);
        ToolTipService.SetToolTip(MicButton, s["voiceRecord"]);
        ToolTipService.SetToolTip(RecordCancelButton, s["voiceDiscard"]);
        ToolTipService.SetToolTip(SendButton, s["send"]);
        ToolTipService.SetToolTip(MailButton, s["contactSendEmail"]);
        EmojiFlyout.Placement = s.IsRightToLeft ? FlyoutPlacementMode.TopEdgeAlignedRight : FlyoutPlacementMode.TopEdgeAlignedLeft;
        ApplyPlan();
        Host.PlanChanged += ApplyPlan;
        if (Host.Presence is { } presence) presence.Changed += ShowPresence;
        _listPoller = new Poller("colleagues", LoadListAsync, () => TimeSpan.FromSeconds(15));
        _listPoller.Start();
        Host.InboxChanged += OnRealtime;
    }

    protected override void OnNavigatedFrom(NavigationEventArgs e)
    {
        base.OnNavigatedFrom(e);
        Host.InboxChanged -= OnRealtime;
        Host.PlanChanged -= ApplyPlan;
        if (Host.Presence is { } presence) presence.Changed -= ShowPresence;
        _listPoller?.Dispose();
        _threadPoller?.Dispose();
        if (_recorder is not null) _ = StopRecordingAsync(keep: false);
    }

    /// <summary>
    /// Files, voice notes and emoji are always offered, as in the web: the
    /// plan's widget_* keys govern what VISITORS may do in the chat widget,
    /// not what operators send (the server never gated operator uploads).
    /// </summary>
    private void ApplyPlan()
    {
        AttachButton.Visibility = Visibility.Visible;
        MicButton.Visibility = Visibility.Visible;
        EmojiButton.Visibility = Visibility.Visible;
    }

    private void OnRealtime(Core.Realtime.InboxEvent e)
    {
        _listPoller?.Kick();
        _threadPoller?.Kick();
    }

    // ── The team ──

    private async Task LoadListAsync(CancellationToken ct)
    {
        if (Host.Workspace is not { } ws) return;
        try
        {
            var r = await Host.Api.ColleaguesAsync(ws.Id, ct);
            _me = r.Me ?? Host.User?.Id;
            var s = Host.Strings;
            var seen = new HashSet<string>();
            foreach (var c in r.Colleagues ?? [])
            {
                seen.Add(c.UserId);
                if (_all.TryGetValue(c.UserId, out var item)) item.Update(c, s);
                else _all[c.UserId] = new ColleagueItem(c, s);
            }
            foreach (var gone in _all.Keys.Where(k => !seen.Contains(k)).ToList()) _all.Remove(gone);
            ShowPresence();
            Filter();
            HeaderSub.Text = s.Get("colleaguesOnline", "n", Digits.Localize(_all.Values.Count(i => i.Presence == PresenceStates.Active).ToString(CultureInfo.InvariantCulture), s.Language));
        }
        finally
        {
            Loading.IsActive = false;
            Loading.Visibility = Visibility.Collapsed;
        }
    }

    private void ShowPresence()
    {
        var team = Host.Presence?.Team;
        foreach (var item in _all.Values)
            item.Presence = team is not null && team.TryGetValue(item.Id, out var p) ? p.Effective : PresenceStates.Offline;
        if (_peer is { } peer && _all.TryGetValue(peer, out var shown)) ShowPeerStatus(shown);
    }

    private void Filter()
    {
        var q = Search.Text.Trim();
        var wanted = _all.Values
            .Where(i => q.Length == 0 || i.Name.Contains(q, StringComparison.CurrentCultureIgnoreCase))
            .OrderByDescending(i => i.UnreadVisibility == Visibility.Visible)
            .ThenByDescending(i => i.Presence == PresenceStates.Active)
            .ThenBy(i => i.Name, StringComparer.CurrentCulture)
            .ToList();
        for (var i = _items.Count - 1; i >= 0; i--)
            if (!wanted.Contains(_items[i])) _items.RemoveAt(i);
        for (var i = 0; i < wanted.Count; i++)
        {
            var at = _items.IndexOf(wanted[i]);
            if (at == i) continue;
            if (at >= 0) _items.Move(at, i);
            else _items.Insert(i, wanted[i]);
        }
        if (_peer is { } p && _all.TryGetValue(p, out var sel)) List.SelectedItem = sel;
        Empty.Visibility = _items.Count == 0 ? Visibility.Visible : Visibility.Collapsed;
    }

    private void OnSearch(AutoSuggestBox sender, AutoSuggestBoxTextChangedEventArgs args) => Filter();

    private void OnSelect(object sender, SelectionChangedEventArgs e)
    {
        if (List.SelectedItem is not ColleagueItem item || item.Id == _peer) return;
        _peer = item.Id;
        PeerAvatar.DisplayName = item.Name;
        PeerAvatar.ImageUrl = item.AvatarUrl;
        PeerName.Text = item.Name;
        PeerRole.Text = RoleLabel(item.Role);
        RoleChip.Visibility = PeerRole.Text.Length > 0 ? Visibility.Visible : Visibility.Collapsed;
        PeerEmail.Text = item.Email is { Length: > 0 } mail ? "· " + mail : string.Empty;
        MailButton.Visibility = item.Email is { Length: > 0 } ? Visibility.Visible : Visibility.Collapsed;
        ShowPeerStatus(item);
        Placeholder.Visibility = Visibility.Collapsed;
        Thread.Visibility = Visibility.Visible;
        Error.IsOpen = false;
        _messages.Clear();
        _outbox.Clear();
        ClearPendingFile();
        ClearReply();
        if (_recorder is not null) _ = StopRecordingAsync(keep: false);
        _threadPoller?.Dispose();
        var peer = item.Id;
        _threadPoller = new Poller("team-thread", ct => LoadThreadAsync(peer, ct), () => TimeSpan.FromSeconds(5));
        _threadPoller.Start();
        Composer.Focus(FocusState.Programmatic);
    }

    private void ShowPeerStatus(ColleagueItem item)
    {
        var s = Host.Strings;
        var state = item.Presence ?? PresenceStates.Offline;
        PeerAvatar.PresenceState = state;
        PeerStatus.Text = s[state switch
        {
            PresenceStates.Active => "presenceActive",
            PresenceStates.Away => "presenceAway",
            PresenceStates.Disconnected => "presenceDisconnected",
            _ => "presenceOffline",
        }];
        PeerDot.Fill = Palette.Resource(state switch
        {
            PresenceStates.Active => "SuccessBrush",
            PresenceStates.Away => "WarningBrush",
            _ => "Text3Brush",
        });
    }

    private static string RoleLabel(string? role)
    {
        var s = Host.Strings;
        return role switch
        {
            "owner" => s["roleOwner"],
            "admin" => s["roleAdmin"],
            "agent" or "operator" => s["roleAgent"],
            null or "" => string.Empty,
            _ => role,
        };
    }

    private async void OnMail(object sender, RoutedEventArgs e)
    {
        if (_peer is { } p && _all.TryGetValue(p, out var item) && item.Email is { Length: > 0 } mail)
            await Launcher.LaunchUriAsync(new Uri("mailto:" + mail));
    }

    // ── The thread ──

    private async Task LoadThreadAsync(string peer, CancellationToken ct)
    {
        if (Host.Workspace is not { } ws) return;
        var t = await Host.Api.TeamThreadAsync(ws.Id, peer, ct);
        if (peer != _peer) return;
        var me = t.Me ?? _me ?? Host.User?.Id;
        var s = Host.Strings;
        var wanted = Group(
            (t.Messages ?? []).OrderBy(m => m.CreatedAt ?? DateTimeOffset.MinValue).Select(m => new TeamMessageItem(m, me, s)),
            s);
        // Replies show what they answer, from the thread itself.
        var byId = wanted.Where(w => w.Side != MessageSide.Day).GroupBy(w => w.Id).ToDictionary(g => g.Key, g => g.First());
        foreach (var w in wanted)
        {
            if (w.ReplyToId is { } rid && byId.TryGetValue(rid, out var target)) w.SetQuote(target, s);
        }
        // Messages still on their way stay at the end until the server has them.
        foreach (var local in _outbox) wanted.Add(local);

        var i = 0;
        for (; i < wanted.Count && i < _messages.Count && _messages[i].Id == wanted[i].Id; i++)
        {
            _messages[i].AvatarVisibility = wanted[i].AvatarVisibility;
            _messages[i].MetaVisibility = wanted[i].MetaVisibility;
        }
        while (_messages.Count > i) _messages.RemoveAt(_messages.Count - 1);
        for (; i < wanted.Count; i++)
        {
            _messages.Add(wanted[i]);
            foreach (var a in wanted[i].Attachments) _ = a.LoadPreviewAsync();
        }
        ThreadEmpty.Visibility = _messages.Count == 0 ? Visibility.Visible : Visibility.Collapsed;
        if (_all.TryGetValue(peer, out var item) && item.UnreadVisibility == Visibility.Visible)
        {
            try
            {
                await Host.Api.MarkTeamReadAsync(ws.Id, peer, ct);
                _listPoller?.Kick();
            }
            catch (ApiException e)
            {
                Log.Error("team read", e);
            }
        }
    }

    /// <summary>Day separators, and the avatar and time only on the last bubble of each run.</summary>
    private List<TeamMessageItem> Group(IEnumerable<TeamMessageItem> source, Strings s)
    {
        var list = new List<TeamMessageItem>();
        DateTime? day = null;
        var peer = _peer is { } p && _all.TryGetValue(p, out var who) ? who : null;
        foreach (var m in source)
        {
            var d = (m.CreatedAt ?? DateTimeOffset.Now).ToLocalTime().Date;
            if (day != d)
            {
                day = d;
                var today = DateTime.Now.Date;
                list.Add(new TeamMessageItem(d == today ? s["today"] : d == today.AddDays(-1) ? s["yesterday"] : Display.ShortDate(d, s.Language)));
            }
            if (m.Side == MessageSide.Incoming)
            {
                m.AvatarName = peer?.Name ?? string.Empty;
                m.AvatarUrl = peer?.AvatarUrl;
            }
            list.Add(m);
        }
        for (var i = 0; i < list.Count; i++)
        {
            var m = list[i];
            if (m.Side == MessageSide.Day) continue;
            var next = i + 1 < list.Count ? list[i + 1] : null;
            var lastOfRun = next is null || next.Side != m.Side || next.CreatedAt is not { } nc || m.CreatedAt is not { } mc || nc - mc > TimeSpan.FromMinutes(5);
            m.AvatarVisibility = lastOfRun ? Visibility.Visible : Visibility.Collapsed;
            m.MetaVisibility = lastOfRun ? Visibility.Visible : Visibility.Collapsed;
        }
        return list;
    }

    // ── Composer ──

    private void OnComposerFocus(object sender, RoutedEventArgs e) =>
        ComposerCard.BorderBrush = Palette.Resource(Composer.FocusState != FocusState.Unfocused ? "ComposerFocusBrush" : "ComposerBorderBrush");

    private void OnComposerChanged(object sender, TextChangedEventArgs e) => UpdateSendEnabled();

    private void UpdateSendEnabled() => SendButton.IsEnabled = Composer.Text.Trim().Length > 0 || _pendingFile is not null;

    private void OnComposerKeyDown(object sender, KeyRoutedEventArgs e)
    {
        if (e.Key != VirtualKey.Enter) return;
        if (InputKeyboardSource.GetKeyStateForCurrentThread(VirtualKey.Shift).HasFlag(CoreVirtualKeyStates.Down)) return;
        e.Handled = true;
        OnSend(this, new RoutedEventArgs());
    }

    private void OnEmojiPicked(object sender, ItemClickEventArgs e)
    {
        if (e.ClickedItem is not string emoji) return;
        var at = Composer.SelectionStart;
        Composer.Text = Composer.Text.Remove(at, Composer.SelectionLength).Insert(at, emoji);
        Composer.SelectionStart = at + emoji.Length;
        EmojiFlyout.Hide();
        Composer.Focus(FocusState.Programmatic);
    }

    private async void OnAttach(object sender, RoutedEventArgs e)
    {
        try
        {
            var picker = new Windows.Storage.Pickers.FileOpenPicker();
            picker.FileTypeFilter.Add("*");
            WinRT.Interop.InitializeWithWindow.Initialize(picker, WinRT.Interop.WindowNative.GetWindowHandle(App.Current.Window!));
            var file = await picker.PickSingleFileAsync();
            if (file is null) return;
            var props = await file.GetBasicPropertiesAsync();
            if ((long)props.Size > MaxUpload)
            {
                ShowError(Host.Strings["fileTooLarge"]);
                return;
            }
            var buffer = await Windows.Storage.FileIO.ReadBufferAsync(file);
            var data = new byte[buffer.Length];
            using (var reader = Windows.Storage.Streams.DataReader.FromBuffer(buffer)) reader.ReadBytes(data);
            await SetPendingAsync(file.Name, string.IsNullOrEmpty(file.ContentType) ? Mime.Of(file.Name) : file.ContentType, data);
            Composer.Focus(FocusState.Programmatic);
        }
        catch (Exception ex)
        {
            Log.Error("team pick file", ex);
            ShowError(Host.Strings["attachmentFailed"]);
        }
    }

    private void OnClearPendingFile(object sender, RoutedEventArgs e) => ClearPendingFile();

    private void ClearPendingFile()
    {
        _pendingFile = null;
        PendingFile.Visibility = Visibility.Collapsed;
        PendingThumb.ImageSource = null;
        PendingThumbCircle.Visibility = Visibility.Collapsed;
        UpdateSendEnabled();
    }

    private async Task SetPendingAsync(string name, string mime, byte[] data)
    {
        _pendingFile = (name, mime, data);
        PendingFileName.Text = name;
        PendingFileSize.Text = AttachmentItem.FormatSize(data.LongLength, Host.Strings);
        PendingGlyph.Glyph = mime.StartsWith("audio/", StringComparison.Ordinal) ? ""
            : mime.StartsWith("video/", StringComparison.Ordinal) ? "" : "";
        PendingThumbCircle.Visibility = Visibility.Collapsed;
        PendingFile.Visibility = Visibility.Visible;
        UpdateSendEnabled();
        if (!mime.StartsWith("image/", StringComparison.Ordinal)) return;
        try
        {
            using var stream = new Windows.Storage.Streams.InMemoryRandomAccessStream();
            await stream.WriteAsync(System.Runtime.InteropServices.WindowsRuntime.WindowsRuntimeBufferExtensions.AsBuffer(data));
            stream.Seek(0);
            var thumb = new Microsoft.UI.Xaml.Media.Imaging.BitmapImage { DecodePixelWidth = 96 };
            await thumb.SetSourceAsync(stream);
            if (_pendingFile?.Data != data) return;
            PendingThumb.ImageSource = thumb;
            PendingThumbCircle.Visibility = Visibility.Visible;
        }
        catch (Exception ex)
        {
            Log.Error("team pending thumbnail", ex);
        }
    }

    private async void OnSend(object sender, RoutedEventArgs e)
    {
        var body = Composer.Text.Trim();
        var file = _pendingFile;
        if ((body.Length == 0 && file is null) || _peer is not { } peer || Host.Workspace is not { } ws) return;
        var s = Host.Strings;
        Composer.Text = string.Empty;
        ClearPendingFile();
        var replyTo = _replyTo;
        ClearReply();
        var local = file is { } f ? new AttachmentItem(f.Name, f.Mime, f.Data, s) : null;
        var item = new TeamMessageItem(body, local, s, replyTo);
        if (local is not null) _ = local.LoadPreviewAsync();
        _outbox.Add(item);
        _messages.Add(item);
        ThreadEmpty.Visibility = Visibility.Collapsed;
        try
        {
            string? attachmentId = null;
            if (file is { } up)
            {
                attachmentId = await Host.Api.UploadAttachmentAsync(ws.Id, null, up.Name, up.Mime, up.Data);
                if (local is not null) AttachmentItem.Alias(local.Id, attachmentId);
            }
            await Host.Api.SendTeamMessageAsync(ws.Id, peer, body, attachmentId, item.ReplyToId);
            _outbox.Remove(item);
            _threadPoller?.Kick();
            _listPoller?.Kick();
        }
        catch (Exception ex)
        {
            Log.Error("team send", ex);
            _outbox.Remove(item);
            _messages.Remove(item);
            Composer.Text = body;
            if (file is { } back) await SetPendingAsync(back.Name, back.Mime, back.Data);
            ShowError($"{s["sendFailed"]} — {ErrorText.For(ex, s)}");
        }
    }

    // Reply and copy, under every bubble

    private void OnReplyClick(object sender, RoutedEventArgs e)
    {
        if ((sender as FrameworkElement)?.Tag is not TeamMessageItem item || item.Id.StartsWith("local:", StringComparison.Ordinal)) return;
        var s = Host.Strings;
        _replyTo = item;
        ReplyBarTitle.Text = s.Get("replyingTo", "name", item.AuthorLabel(s));
        ReplyBarText.Text = item.Snippet(s);
        ToolTipService.SetToolTip(ReplyBarClose, s["cancelReply"]);
        ReplyBar.Visibility = Visibility.Visible;
        Composer.Focus(FocusState.Programmatic);
    }

    private void OnCancelReply(object sender, RoutedEventArgs e) => ClearReply();

    private void ClearReply()
    {
        _replyTo = null;
        ReplyBar.Visibility = Visibility.Collapsed;
    }

    private void OnCopyClick(object sender, RoutedEventArgs e)
    {
        if ((sender as FrameworkElement)?.Tag is not TeamMessageItem item) return;
        TextClipboard.Copy(item.Body);
        Error.Severity = InfoBarSeverity.Success;
        Error.Message = Host.Strings["copied"];
        Error.ActionButton = null;
        Error.IsOpen = true;
        _ = CloseCopiedSoonAsync();
    }

    private async Task CloseCopiedSoonAsync()
    {
        await Task.Delay(1600);
        if (Error.Severity == InfoBarSeverity.Success) Error.IsOpen = false;
    }

    /// <summary>Tapping a quote brings the original message into view.</summary>
    private void OnQuoteClick(object sender, RoutedEventArgs e)
    {
        if ((sender as FrameworkElement)?.Tag is not TeamMessageItem item || item.ReplyToId is not { } id) return;
        var target = _messages.FirstOrDefault(m => m.Id == id);
        if (target is not null) Messages.ScrollIntoView(target, ScrollIntoViewAlignment.Leading);
    }

    private void ShowError(string message)
    {
        Error.Severity = InfoBarSeverity.Error;
        Error.Message = message;
        Error.ActionButton = null;
        Error.IsOpen = true;
    }

    /// <summary>Opens a file with whatever Windows opens that kind of file with.</summary>
    private async void OnOpenAttachment(object sender, RoutedEventArgs e)
    {
        if ((sender as FrameworkElement)?.Tag is not AttachmentItem a) return;
        try
        {
            var path = await OpenedFiles.PrepareAsync(a);
            var stored = await Windows.Storage.StorageFile.GetFileFromPathAsync(path);
            await Launcher.LaunchFileAsync(stored);
        }
        catch (Exception ex)
        {
            Log.Error("team open attachment", ex);
            ShowError(ErrorText.For(ex, Host.Strings));
        }
    }

    // ── Voice notes ──

    private VoiceRecorder? _recorder;
    private Microsoft.UI.Dispatching.DispatcherQueueTimer? _recordTimer;

    private async void OnMic(object sender, RoutedEventArgs e)
    {
        if (_recorder is { IsRecording: true }) await StopRecordingAsync(keep: true);
        else await StartRecordingAsync();
    }

    private async void OnRecordCancel(object sender, RoutedEventArgs e) => await StopRecordingAsync(keep: false);

    private async Task StartRecordingAsync()
    {
        var s = Host.Strings;
        _recorder = new VoiceRecorder();
        try
        {
            await _recorder.StartAsync();
        }
        catch (Exception ex)
        {
            Log.Error("team voice record", ex);
            await _recorder.DisposeAsync();
            _recorder = null;
            Error.Severity = InfoBarSeverity.Error;
            Error.Message = ex is UnauthorizedAccessException || (uint)ex.HResult == 0x80070005 ? s["micBlocked"] : s["micFailed"];
            var open = new Button { Content = s["openWindowsSettings"] };
            open.Click += async (_, _) => await Launcher.LaunchUriAsync(new Uri("ms-settings:privacy-microphone"));
            Error.ActionButton = open;
            Error.IsOpen = true;
            return;
        }
        ShowRecording(true);
        _recordTimer ??= CreateRecordTimer();
        _recordTimer.Start();
    }

    private async Task StopRecordingAsync(bool keep)
    {
        if (_recorder is not { } recorder) return;
        _recorder = null;
        _recordTimer?.Stop();
        ShowRecording(false);
        try
        {
            if (!keep)
            {
                await recorder.CancelAsync();
                return;
            }
            var length = DateTimeOffset.Now - recorder.StartedAt;
            var data = await recorder.StopAsync();
            if (length < TimeSpan.FromSeconds(1) || data.Length < 1024) return;
            await SetPendingAsync($"voice-note-{DateTime.Now:yyyyMMdd-HHmmss}.m4a", "audio/mp4", data);
        }
        catch (Exception ex)
        {
            Log.Error("team voice stop", ex);
            ShowError(Host.Strings["micFailed"]);
        }
    }

    private void ShowRecording(bool on)
    {
        var s = Host.Strings;
        RecordBar.Visibility = on ? Visibility.Visible : Visibility.Collapsed;
        Composer.Visibility = on ? Visibility.Collapsed : Visibility.Visible;
        RecordCancelButton.Visibility = on ? Visibility.Visible : Visibility.Collapsed;
        AttachButton.IsEnabled = EmojiButton.IsEnabled = !on;
        ComposerHint.Visibility = on ? Visibility.Collapsed : Visibility.Visible;
        MicGlyph.Glyph = on ? "" : "";
        MicButton.Background = on ? Palette.Resource("DangerSoftBrush") : Palette.Transparent;
        ToolTipService.SetToolTip(MicButton, s[on ? "voiceStop" : "voiceRecord"]);
        RecordTime.Text = "0:00";
        RecordHint.Text = s["voiceRecording"];
        RecordDot.Opacity = 1;
        if (!on) Composer.Focus(FocusState.Programmatic);
    }

    private Microsoft.UI.Dispatching.DispatcherQueueTimer CreateRecordTimer()
    {
        var t = DispatcherQueue.CreateTimer();
        t.Interval = TimeSpan.FromMilliseconds(500);
        t.Tick += (_, _) =>
        {
            if (_recorder is not { IsRecording: true } r) return;
            var e = DateTimeOffset.Now - r.StartedAt;
            RecordTime.Text = $"{(int)e.TotalMinutes}:{e.Seconds:00}";
            RecordDot.Opacity = RecordDot.Opacity > 0.5 ? 0.25 : 1;
            if (e >= TimeSpan.FromMinutes(5)) _ = StopRecordingAsync(keep: true);
        };
        return t;
    }
}
