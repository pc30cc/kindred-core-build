using System.Collections.ObjectModel;
using Microsoft.UI.Dispatching;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Navigation;
using Webyar.App.Helpers;
using Webyar.App.Services;
using Webyar.App.ViewModels;
using Webyar.Core.Api;
using Webyar.Core.Inbox;
using Webyar.Core.Localization;

namespace Webyar.App.Views;

/// <summary>
/// The web console's call center "Live Desk" as a native page: the waiting
/// line with live wait clocks and SLA colours, one-click answer or decline,
/// the caller's context, the call's timeline, earlier calls and notes, plus
/// the call log. Answering opens the media window straight into the room.
/// </summary>
public sealed partial class CallCenterPage : Page
{
    private readonly ObservableCollection<QueueItem> _queue = [];
    private readonly ObservableCollection<CallHistoryItem> _history = [];
    private readonly Dictionary<string, QueueItem> _byId = [];
    private readonly DispatcherQueueTimer _clock;
    private Poller? _overview;
    private Poller? _detailPoller;
    private string _channel = "all";
    private bool _newestFirst;
    private bool _showHistory;
    private string? _selectedId;
    private CallSession? _selectedCall;
    private IReadOnlyList<CallSession> _recent = [];
    private string? _onCallId;
    private bool _suppressAvailability;

    public CallCenterPage()
    {
        InitializeComponent();
        QueueList.ItemsSource = _queue;
        HistoryList.ItemsSource = _history;
        _clock = DispatcherQueue.GetForCurrentThread().CreateTimer();
        _clock.Interval = TimeSpan.FromSeconds(1);
        _clock.Tick += (_, _) => Tick();
    }

    private static AppHost Host => App.Current.Host;

    protected override void OnNavigatedTo(NavigationEventArgs e)
    {
        base.OnNavigatedTo(e);
        ApplyLanguage();
        if (Host.CallQueue is { } q)
        {
            q.Changed += ShowQueue;
            q.Kick();
        }
        CallWindow.DeskCallEnded += OnDeskCallEnded;
        // Call-center state has no realtime feed to the app, so poll at the web desk's pace always.
        _overview = new Poller("call overview", LoadOverviewAsync, () => TimeSpan.FromSeconds(5));
        _overview.Start();
        _clock.Start();
        ShowQueue();
        _ = LoadAvailabilityAsync();
    }

    protected override void OnNavigatedFrom(NavigationEventArgs e)
    {
        base.OnNavigatedFrom(e);
        if (Host.CallQueue is { } q) q.Changed -= ShowQueue;
        CallWindow.DeskCallEnded -= OnDeskCallEnded;
        _overview?.Dispose();
        _detailPoller?.Dispose();
        _clock.Stop();
    }

    private void ApplyLanguage()
    {
        var s = Host.Strings;
        HeaderText.Text = s["navCallCenter"];
        LiveText.Text = s["ccLiveDesk"];
        DeskTab.Content = s["ccLiveDesk"];
        HistoryTab.Content = s["ccHistory"];
        AvailabilityLabel.Text = s["ccStatusLabel"];
        _suppressAvailability = true;
        AvailabilityBox.Items.Clear();
        AvailabilityBox.Items.Add(new ComboBoxItem { Content = s["ccAvailable"], Tag = "available" });
        AvailabilityBox.Items.Add(new ComboBoxItem { Content = s["ccAway"], Tag = "away" });
        _suppressAvailability = false;
        WaitingLabel.Text = s["ccWaiting"];
        ActiveLabel.Text = s["ccActive"];
        LongestLabel.Text = s["ccLongestWait"];
        SlaLabel.Text = s["ccSlaBreached"];
        MissedLabel.Text = s["ccMissedToday"];
        TodayLabel.Text = s["ccToday"];
        Search.PlaceholderText = s["ccSearch"];
        AllFilter.Content = s["ccFilterAll"];
        VoiceFilter.Content = s["ccFilterVoice"];
        VideoFilter.Content = s["ccFilterVideo"];
        PlaceholderTitle.Text = s["ccNoCallSelected"];
        PlaceholderBody.Text = s["ccNoCallSelectedHint"];
        RejectText.Text = s["ccReject"];
        AcceptText.Text = s["ccAcceptNow"];
        EndText.Text = s["ccEnd"];
        ContactTitle.Text = s["ccContact"];
        PageTitle.Text = s["ccPageContext"];
        TimelineTitle.Text = s["ccTimeline"];
        PreviousTitle.Text = s["ccPreviousCalls"];
        NotesTitle.Text = s["ccNotes"];
        NoteBox.PlaceholderText = s["ccNotePlaceholder"];
        AddNoteButton.Content = s["ccAddNote"];
        ShowListChrome();
    }

