using System.Collections.ObjectModel;
using Microsoft.UI.Dispatching;
using Microsoft.UI.Input;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Navigation;
using Webyar.App.Helpers;
using Webyar.App.Services;
using Webyar.App.ViewModels;
using Webyar.Core.Api;
using Webyar.Core.Inbox;
using Webyar.Core.Localization;
using VirtualKey = Windows.System.VirtualKey;
using Windows.UI.Core;

namespace Webyar.App.Views;

/// <summary>
/// The web console's call center "Live Desk" as a native page: the waiting
/// line with live wait clocks and SLA colours, one-click answer or decline,
/// the caller's context, the call's timeline, earlier calls and notes, plus
/// the call log. Answering opens the media window straight into the room.
///
/// The page is cached (one per shell, as the Mac keeps one desk model per
/// window): the call picked, the search, the channel, the sort, the tab and the
/// call answered here are all still there after a visit to another section.
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
    /// <summary>The desk call whose media window this page opened, to notice it ended while the page was away.</summary>
    private string? _mediaCallId;
    private string _availability = "offline";
    private bool _queueShown;
    private bool _historyLoaded;
    private bool _historyLoading;
    private bool _overviewLoaded;
    private bool _ending;
    private bool _markingSpam;
    private bool _addingNote;
    private bool _visible;

    public CallCenterPage()
    {
        InitializeComponent();
        NavigationCacheMode = NavigationCacheMode.Required;
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
        _visible = true;
        ApplyLanguage();
        if (Host.CallQueue is { } q)
        {
            q.Changed += ShowQueue;
            q.Kick();
        }
        LiveCall.DeskCallEnded += OnDeskCallEnded;
        Host.Callers.Changed += OnCallerProfiles;
        // Call-center state has no realtime feed to the app, so poll at the web desk's pace always.
        _overview = new Poller("call overview", LoadOverviewAsync, () => TimeSpan.FromSeconds(5));
        _overview.Start();
        _clock.Start();
        ShowQueue();
        // Back on the page: the call picked is shown and followed again.
        if (_selectedId is { } id)
        {
            if (!_byId.ContainsKey(id) && _selectedCall is { } shown) ShowCall(shown, waiting: false);
            StartDetailPolling(id);
        }
        if (_showHistory) _ = ReloadHistoryAsync();
        // A desk call that ended while the page was away (hung up from the shell or its window).
        if (_mediaCallId is { } media && LiveCall.DeskCallId != media) OnDeskCallEnded(media);
        _ = LoadAvailabilityAsync();
    }

    protected override void OnNavigatedFrom(NavigationEventArgs e)
    {
        base.OnNavigatedFrom(e);
        Teardown();
    }

    /// <summary>Stops everything the page runs while on show; the shell calls it when it goes (sign-out, workspace switch).</summary>
    public void Teardown()
    {
        if (!_visible) return;
        _visible = false;
        if (Host.CallQueue is { } q) q.Changed -= ShowQueue;
        LiveCall.DeskCallEnded -= OnDeskCallEnded;
        Host.Callers.Changed -= OnCallerProfiles;
        _overview?.Dispose();
        _overview = null;
        _detailPoller?.Dispose();
        _detailPoller = null;
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
        ToolTipService.SetToolTip(RefreshButton, s["refresh"]);
        ToolTipService.SetToolTip(AvailabilityButton, s["ccStatusLabel"]);
        AvailableItem.Text = s["ccAvailable"];
        AwayItem.Text = s["ccAway"];
        ShowAvailability();
        WaitingLabel.Text = s["ccWaiting"];
        ActiveLabel.Text = s["ccActive"];
        LongestLabel.Text = s["ccLongestWait"];
        SlaLabel.Text = s["ccSlaBreached"];
        MissedLabel.Text = s["ccMissedToday"];
        TodayLabel.Text = s["ccToday"];
        // The server's numbers read "—" until the first overview, rather than a zero that is not true.
        if (!_overviewLoaded) ActiveValue.Text = MissedValue.Text = TodayValue.Text = "—";
        Search.PlaceholderText = s["ccSearch"];
        AllFilter.Content = s["ccFilterAll"];
        VoiceFilterText.Text = s["ccFilterVoice"];
        VideoFilterText.Text = s["ccFilterVideo"];
        PlaceholderTitle.Text = s["ccNoCallSelected"];
        PlaceholderBody.Text = s["ccNoCallSelectedHint"];
        RejectText.Text = s["ccReject"];
        AcceptText.Text = s["ccAcceptNow"];
        EndText.Text = s["ccEnd"];
        SpamChipText.Text = s["callSpam"];
        ContactTitle.Text = s["ccContact"];
        PageTitle.Text = s["ccPageContext"];
        TimelineTitle.Text = s["ccTimeline"];
        PreviousTitle.Text = s["ccPreviousCalls"];
        NotesTitle.Text = s["ccNotes"];
        NoteBox.PlaceholderText = s["ccNotePlaceholder"];
        if (!_addingNote) AddNoteButton.Content = s["ccAddNote"];
        ShowNoteButton();
        ShowListChrome();
    }

    private void ShowListChrome()
    {
        var s = Host.Strings;
        ListTitle.Text = _showHistory ? s["ccHistory"] : s["ccQueue"];
        SortButton.Visibility = _showHistory ? Visibility.Collapsed : Visibility.Visible;
        // Longest wait first (a stopwatch), or newest first (an arrow down), as on the Mac.
        SortGlyph.Glyph = _newestFirst ? "\uE74B" : "\uE916";
        ToolTipService.SetToolTip(SortButton, s[_newestFirst ? "ccSortNewest" : "ccSortLongest"]);
        ShowWaitingBadge();
        QueueList.Visibility = _showHistory ? Visibility.Collapsed : Visibility.Visible;
        HistoryList.Visibility = _showHistory ? Visibility.Visible : Visibility.Collapsed;
    }

    /// <summary>Refresh (Ctrl+R, F5): the line, the numbers and the call picked, now.</summary>
    private void OnRefresh(object sender, RoutedEventArgs e)
    {
        Host.CallQueue?.Kick();
        _overview?.Kick();
        _detailPoller?.Kick();
    }

    /// <summary>Callers' devices arrived: their faces in the line and on the call picked.</summary>
    private void OnCallerProfiles()
    {
        foreach (var item in _byId.Values) item.ShowDevice();
        foreach (var row in _history) row.ShowDevice();
        if (ShownCall() is { } c) ShowFace(c);
    }

    // ── Queue ──

    private void ShowQueue()
    {
        var s = Host.Strings;
        var entries = Host.CallQueue?.Queue ?? [];
        _queueShown = true;
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
        // The log shows its spinner until the first answer (and while it reloads empty); the line until the watcher's first poll.
        var loading = _showHistory ? _history.Count == 0 && (_historyLoading || !_historyLoaded) : !_queueShown;
        Loading.IsActive = loading;
        Loading.Visibility = loading ? Visibility.Visible : Visibility.Collapsed;
        var none = _showHistory ? _history.Count == 0 : _queue.Count == 0;
        Empty.Visibility = none && !loading ? Visibility.Visible : Visibility.Collapsed;
        // A phone for an empty line or log; a filter when the search or the channel hides what there is.
        EmptyGlyph.Glyph = !_showHistory && _byId.Count > 0 ? "\uE71C" : "\uE717";
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
        EmptyBody.Visibility = EmptyBody.Text.Length > 0 ? Visibility.Visible : Visibility.Collapsed;
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
        ShowWaitingBadge();
        if (_selectedId is { } id && _byId.TryGetValue(id, out var sel))
            WaitLine.Text = s.Get("ccQueuedFor", "time", sel.WaitText);
    }

    /// <summary>The red count beside the line's title: how many wait.</summary>
    private void ShowWaitingBadge()
    {
        WaitingBadge.Value = _byId.Count;
        WaitingBadge.Visibility = !_showHistory && _byId.Count > 0 ? Visibility.Visible : Visibility.Collapsed;
    }

    private static string N(int n) => Digits.Localize(n.ToString(System.Globalization.CultureInfo.InvariantCulture), Host.Strings.Language);

    private async Task LoadOverviewAsync(CancellationToken ct)
    {
        if (Host.Workspace is not { } ws) return;
        var s = Host.Strings;
        var o = await Host.Api.CallOverviewAsync(ws.Id, ct);
        _overviewLoaded = true;
        ActiveValue.Text = N(o.ActiveCalls ?? 0);
        MissedValue.Text = N(o.MissedToday ?? 0);
        TodayValue.Text = N(o.TodayCalls ?? 0);
        var ready = o.Provider?.Ready != false;
        ServiceChip.Background = Palette.Resource(ready ? "SuccessSoftBrush" : "DangerSoftBrush");
        ServiceDot.Fill = Palette.Resource(ready ? "SuccessBrush" : "DangerBrush");
        ServiceText.Foreground = Palette.Resource(ready ? "SuccessBrush" : "DangerBrush");
        ServiceText.Text = $"{s["ccService"]} · {s[ready ? "ccReady" : "ccDown"]}";
        ServiceChip.Visibility = Visibility.Visible;
        if (_showHistory) await LoadHistoryAsync(ct);
    }

    /// <summary>The call log, narrowed again by the search box and the channel on show (never the whole log over a search).</summary>
    private async Task LoadHistoryAsync(CancellationToken ct)
    {
        if (Host.Workspace is not { } ws) return;
        _recent = await Host.Api.CallHistoryAsync(ws.Id, 50, ct);
        _historyLoaded = true;
        FilterHistory();
    }

    private async Task ReloadHistoryAsync()
    {
        _historyLoading = true;
        ShowEmpty();
        try
        {
            await LoadHistoryAsync(CancellationToken.None);
        }
        catch (Exception ex)
        {
            Log.Error("call history", ex);
        }
        finally
        {
            _historyLoading = false;
            ShowEmpty();
        }
    }

    // ── My availability for calls ──

    private async Task LoadAvailabilityAsync()
    {
        if (Host.Workspace is not { } ws) return;
        try
        {
            var agents = await Host.Api.AgentCallStatusesAsync(ws.Id);
            _availability = agents.FirstOrDefault(a => a.UserId == Host.User?.Id)?.Status ?? "offline";
            ShowAvailability();
        }
        catch (Exception e)
        {
            Log.Error("agent status", e);
        }
    }

    /// <summary>The capsule: a green dot for available, amber for away, grey (and "set available") for anything else.</summary>
    private void ShowAvailability()
    {
        var s = Host.Strings;
        AvailabilityText.Text = _availability switch
        {
            "available" => s["ccAvailable"],
            "away" => s["ccAway"],
            _ => s["ccSetAvailable"],
        };
        AvailabilityDot.Fill = Palette.Resource(_availability switch
        {
            "available" => "SuccessBrush",
            "away" => "WarningBrush",
            _ => "Text3Brush",
        });
        AvailableItem.IsChecked = _availability == "available";
        AwayItem.IsChecked = _availability == "away";
    }

    private async void OnAvailability(object sender, RoutedEventArgs e)
    {
        if (Host.Workspace is not { } ws || (sender as FrameworkElement)?.Tag is not string status) return;
        var before = _availability;
        _availability = status;
        ShowAvailability();
        try
        {
            await Host.Api.SetAgentCallStatusAsync(ws.Id, status);
        }
        catch (Exception ex)
        {
            Log.Error("set agent status", ex);
            _availability = before;
            ShowAvailability();
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

    /// <summary>The log on show: narrowed by the search box (name, email, phone) and the channel; the row picked stays picked.</summary>
    private void FilterHistory()
    {
        var s = Host.Strings;
        var q = Search.Text?.Trim() ?? string.Empty;
        var keep = (HistoryList.SelectedItem as CallHistoryItem)?.Call.Id ?? _selectedId;
        _history.Clear();
        foreach (var c in _recent.Where(c => q.Length == 0 || new[] { c.VisitorName, c.VisitorEmail, c.VisitorPhone }.Any(t => t?.Contains(q, StringComparison.OrdinalIgnoreCase) == true))
                                 .Where(c => _channel == "all" || (_channel == "video") == c.IsVideo))
            _history.Add(new CallHistoryItem(c, s));
        if (keep is not null && _history.FirstOrDefault(h => h.Call.Id == keep) is { } again) HistoryList.SelectedItem = again;
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
            FilterHistory();
            await ReloadHistoryAsync();
        }
        else
        {
            Filter();
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
            // The call this operator is on: long gone from the line, still the one to show.
            if (LiveCall.DeskCallId == callId)
            {
                if (_selectedId != callId) Open(callId, LiveCall.DeskSession ?? new CallSession(callId), waiting: false);
                return true;
            }
            ShowDeskError(Host.Strings["callTakenElsewhere"], InfoBarSeverity.Informational);
            return false;
        }
        if (!_queue.Contains(item))
        {
            // Hidden by the search or the channel: show the whole line again.
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
        Open(item.Id, item.Entry.CallSession, waiting: true, item);
    }

    private void OnSelectHistory(object sender, SelectionChangedEventArgs e)
    {
        if (HistoryList.SelectedItem is not CallHistoryItem item) return;
        // The log refreshed under the row picked: the same call, nothing to open again.
        if (item.Call.Id == _selectedId && _detailPoller is not null)
        {
            _selectedCall ??= item.Call;
            return;
        }
        Open(item.Call.Id, item.Call, waiting: false);
    }

    /// <summary>Shows a call and follows it: a new one starts clean (no notice, empty notes box).</summary>
    private void Open(string id, CallSession? call, bool waiting, QueueItem? item = null)
    {
        if (id != _selectedId)
        {
            DeskError.IsOpen = false;
            NoteBox.Text = string.Empty;
            NoteRows.Children.Clear();
            // A spinner until the call's timeline arrives, as on the Mac.
            TimelineRows.Children.Clear();
            TimelineRows.Children.Add(new ProgressRing { IsActive = true, Width = 18, Height = 18, HorizontalAlignment = HorizontalAlignment.Left });
        }
        _selectedId = id;
        _selectedCall = call;
        // The call answered on this desk docks over the call it belongs to.
        DockSlot.Key = $"desk:{id}";
        if (item is not null) ShowQueueDetail(item);
        else if (call is not null) ShowCall(call, waiting);
        StartDetailPolling(id);
        _ = LoadPreviousAsync(call ?? (item is null ? null : SessionOf(item.Entry)));
    }

    /// <summary>A queue entry without its session, as a bare session.</summary>
    private static CallSession SessionOf(QueueEntry e) =>
        new(e.CallSessionId, CallType: e.Channel, CreatedAt: e.CreatedAt, VisitorSessionId: e.VisitorSessionId, ContactId: e.ContactId);

    /// <summary>
    /// While it waits the call is the line's copy, and video or voice is the
    /// line's channel (the session's type can still say voice for a video request).
    /// </summary>
    private void ShowQueueDetail(QueueItem item)
    {
        var call = item.Entry.CallSession ?? SessionOf(item.Entry);
        if (_selectedCall is { } marked && marked.Id == call.Id && marked.IsSpam != call.IsSpam) call = call with { Metadata = marked.Metadata };
        ShowCall(call, waiting: true, fallbackName: item.Name, isVideo: item.Entry.IsVideo);
    }

    /// <summary>The call as the detail shows it: the line's copy while it waits, else the latest detail.</summary>
    private CallSession? ShownCall()
    {
        if (_selectedId is not { } id) return null;
        if (_byId.TryGetValue(id, out var item))
        {
            var call = item.Entry.CallSession ?? SessionOf(item.Entry);
            return _selectedCall is { } marked && marked.Id == id ? call with { Metadata = marked.Metadata } : call;
        }
        return _selectedCall;
    }

    private void ShowFace(CallSession c)
    {
        var sessionId = c.VisitorSessionId ?? (_byId.TryGetValue(c.Id, out var item) ? item.Entry.VisitorSessionId : null);
        var profile = Host.Callers.For(sessionId);
        CallerAvatar.Os = profile?.Device?.Os;
        CallerAvatar.CountryCode = profile?.Geo?.CountryCode;
    }

    private void ShowCall(CallSession c, bool waiting, string? fallbackName = null, bool? isVideo = null)
    {
        var s = Host.Strings;
        Placeholder.Visibility = Visibility.Collapsed;
        DetailScroll.Visibility = Visibility.Visible;
        var name = fallbackName ?? CallNames.Caller(c, c.ContactId ?? c.VisitorSessionId ?? c.Id, s);
        var video = isVideo ?? c.IsVideo;
        CallerName.Text = name;
        CallerAvatar.DisplayName = c.VisitorName ?? name;
        CallerAvatar.Email = c.VisitorEmail;
        ShowFace(c);
        var state = waiting ? "queued" : c.State;
        CallStateText.Text = CallText.State(state, s);
        var (fore, back) = CallText.StateColors(state);
        StateChip.Background = Palette.Resource(back);
        CallStateText.Foreground = Palette.Resource(fore);
        ChannelIcon.Glyph = video ? "" : "";
        ChannelText.Text = s[video ? "ccVideo" : "ccVoice"];
        SpamChip.Visibility = c.IsSpam ? Visibility.Visible : Visibility.Collapsed;
        // Spam, as on a chat: a waiting call leaves the line; the caller is flagged, not blocked.
        SpamGlyph.Glyph = c.IsSpam ? "" : "";
        SpamGlyph.Foreground = Palette.Resource(c.IsSpam ? "BrandBrush" : "DangerBrush");
        ToolTipService.SetToolTip(SpamButton, s[c.IsSpam ? "notSpam" : "callMarkSpamTip"]);
        Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(SpamButton, s[c.IsSpam ? "notSpam" : "markSpam"]);
        SpamButton.IsEnabled = !_markingSpam;
        var onCall = _onCallId == c.Id || (c.State is "active" && c.AssignedAgentId is { } agent && agent == Host.User?.Id);
        AcceptButton.Visibility = waiting ? Visibility.Visible : Visibility.Collapsed;
        RejectButton.Visibility = waiting ? Visibility.Visible : Visibility.Collapsed;
        EndButton.Visibility = onCall ? Visibility.Visible : Visibility.Collapsed;
        EndButton.IsEnabled = !_ending;
        AcceptGlyph.Glyph = video ? "" : "";
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
        _detailPoller = null;
        // Only while the page is on show; coming back starts it again.
        if (!_visible) return;
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

    /// <summary>Up to eight earlier calls from the same visitor, matched as the web desk does; a spinner while they load.</summary>
    private async Task LoadPreviousAsync(CallSession? call)
    {
        var s = Host.Strings;
        PreviousRows.Children.Clear();
        if (call is null || Host.Workspace is not { } ws)
        {
            PreviousRows.Children.Add(Muted("—"));
            return;
        }
        PreviousRows.Children.Add(new ProgressRing { IsActive = true, Width = 18, Height = 18, HorizontalAlignment = HorizontalAlignment.Left });
        try
        {
            if (_recent.Count == 0) _recent = await Host.Api.CallHistoryAsync(ws.Id, 100);
            // Another call was picked meanwhile: its own load draws the list.
            if (_selectedId != call.Id) return;
            PreviousRows.Children.Clear();
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
            if (_selectedId == call.Id)
            {
                PreviousRows.Children.Clear();
                PreviousRows.Children.Add(Muted("—"));
            }
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

    // ── Right-click on a waiting call ──

    /// <summary>Answer or decline a waiting call without opening it first (mouse or Shift+F10).</summary>
    private void OnQueueContext(UIElement sender, ContextRequestedEventArgs args)
    {
        DependencyObject? node = args.OriginalSource as DependencyObject;
        while (node is not null and not ListViewItem) node = VisualTreeHelper.GetParent(node);
        if (node is not ListViewItem container || QueueList.ItemFromContainer(container) is not QueueItem item) return;
        args.Handled = true;
        var s = Host.Strings;
        var menu = new MenuFlyout();
        var accept = new MenuFlyoutItem { Text = s["ccAcceptNow"], Icon = new FontIcon { Glyph = item.Entry.IsVideo ? "" : "" } };
        accept.Click += (_, _) =>
        {
            Pick(item);
            OnAccept(AcceptButton, new RoutedEventArgs());
        };
        var reject = new MenuFlyoutItem { Text = s["ccReject"], Icon = new FontIcon { Glyph = "" } };
        reject.Click += (_, _) =>
        {
            Pick(item);
            OnReject(RejectButton, new RoutedEventArgs());
        };
        menu.Items.Add(accept);
        menu.Items.Add(reject);
        if (args.TryGetPosition(container, out var point)) menu.ShowAt(container, point);
        else menu.ShowAt(container);
    }

    private void Pick(QueueItem item)
    {
        if (_selectedId != item.Id) Open(item.Id, item.Entry.CallSession, waiting: true, item);
        if (!ReferenceEquals(QueueList.SelectedItem, item)) QueueList.SelectedItem = item;
    }

    // ── Actions ──

    private async void OnAccept(object sender, RoutedEventArgs e)
    {
        if (_selectedId is not { } id || Host.Workspace is not { } ws || !_byId.TryGetValue(id, out var item)) return;
        var s = Host.Strings;
        if (LiveCall.IsBusy)
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
                // The line's channel decides video; the caller's face is looked up by their visitor session.
                var call = item.Entry.CallSession ?? SessionOf(item.Entry);
                if (item.Entry.IsVideo) call = call with { CallType = "video" };
                if (call.VisitorSessionId is null) call = call with { VisitorSessionId = item.Entry.VisitorSessionId };
                _mediaCallId = id;
                // StartDesk answers by voice when the plan has no video calls.
                LiveCall.StartDesk(id, accept, ws.Id, item.Entry.IsVideo ? "video" : "audio", item.Name, call);
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
        if (_selectedId is not { } id || Host.Workspace is not { } ws || _ending) return;
        _ending = true;
        EndButton.IsEnabled = false;
        try
        {
            await Host.Api.EndCallAsync(ws.Id, id);
            _onCallId = null;
            Host.CallQueue?.Kick();
            _detailPoller?.Kick();
        }
        catch (ApiException ex)
        {
            Log.Error("end call", ex);
            ShowDeskError($"{Host.Strings["ccEndFailed"]} — {ErrorText.For(ex, Host.Strings)}");
        }
        finally
        {
            _ending = false;
            EndButton.IsEnabled = true;
        }
    }

    /// <summary>Spam or not, for the call on show. A call still waiting leaves the line on the server.</summary>
    private async void OnSpam(object sender, RoutedEventArgs e)
    {
        if (_selectedId is not { } id || Host.Workspace is not { } ws || _markingSpam || ShownCall() is not { } call) return;
        var s = Host.Strings;
        var spam = !call.IsSpam;
        _markingSpam = true;
        SpamButton.IsEnabled = false;
        try
        {
            await Host.Api.MarkCallSpamAsync(ws.Id, id, spam);
            if (_selectedId == id)
            {
                // Shown at once, not after the next poll.
                _selectedCall = (_selectedCall is { } c && c.Id == id ? c : call).WithSpam(spam, Host.User?.Id);
                if (_byId.TryGetValue(id, out var item)) ShowQueueDetail(item);
                else ShowCall(_selectedCall, waiting: false);
            }
            ShowDeskError(s[spam ? "callMarkedSpam" : "removedFromSpam"], InfoBarSeverity.Success);
            Host.CallQueue?.Kick();
            _detailPoller?.Kick();
            if (_showHistory) _ = ReloadHistoryAsync();
        }
        catch (ApiException ex)
        {
            Log.Error("call spam", ex);
            ShowDeskError(ErrorText.For(ex, s));
        }
        finally
        {
            _markingSpam = false;
            SpamButton.IsEnabled = true;
        }
    }

    /// <summary>
    /// After the media window closes: wrap-up. The page stays where it is — the
    /// caller and the details in view — and the strip offers the notes box;
    /// taking the keyboard there unasked would scroll the page down to it.
    /// </summary>
    private void OnDeskCallEnded(string callId)
    {
        if (_onCallId == callId) _onCallId = null;
        if (_mediaCallId == callId) _mediaCallId = null;
        if (callId != _selectedId) return;
        var s = Host.Strings;
        var addNote = new Button { Content = s["ccAddNote"] };
        addNote.Click += (_, _) =>
        {
            DeskError.IsOpen = false;
            NoteBox.Focus(FocusState.Programmatic);
            NoteBox.StartBringIntoView();
        };
        DeskError.Severity = InfoBarSeverity.Informational;
        DeskError.Title = s["ccWrapUp"];
        DeskError.Message = s["ccWrapUpHint"];
        DeskError.ActionButton = addNote;
        DeskError.IsOpen = true;
        _detailPoller?.Kick();
    }

    /// <summary>Add is there only for a note with something in it.</summary>
    private void OnNoteChanged(object sender, TextChangedEventArgs e) => ShowNoteButton();

    private void ShowNoteButton() => AddNoteButton.IsEnabled = !_addingNote && NoteBox.Text.Trim().Length > 0;

    /// <summary>The caller's card: the buttons beside the caller when there is room, under them when the column is narrow.</summary>
    private void OnCallerCardSize(object sender, SizeChangedEventArgs e)
    {
        CallerButtons.Measure(new Windows.Foundation.Size(double.PositiveInfinity, double.PositiveInfinity));
        // The avatar (64), the gaps (2 × 18), a name worth reading (200) and the card's padding (40).
        var stacked = e.NewSize.Width < 64 + 36 + 200 + 40 + CallerButtons.DesiredSize.Width;
        Grid.SetRow(CallerButtons, stacked ? 1 : 0);
        Grid.SetColumn(CallerButtons, stacked ? 0 : 2);
        Grid.SetColumnSpan(CallerButtons, stacked ? 3 : 1);
        CallerButtons.HorizontalAlignment = stacked ? HorizontalAlignment.Left : HorizontalAlignment.Stretch;
        CallerButtons.Margin = stacked ? new Thickness(0, 14, 0, 0) : new Thickness(0);
    }

    /// <summary>Ctrl+Enter adds the note; Enter alone starts a new line.</summary>
    private void OnNoteKeyDown(object sender, KeyRoutedEventArgs e)
    {
        if (e.Key != VirtualKey.Enter) return;
        if (!InputKeyboardSource.GetKeyStateForCurrentThread(VirtualKey.Control).HasFlag(CoreVirtualKeyStates.Down)) return;
        e.Handled = true;
        OnAddNote(AddNoteButton, new RoutedEventArgs());
    }

    private async void OnAddNote(object sender, RoutedEventArgs e)
    {
        var text = NoteBox.Text.Trim();
        if (text.Length == 0 || _addingNote || _selectedId is not { } id || Host.Workspace is not { } ws) return;
        _addingNote = true;
        AddNoteButton.IsEnabled = false;
        AddNoteButton.Content = new ProgressRing { IsActive = true, Width = 16, Height = 16 };
        try
        {
            await Host.Api.AddCallNoteAsync(ws.Id, id, text);
            if (_selectedId == id) NoteBox.Text = string.Empty;
            _detailPoller?.Kick();
        }
        catch (ApiException ex)
        {
            Log.Error("call note", ex);
            ShowDeskError(ErrorText.For(ex, Host.Strings));
        }
        finally
        {
            _addingNote = false;
            AddNoteButton.Content = Host.Strings["ccAddNote"];
            ShowNoteButton();
        }
    }

    private void ShowDeskError(string message, InfoBarSeverity severity = InfoBarSeverity.Error)
    {
        DeskError.Severity = severity;
        DeskError.Title = string.Empty;
        DeskError.Message = message;
        DeskError.ActionButton = null;
        DeskError.IsOpen = true;
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