    private void ShowListChrome()
    {
        var s = Host.Strings;
        ListTitle.Text = _showHistory ? s["ccHistory"] : s["ccQueue"];
        SortButton.Visibility = _showHistory ? Visibility.Collapsed : Visibility.Visible;
        ToolTipService.SetToolTip(SortButton, s[_newestFirst ? "ccSortNewest" : "ccSortLongest"]);
        QueueList.Visibility = _showHistory ? Visibility.Collapsed : Visibility.Visible;
        HistoryList.Visibility = _showHistory ? Visibility.Visible : Visibility.Collapsed;
    }

    // ── Queue ──

    private void ShowQueue()
    {
        var s = Host.Strings;
        var entries = Host.CallQueue?.Queue ?? [];
        Loading.IsActive = false;
        Loading.Visibility = Visibility.Collapsed;
        var ordered = entries.OrderByDescending(q => q.Priority ?? 0).ThenBy(q => q.CreatedAt ?? DateTimeOffset.MaxValue).ToList();
        var seen = new HashSet<string>();
        for (var i = 0; i < ordered.Count; i++)
        {
            var q = ordered[i];
            seen.Add(q.CallSessionId);
            if (_byId.TryGetValue(q.CallSessionId, out var item)) item.Update(q, i + 1, s);
            else _byId[q.CallSessionId] = new QueueItem(q, i + 1, s);
        }
        foreach (var gone in _byId.Keys.Where(k => !seen.Contains(k)).ToList()) _byId.Remove(gone);
        Filter();
        if (_selectedId is { } id && _byId.TryGetValue(id, out var open)) ShowQueueDetail(open);
    }

    private void Filter()
    {
        var q = Search.Text?.Trim() ?? string.Empty;
        var list = _byId.Values.Where(i => i.Matches(q, _channel));
        list = _newestFirst ? list.OrderByDescending(i => i.Since) : list.OrderByDescending(i => i.Entry.Priority ?? 0).ThenBy(i => i.Since);
        var wanted = list.ToList();
        for (var i = _queue.Count - 1; i >= 0; i--) if (!wanted.Contains(_queue[i])) _queue.RemoveAt(i);
        for (var i = 0; i < wanted.Count; i++)
        {
            var at = _queue.IndexOf(wanted[i]);
            if (at == i) continue;
            if (at >= 0) _queue.Move(at, i);
            else _queue.Insert(i, wanted[i]);
        }
        if (_selectedId is { } id && _queue.FirstOrDefault(x => x.Id == id) is { } sel && !ReferenceEquals(QueueList.SelectedItem, sel)) QueueList.SelectedItem = sel;
        ShowEmpty();
        Tick();
    }

    private void ShowEmpty()
    {
        var s = Host.Strings;
        var none = _showHistory ? _history.Count == 0 : _queue.Count == 0;
        Empty.Visibility = none && !Loading.IsActive ? Visibility.Visible : Visibility.Collapsed;
        if (_showHistory)
        {
            EmptyTitle.Text = s["ccNoHistory"];
            EmptyBody.Text = string.Empty;
        }
        else if (_byId.Count == 0)
        {
            EmptyTitle.Text = s["ccNoCalls"];
            EmptyBody.Text = s["ccNoCallsHint"];
        }
        else
        {
            EmptyTitle.Text = s["ccNoMatches"];
            EmptyBody.Text = string.Empty;
        }
    }

    /// <summary>Every second: the wait clocks, the longest wait and the SLA count.</summary>
    private void Tick()
    {
        var s = Host.Strings;
        var now = DateTimeOffset.Now;
        foreach (var item in _byId.Values) item.Tick(s, now);
        var longest = _byId.Values.Select(i => now - i.Since).DefaultIfEmpty(TimeSpan.Zero).Max();
        LongestValue.Text = Digits.Localize($"{(int)longest.TotalMinutes}:{longest.Seconds:00}", s.Language);
        SlaValue.Text = N(_byId.Values.Count(i => (now - i.Since).TotalSeconds > 180));
        WaitingValue.Text = N(_byId.Count);
        if (_selectedId is { } id && _byId.TryGetValue(id, out var sel))
            WaitLine.Text = s.Get("ccQueuedFor", "time", sel.WaitText);
    }

    private static string N(int n) => Digits.Localize(n.ToString(System.Globalization.CultureInfo.InvariantCulture), Host.Strings.Language);

    private async Task LoadOverviewAsync(CancellationToken ct)
    {
        if (Host.Workspace is not { } ws) return;
        var s = Host.Strings;
        var o = await Host.Api.CallOverviewAsync(ws.Id, ct);
        ActiveValue.Text = N(o.ActiveCalls ?? 0);
        MissedValue.Text = N(o.MissedToday ?? 0);
        TodayValue.Text = N(o.TodayCalls ?? 0);
        var ready = o.Provider?.Ready != false;
        ServiceChip.Background = Palette.Resource(ready ? "SuccessSoftBrush" : "DangerSoftBrush");
        ServiceDot.Fill = Palette.Resource(ready ? "SuccessBrush" : "DangerBrush");
        ServiceText.Foreground = Palette.Resource(ready ? "SuccessBrush" : "DangerBrush");
        ServiceText.Text = $"{s["ccService"]} · {s[ready ? "ccReady" : "ccDown"]}";
        if (_showHistory) await LoadHistoryAsync(ct);
    }

    private async Task LoadHistoryAsync(CancellationToken ct)
    {
        if (Host.Workspace is not { } ws) return;
        _recent = await Host.Api.CallHistoryAsync(ws.Id, 50, ct);
        var s = Host.Strings;
        var keep = (HistoryList.SelectedItem as CallHistoryItem)?.Call.Id;
        _history.Clear();
        foreach (var c in _recent) _history.Add(new CallHistoryItem(c, s));
        if (keep is not null && _history.FirstOrDefault(h => h.Call.Id == keep) is { } again) HistoryList.SelectedItem = again;
        ShowEmpty();
    }

    // ── My availability for calls ──

    private async Task LoadAvailabilityAsync()
    {
        if (Host.Workspace is not { } ws) return;
        try
        {
            var agents = await Host.Api.AgentCallStatusesAsync(ws.Id);
            var mine = agents.FirstOrDefault(a => a.UserId == Host.User?.Id)?.Status ?? "offline";
            _suppressAvailability = true;
            AvailabilityBox.SelectedIndex = mine == "available" ? 0 : mine == "away" ? 1 : -1;
            AvailabilityBox.PlaceholderText = Host.Strings["ccSetAvailable"];
            _suppressAvailability = false;
        }
        catch (Exception e)
        {
            Log.Error("agent status", e);
        }
    }

    private async void OnAvailability(object sender, SelectionChangedEventArgs e)
    {
        if (_suppressAvailability || Host.Workspace is not { } ws || (AvailabilityBox.SelectedItem as ComboBoxItem)?.Tag is not string status) return;
        try
        {
            await Host.Api.SetAgentCallStatusAsync(ws.Id, status);
        }
        catch (Exception ex)
        {
            Log.Error("set agent status", ex);
            ShowDeskError(ErrorText.For(ex, Host.Strings));
            await LoadAvailabilityAsync();
        }
    }

    // ── Filters and tabs ──

    private void OnSearch(AutoSuggestBox sender, AutoSuggestBoxTextChangedEventArgs args)
    {
        if (_showHistory) FilterHistory();
        else Filter();
    }

    private void FilterHistory()
    {
        var s = Host.Strings;
        var q = Search.Text?.Trim() ?? string.Empty;
        _history.Clear();
        foreach (var c in _recent.Where(c => q.Length == 0 || new[] { c.VisitorName, c.VisitorEmail, c.VisitorPhone }.Any(t => t?.Contains(q, StringComparison.OrdinalIgnoreCase) == true))
                                 .Where(c => _channel == "all" || (_channel == "video") == c.IsVideo))
            _history.Add(new CallHistoryItem(c, s));
        ShowEmpty();
    }

    private void OnChannel(object sender, RoutedEventArgs e)
    {
        _channel = (sender as FrameworkElement)?.Tag as string ?? "all";
        AllFilter.IsChecked = _channel == "all";
        VoiceFilter.IsChecked = _channel == "voice";
        VideoFilter.IsChecked = _channel == "video";
        if (_showHistory) FilterHistory();
        else Filter();
    }

    private void OnSort(object sender, RoutedEventArgs e)
    {
        _newestFirst = !_newestFirst;
        SortGlyph.Glyph = _newestFirst ? "" : "";
        ShowListChrome();
        Filter();
    }

    private async void OnTab(object sender, RoutedEventArgs e)
    {
        _showHistory = ReferenceEquals(sender, HistoryTab);
        DeskTab.IsChecked = !_showHistory;
        HistoryTab.IsChecked = _showHistory;
        ShowListChrome();
        if (_showHistory)
        {
            try
            {
                await LoadHistoryAsync(CancellationToken.None);
            }
            catch (Exception ex)
            {
                Log.Error("call history", ex);
            }
        }
        ShowEmpty();
    }

    // ── Opened from the ringing banner or a toast ──

    /// <summary>Shows that call on the live desk; false when it has already left the line.</summary>
    public bool Select(string callId)
    {
        if (_showHistory) OnTab(DeskTab, new RoutedEventArgs());
        ShowQueue();
        if (!_byId.TryGetValue(callId, out var item))
        {
            ShowDeskError(Host.Strings["callTakenElsewhere"], InfoBarSeverity.Informational);
            return false;
        }
        if (!_queue.Contains(item))
        {
            Search.Text = string.Empty;
            OnChannel(AllFilter, new RoutedEventArgs());
        }
        if (ReferenceEquals(QueueList.SelectedItem, item)) OnSelectQueue(QueueList, null!);
        else QueueList.SelectedItem = item;
        QueueList.ScrollIntoView(item);
        return true;
    }

    /// <summary>Answers straight from the banner, through the same path as the Accept button.</summary>
    public void Answer(string callId)
    {
        if (Select(callId)) OnAccept(AcceptButton, new RoutedEventArgs());
    }

    // ── Detail ──

    private void OnSelectQueue(object sender, SelectionChangedEventArgs e)
    {
        if (QueueList.SelectedItem is not QueueItem item) return;
        _selectedId = item.Id;
        _selectedCall = item.Entry.CallSession;
        ShowQueueDetail(item);
        StartDetailPolling(item.Id);
        _ = LoadPreviousAsync(item.Entry.CallSession);
    }

    private void OnSelectHistory(object sender, SelectionChangedEventArgs e)
    {
        if (HistoryList.SelectedItem is not CallHistoryItem item) return;
        _selectedId = item.Call.Id;
        _selectedCall = item.Call;
        ShowCall(item.Call, waiting: false);
        StartDetailPolling(item.Call.Id);
        _ = LoadPreviousAsync(item.Call);
    }

    private void ShowQueueDetail(QueueItem item)
    {
        ShowCall(item.Entry.CallSession ?? new CallSession(item.Id, CallType: item.Entry.Channel, CreatedAt: item.Entry.CreatedAt), waiting: true, fallbackName: item.Name);
    }

    private void ShowCall(CallSession c, bool waiting, string? fallbackName = null)
    {
        var s = Host.Strings;
        Placeholder.Visibility = Visibility.Collapsed;
        DetailScroll.Visibility = Visibility.Visible;
        var name = fallbackName ?? CallNames.Caller(c, c.ContactId ?? c.VisitorSessionId ?? c.Id, s);
        CallerName.Text = name;
        CallerAvatar.DisplayName = c.VisitorName ?? name;
        CallerAvatar.Email = c.VisitorEmail;
        var state = waiting ? "queued" : c.State;
        CallStateText.Text = CallText.State(state, s);
        var (fore, back) = CallText.StateColors(state);
        StateChip.Background = Palette.Resource(back);
        CallStateText.Foreground = Palette.Resource(fore);
        ChannelIcon.Glyph = c.IsVideo ? "" : "";
        ChannelText.Text = s[c.IsVideo ? "ccVideo" : "ccVoice"];
        var onCall = _onCallId == c.Id || (c.State is "active" && c.AssignedAgentId == Host.User?.Id);
        AcceptButton.Visibility = waiting ? Visibility.Visible : Visibility.Collapsed;
        RejectButton.Visibility = waiting ? Visibility.Visible : Visibility.Collapsed;
        EndButton.Visibility = onCall ? Visibility.Visible : Visibility.Collapsed;
        AcceptGlyph.Glyph = c.IsVideo ? "" : "";
        WaitLine.Text = waiting ? string.Empty
            : onCall ? s.Get("ccOnCallWith", "name", name)
            : c.CreatedAt is { } at ? $"{s["ccStartedAt"]} {Display.ListStamp(at, DateTimeOffset.Now, s)}" : string.Empty;

        ContactRows.Children.Clear();
        InfoRow(ContactRows, "", s["ccName"], c.VisitorName ?? name);
        if (c.VisitorEmail is { Length: > 0 } email) InfoRow(ContactRows, "", s["ccEmail"], email, ltr: true);
        if (c.VisitorPhone is { Length: > 0 } phone) InfoRow(ContactRows, "", s["ccPhone"], phone, ltr: true);
        PageRows.Children.Clear();
        if (c.Subject is { Length: > 0 } subject) InfoRow(PageRows, "", s["ccSubject"], subject);
        if (c.PageTitle is { Length: > 0 } title) InfoRow(PageRows, "", s["visitorCurrentPage"], title);
        if (c.PageUrl is { Length: > 0 } url) InfoRow(PageRows, "", "URL", url, ltr: true);
        if (PageRows.Children.Count == 0) PageRows.Children.Add(Muted("—"));
    }

    private void StartDetailPolling(string callId)
    {
        _detailPoller?.Dispose();
        _detailPoller = new Poller("call detail", ct => LoadDetailAsync(callId, ct), () => TimeSpan.FromSeconds(4));
        _detailPoller.Start();
    }

    private async Task LoadDetailAsync(string callId, CancellationToken ct)
    {
        if (Host.Workspace is not { } ws || callId != _selectedId) return;
        var detail = await Host.Api.CallDetailAsync(ws.Id, callId, ct);
        if (callId != _selectedId) return;
        _selectedCall = detail.Call;
        if (!_byId.ContainsKey(callId)) ShowCall(detail.Call, waiting: false);
        ShowTimeline(detail.Events ?? []);
        var notes = await Host.Api.CallNotesAsync(ws.Id, callId, ct);
        if (callId == _selectedId) ShowNotes(notes);
    }

    private void ShowTimeline(IReadOnlyList<CallEvent> events)
    {
        var s = Host.Strings;
        TimelineRows.Children.Clear();
        if (events.Count == 0)
        {
            TimelineRows.Children.Add(Muted(s["ccNoEvents"]));
            return;
        }
        var ordered = events.OrderBy(e => e.CreatedAt ?? DateTimeOffset.MinValue).ToList();
        for (var i = 0; i < ordered.Count; i++)
        {
            var e = ordered[i];
            var grid = new Grid { ColumnSpacing = 10 };
            grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(12) });
            grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            var rail = new Grid();
            if (i < ordered.Count - 1) rail.Children.Add(new Microsoft.UI.Xaml.Shapes.Rectangle { Width = 2, Fill = Palette.Resource("LineBrush"), Margin = new Thickness(0, 12, 0, 0) });
            rail.Children.Add(new Microsoft.UI.Xaml.Shapes.Ellipse { Width = 9, Height = 9, VerticalAlignment = VerticalAlignment.Top, Margin = new Thickness(0, 4, 0, 0), Fill = Palette.Resource(CallText.EventColor(e.EventType)) });
            grid.Children.Add(rail);
            var body = new StackPanel { Margin = new Thickness(0, 0, 0, 10) };
            body.Children.Add(new TextBlock { Text = CallText.Event(e.EventType, s), FontSize = 12.5, FontWeight = Microsoft.UI.Text.FontWeights.SemiBold, Foreground = Palette.Resource("TextBrush") });
            if (e.CreatedAt is { } at) body.Children.Add(new TextBlock { Text = Display.ClockTime(at, s.Language), FontSize = 11, Foreground = Palette.Resource("Text3Brush") });
            Grid.SetColumn(body, 1);
            grid.Children.Add(body);
            TimelineRows.Children.Add(grid);
        }
    }

    private void ShowNotes(IReadOnlyList<CallNote> notes)
    {
        var s = Host.Strings;
        NoteRows.Children.Clear();
        foreach (var n in notes.OrderBy(n => n.CreatedAt ?? DateTimeOffset.MinValue))
        {
            var box = new Border
            {
                Background = Palette.Resource("NoteBubbleBrush"),
                BorderBrush = Palette.Resource("NoteBorderBrush"),
                BorderThickness = new Thickness(1),
                CornerRadius = new CornerRadius(10),
                Padding = new Thickness(12, 8, 12, 8),
            };
            var stack = new StackPanel { Spacing = 3 };
            var when = n.CreatedAt is { } at ? Display.ListStamp(at, DateTimeOffset.Now, s) : string.Empty;
            stack.Children.Add(new TextBlock { Text = $"{n.AuthorName} · {when}", FontSize = 11.5, Foreground = Palette.Resource("Text2Brush") });
            stack.Children.Add(new TextBlock { Text = n.Note, FontSize = 13, TextWrapping = TextWrapping.Wrap, IsTextSelectionEnabled = true, Foreground = Palette.Resource("TextBrush") });
            box.Child = stack;
            NoteRows.Children.Add(box);
        }
    }

    /// <summary>Up to eight earlier calls from the same visitor, matched as the web desk does.</summary>
    private async Task LoadPreviousAsync(CallSession? call)
    {
        var s = Host.Strings;
        PreviousRows.Children.Clear();
        if (call is null || Host.Workspace is not { } ws) return;
        try
        {
            if (_recent.Count == 0) _recent = await Host.Api.CallHistoryAsync(ws.Id, 100);
            var earlier = _recent.Where(c => c.Id != call.Id &&
                    ((call.VisitorSessionId is { } v && c.VisitorSessionId == v) ||
                     (call.VisitorEmail is { Length: > 0 } e && string.Equals(c.VisitorEmail, e, StringComparison.OrdinalIgnoreCase)) ||
                     (call.VisitorPhone is { Length: > 0 } p && c.VisitorPhone == p)))
                .Take(8).ToList();
            if (earlier.Count == 0)
            {
                PreviousRows.Children.Add(Muted(s["ccFirstCall"]));
                return;
            }
            foreach (var c in earlier)
            {
                var item = new CallHistoryItem(c, s);
                var row = new Grid { ColumnSpacing = 10 };
                row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
                row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
                row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
                row.Children.Add(new FontIcon { Glyph = item.IconGlyph, FontSize = 13, Foreground = item.StateBrush });
                var state = new TextBlock { Text = item.StateText, FontSize = 12.5, Foreground = item.StateBrush };
                Grid.SetColumn(state, 1);
                row.Children.Add(state);
                var when = new TextBlock { Text = $"{item.WhenText} · {item.DurationText}", FontSize = 12, Foreground = Palette.Resource("Text3Brush") };
                Grid.SetColumn(when, 2);
                row.Children.Add(when);
                PreviousRows.Children.Add(row);
            }
        }
        catch (Exception e)
        {
            Log.Error("previous calls", e);
        }
    }

    private static void InfoRow(Panel into, string glyph, string label, string value, bool ltr = false)
    {
        var grid = new Grid { ColumnSpacing = 10 };
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        grid.Children.Add(new FontIcon { Glyph = glyph, FontSize = 13, Foreground = Palette.Resource("BrandBrush"), VerticalAlignment = VerticalAlignment.Top, Margin = new Thickness(0, 3, 0, 0) });
        var text = new StackPanel();
        text.Children.Add(new TextBlock { Text = label, FontSize = 11, Foreground = Palette.Resource("Text3Brush") });
        var v = new TextBlock { Text = value, FontSize = 13, TextWrapping = TextWrapping.Wrap, IsTextSelectionEnabled = true, Foreground = Palette.Resource("TextBrush") };
        if (ltr) { v.TextReadingOrder = TextReadingOrder.DetectFromContent; v.TextAlignment = TextAlignment.DetectFromContent; }
        text.Children.Add(v);
        Grid.SetColumn(text, 1);
        grid.Children.Add(text);
        into.Children.Add(grid);
    }

    private static TextBlock Muted(string text) => new() { Text = text, FontSize = 12.5, Foreground = Palette.Resource("Text2Brush"), TextWrapping = TextWrapping.Wrap };

    // ── Actions ──

    private async void OnAccept(object sender, RoutedEventArgs e)
    {
        if (_selectedId is not { } id || Host.Workspace is not { } ws || !_byId.TryGetValue(id, out var item)) return;
        var s = Host.Strings;
        if (CallWindow.IsBusy)
        {
            ShowDeskError(s["ccOnCall"]);
            return;
        }
        AcceptButton.IsEnabled = RejectButton.IsEnabled = false;
        AcceptText.Text = s["ccAnswering"];
        AcceptRing.IsActive = true;
        try
        {
            var accept = await Host.Api.AcceptCallAsync(ws.Id, id);
            _onCallId = id;
            if (accept.Connect is not { Supported: true })
            {
                ShowDeskError($"{s["ccAcceptedNoMedia"]} — {s["ccAcceptedNoMediaHint"]}", InfoBarSeverity.Warning);
            }
            else
            {
                CallWindow.StartDesk(id, accept, ws.Id, item.Entry.IsVideo ? "video" : "audio", item.Name);
            }
            Host.CallQueue?.Kick();
            _detailPoller?.Kick();
        }
        catch (ApiException ex)
        {
            Log.Error("accept call", ex);
            ShowDeskError($"{s["ccAcceptFailed"]} — {ErrorText.For(ex, s)}");
        }
        finally
        {
            AcceptButton.IsEnabled = RejectButton.IsEnabled = true;
            AcceptText.Text = s["ccAcceptNow"];
            AcceptRing.IsActive = false;
        }
    }

    private async void OnReject(object sender, RoutedEventArgs e)
    {
        if (_selectedId is not { } id || Host.Workspace is not { } ws) return;
        var s = Host.Strings;
        RejectButton.IsEnabled = AcceptButton.IsEnabled = false;
        try
        {
            await Host.Api.RejectCallAsync(ws.Id, id);
            Host.CallQueue?.Kick();
        }
        catch (ApiException ex)
        {
            Log.Error("reject call", ex);
            ShowDeskError($"{s["ccRejectFailed"]} — {ErrorText.For(ex, s)}");
        }
        finally
        {
            RejectButton.IsEnabled = AcceptButton.IsEnabled = true;
        }
    }

    private async void OnEnd(object sender, RoutedEventArgs e)
    {
        if (_selectedId is not { } id || Host.Workspace is not { } ws) return;
        try
        {
            await Host.Api.EndCallAsync(ws.Id, id);
            _onCallId = null;
            _detailPoller?.Kick();
        }
        catch (ApiException ex)
        {
            Log.Error("end call", ex);
            ShowDeskError($"{Host.Strings["ccEndFailed"]} — {ErrorText.For(ex, Host.Strings)}");
        }
    }

    /// <summary>After the media window closes: wrap-up — the notes box is right there.</summary>
    private void OnDeskCallEnded(string callId)
    {
        if (_onCallId == callId) _onCallId = null;
        if (callId != _selectedId) return;
        var s = Host.Strings;
        DeskError.Severity = InfoBarSeverity.Informational;
        DeskError.Title = s["ccWrapUp"];
        DeskError.Message = s["ccWrapUpHint"];
        DeskError.IsOpen = true;
        _detailPoller?.Kick();
        NoteBox.Focus(FocusState.Programmatic);
    }

    private async void OnAddNote(object sender, RoutedEventArgs e)
    {
        var text = NoteBox.Text.Trim();
        if (text.Length == 0 || _selectedId is not { } id || Host.Workspace is not { } ws) return;
        AddNoteButton.IsEnabled = false;
        try
        {
            await Host.Api.AddCallNoteAsync(ws.Id, id, text);
            NoteBox.Text = string.Empty;
            _detailPoller?.Kick();
        }
        catch (ApiException ex)
        {
            Log.Error("call note", ex);
            ShowDeskError(ErrorText.For(ex, Host.Strings));
        }
        finally
        {
            AddNoteButton.IsEnabled = true;
        }
    }

    private void ShowDeskError(string message, InfoBarSeverity severity = InfoBarSeverity.Error)
    {
        DeskError.Severity = severity;
        DeskError.Title = string.Empty;
        DeskError.Message = message;
        DeskError.IsOpen = true;
        if (DetailScroll.Visibility != Visibility.Visible)
        {
            Placeholder.Visibility = Visibility.Collapsed;
            DetailScroll.Visibility = Visibility.Visible;
        }
    }
}

/// <summary>The call center's labels and colours, as the web's callLabels.ts.</summary>
public static class CallText
{
    public static string State(string? state, Strings s) => s[state switch
    {
        "pending" => "ccStatePending",
        "queued" or "offered" => "ccStateQueued",
        "ringing" => "ccStateRinging",
        "connecting" => "ccStateConnecting",
        "active" or "in_progress" => "ccStateActive",
        "cancelled" => "ccStateCancelled",
        "missed" => "ccStateMissed",
        "failed" => "ccStateFailed",
        _ => "ccStateEnded",
    }];

    public static (string Fore, string Back) StateColors(string? state) => state switch
    {
        "active" or "in_progress" or "connecting" => ("SuccessBrush", "SuccessSoftBrush"),
        "queued" or "offered" or "pending" or "ringing" => ("WarningBrush", "WarningSoftBrush"),
        "missed" or "failed" => ("DangerBrush", "DangerSoftBrush"),
        "cancelled" => ("Text2Brush", "ElevatedBrush"),
        _ => ("BrandBrush", "BrandSoftBrush"),
    };

    public static string Event(string? type, Strings s)
    {
        var key = type switch
        {
            "call_requested" => "ccEvCallRequested",
            "call_queued" => "ccEvCallQueued",
            "call_accepted" => "ccEvCallAccepted",
            "call_rejected" => "ccEvCallRejected",
            "call_connected" => "ccEvCallConnected",
            "call_ended" => "ccEvCallEnded",
            "call_missed" => "ccEvCallMissed",
            "call_cancelled" => "ccEvCallCancelled",
            "operator_joined" => "ccEvOperatorJoined",
            "visitor_joined" => "ccEvVisitorJoined",
            "visitor_left" => "ccEvVisitorLeft",
            _ => null,
        };
        return key is null ? (type ?? string.Empty).Replace('_', ' ') : s[key];
    }

    public static string EventColor(string? type) => type switch
    {
        "call_accepted" or "call_connected" or "operator_joined" or "visitor_joined" => "SuccessBrush",
        "call_missed" or "call_rejected" or "call_cancelled" or "visitor_left" => "DangerBrush",
        "call_ended" => "Text3Brush",
        _ => "BrandBrush",
    };

    public static string ShortUrl(string? url) => VisitorText.ShortUrl(url);
}
