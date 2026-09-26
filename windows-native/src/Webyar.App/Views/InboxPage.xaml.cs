using System.Collections.ObjectModel;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Navigation;
using Webyar.App.Helpers;
using Webyar.App.Services;
using Webyar.App.ViewModels;
using Webyar.Core.Api;
using Webyar.Core.Inbox;
using Webyar.Core.Localization;
using Webyar.Core.Realtime;

namespace Webyar.App.Views;

/// <summary>The conversation list beside the open thread, as in the web console.</summary>
public sealed partial class InboxPage : Page
{
    private readonly ObservableCollection<ConversationItem> _items = [];
    private readonly Dictionary<string, ConversationItem> _all = [];
    private Poller? _poller;
    private InboxFilter _filter = InboxFilter.Open;
    private string? _channel;
    private string? _title;
    private string? _openId;
    private bool _syncing;
    private int _generation;

    /// <summary>The generation the server's answer was last applied for: a slower read of the PC's copy must not replace it.</summary>
    private int _serverGeneration = -1;

    public InboxPage()
    {
        InitializeComponent();
        List.ItemsSource = _items;
        Chat.StatusChanged += () => _poller?.Kick();
    }

    private static AppHost Host => App.Current.Host;

    public string? OpenConversationId => _openId;

    protected override void OnNavigatedTo(NavigationEventArgs e)
    {
        base.OnNavigatedTo(e);
        ApplyLanguage();
        Host.InboxChanged += OnInboxChanged;
        Host.RealtimeChanged += OnRealtimeChanged;
        Palette.ThemeChanged += OnThemeChanged;
        _poller = new Poller("inbox", LoadAsync, () => Host.PollInterval(TimeSpan.FromSeconds(Host.Config.PollIntervalSeconds)));
        // The PC's copy is drawn while the server is asked; whichever is newer wins.
        _ = ShowLocalAsync();
        _poller.Start();
        if (e.Parameter is string id) Open(id);
    }

    protected override void OnNavigatedFrom(NavigationEventArgs e)
    {
        base.OnNavigatedFrom(e);
        Teardown();
    }

    public void Teardown()
    {
        Host.InboxChanged -= OnInboxChanged;
        Host.RealtimeChanged -= OnRealtimeChanged;
        Palette.ThemeChanged -= OnThemeChanged;
        _poller?.Dispose();
        _poller = null;
        Chat.Close();
    }

    /// <summary>Brushes chosen in code follow a theme switch.</summary>
    private void OnThemeChanged()
    {
        var now = DateTimeOffset.Now;
        foreach (var item in _items) item.Update(item.Conversation, Host.Strings, now);
        Chat.RefreshTheme();
    }

    /// <summary>Opens a conversation, e.g. from a toast, even when it is not in the current filter.</summary>
    public void Open(string id)
    {
        _openId = id;
        if (_all.TryGetValue(id, out var item))
        {
            _syncing = true;
            List.SelectedItem = _items.Contains(item) ? item : null;
            _syncing = false;
            Chat.Show(item.Conversation);
        }
        else
        {
            Chat.ShowById(id);
            _ = ShowKnownAsync(id);
            _ = FindAsync(id);
        }
    }

    /// <summary>A conversation this PC has seen in any queue: its header shows at once, before the search below.</summary>
    private async Task ShowKnownAsync(string id)
    {
        if (Host.Workspace is not { } ws) return;
        var scope = Host.Scope;
        var known = await Host.Lists.FindLocalAsync(ws.Id, id);
        if (known is not null && _openId == id && scope == Host.Scope && !_all.ContainsKey(id)) Chat.Show(known);
    }

    /// <summary>
    /// A conversation outside the list on show (a toast, another queue):
    /// the queues are searched for it so the header, the AI state and the
    /// actions are right, not just the messages.
    /// </summary>
    private async Task FindAsync(string id)
    {
        if (Host.Workspace is not { } ws) return;
        foreach (var filter in new[] { InboxFilter.Ai, InboxFilter.Open, InboxFilter.Pending, InboxFilter.Resolved, InboxFilter.Spam })
        {
            try
            {
                // Revalidated and shared like every queue read: a queue already held costs a 304.
                var list = (await Host.Lists.FetchAsync(ws.Id, filter)).Conversations;
                if (list.FirstOrDefault(c => c.Id == id) is not { } hit) continue;
                if (_openId != id) return;
                var enriched = await Host.WithVisitorProfilesAsync([hit]);
                if (_openId == id) Chat.Show(enriched[0]);
                return;
            }
            catch (Exception e)
            {
                Log.Error("find conversation", e);
                return;
            }
        }
    }

    private void ApplyLanguage()
    {
        var s = Host.Strings;
        HeaderText.Text = _title ?? s["navInboxOpen"];
        Search.PlaceholderText = s["search"];
        ToolTipService.SetToolTip(RefreshButton, s["refresh"]);
        FilterOpen.Text = s["filterOpen"];
        FilterPending.Text = s["filterPending"];
        FilterAi.Text = s["filterAI"];
        FilterResolved.Text = s["filterResolved"];
        EmptyTitle.Text = s["inboxEmptyTitle"];
        EmptyBody.Text = s["inboxEmptyBody"];
    }

    private void OnInboxChanged(InboxEvent e) => _poller?.Kick();

    /// <summary>Back online, or realtime dropped: check at once rather than at the next (slow) tick.</summary>
    private void OnRealtimeChanged(bool up) => _poller?.Kick();

    /// <summary>
    /// Draws the queue from the PC's copy — instantly, and offline too — unless
    /// the server's answer for this queue is already on screen.
    /// </summary>
    private async Task ShowLocalAsync()
    {
        if (Host.Workspace is not { } ws) return;
        var generation = _generation;
        var scope = Host.Scope;
        var filter = _filter;
        var local = await Host.Lists.LoadLocalAsync(ws.Id, filter);
        if (local is null || generation != _generation || scope != Host.Scope || _serverGeneration == generation) return;
        Apply(local);
        Log.Write($"[inbox] shown from the PC: {local.Count} conversations");
        if (_items.Count > 0 || local.Count == 0)
        {
            Loading.IsActive = false;
            Loading.Visibility = Visibility.Collapsed;
        }
    }

    private bool Current(int generation, int scope, Workspace ws) =>
        generation == _generation && scope == Host.Scope && Host.Workspace?.Id == ws.Id;

    private void ShowCounts(InboxCounts c)
    {
        var s = Host.Strings;
        string Label(string key, int? n) => n is > 0 ? $"{s[key]}  {Digits.Localize(n.Value.ToString(System.Globalization.CultureInfo.InvariantCulture), s.Language)}" : s[key];
        FilterOpen.Text = Label("filterOpen", c.Open);
        FilterPending.Text = Label("filterPending", c.Pending);
        FilterAi.Text = Label("filterAI", c.Automated);
        FilterResolved.Text = s["filterResolved"];
    }

    private async Task LoadAsync(CancellationToken ct)
    {
        if (Host.Workspace is not { } ws) return;
        var generation = _generation;
        var scope = Host.Scope;
        var filter = _filter;
        try
        {
            var counts = Host.Api.InboxCountsAsync(ws.Id, "mine", ct);
            // Revalidated: an unchanged queue is a 304 and the copy already held.
            var result = await Host.Lists.FetchAsync(ws.Id, filter, ct);
            if (!Current(generation, scope, ws)) return; // the filter or the workspace changed while this was loading
            var list = await Host.WithVisitorProfilesAsync(result.Conversations, ct);
            if (!Current(generation, scope, ws)) return;
            Apply(list);
            _serverGeneration = generation;
            if (!result.NotModified) _ = Host.Lists.SaveShownAsync(ws.Id, filter, list, result.ETag);
            Error.IsOpen = false;
            try
            {
                ShowCounts(await counts);
            }
            catch (ApiException)
            {
                // Counts are a decoration; the list itself loaded.
            }
        }
        catch (ApiException e) when (e.Failure != ApiFailure.Unauthorized)
        {
            if (Current(generation, scope, ws))
            {
                // Offline with a copy on screen: say so quietly and keep showing it.
                var cached = e.Failure == ApiFailure.Transport && _all.Count > 0;
                Error.Severity = cached ? InfoBarSeverity.Informational : InfoBarSeverity.Warning;
                Error.Message = cached ? Host.Strings["offlineShowingSaved"] : ErrorText.For(e, Host.Strings);
                Error.IsOpen = true;
            }
            throw;
        }
        finally
        {
            if (generation == _generation)
            {
                Loading.IsActive = false;
                Loading.Visibility = Visibility.Collapsed;
            }
        }
    }

    private void Apply(IReadOnlyList<Conversation> list)
    {
        var s = Host.Strings;
        var now = DateTimeOffset.Now;
        var sorted = list
            .Where(c => _channel is null || c.ChannelKey == _channel)
            .OrderByDescending(c => c.LastActivity ?? DateTimeOffset.MinValue).ToList();
        var seen = new HashSet<string>();
        foreach (var c in sorted)
        {
            seen.Add(c.Id);
            if (_all.TryGetValue(c.Id, out var item)) item.Update(c, s, now);
            else _all[c.Id] = new ConversationItem(c, s, now);
        }
        foreach (var gone in _all.Keys.Where(k => !seen.Contains(k)).ToList()) _all.Remove(gone);

        var query = Search.Text.Trim();
        var wanted = sorted.Select(c => _all[c.Id]).Where(i => i.Matches(query)).ToList();
        _syncing = true;
        Reconcile(wanted);
        if (_openId is { } open && _all.TryGetValue(open, out var current))
        {
            List.SelectedItem = current;
            Chat.Refresh(current.Conversation);
        }
        _syncing = false;
        Empty.Visibility = _items.Count == 0 ? Visibility.Visible : Visibility.Collapsed;
        var unread = _all.Values.Count(i => (i.Conversation.UnreadCount ?? 0) > 0);
        TotalText.Text = Digits.Localize(unread.ToString(System.Globalization.CultureInfo.InvariantCulture), s.Language);
        TotalChip.Visibility = unread > 0 ? Visibility.Visible : Visibility.Collapsed;
    }

    /// <summary>Moves the collection to <paramref name="wanted"/> with the fewest changes, so rows keep their state.</summary>
    private void Reconcile(IReadOnlyList<ConversationItem> wanted)
    {
        var keep = wanted.ToHashSet();
        for (var i = _items.Count - 1; i >= 0; i--)
        {
            if (!keep.Contains(_items[i])) _items.RemoveAt(i);
        }
        for (var i = 0; i < wanted.Count; i++)
        {
            var at = _items.IndexOf(wanted[i]);
            if (at == i) continue;
            if (at >= 0) _items.Move(at, i);
            else _items.Insert(i, wanted[i]);
        }
    }

    private void OnSelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        if (_syncing || List.SelectedItem is not ConversationItem item) return;
        _openId = item.Id;
        Chat.Show(item.Conversation);
    }

    private void OnFilterChanged(SelectorBar sender, SelectorBarSelectionChangedEventArgs args)
    {
        if (sender.SelectedItem?.Tag is not string tag || !Enum.TryParse<InboxFilter>(tag, out var filter) || filter == _filter) return;
        _filter = filter;
        _generation++;
        _items.Clear();
        _all.Clear();
        Loading.Visibility = Visibility.Visible;
        Loading.IsActive = true;
        Empty.Visibility = Visibility.Collapsed;
        _ = ShowLocalAsync();
        _poller?.Kick();
    }

    /// <summary>
    /// Switches to one of the inboxes in the navigation pane: a queue/status,
    /// optionally narrowed to one channel ("Other inboxes"), as the web does.
    /// </summary>
    public void ShowInbox(InboxFilter filter, string? channel, string title)
    {
        _title = title;
        HeaderText.Text = title;
        if (filter == _filter && channel == _channel) return;
        _filter = filter;
        _channel = channel;
        _generation++;
        _items.Clear();
        _all.Clear();
        Loading.Visibility = Visibility.Visible;
        Loading.IsActive = true;
        Empty.Visibility = Visibility.Collapsed;
        _ = ShowLocalAsync();
        _poller?.Kick();
    }

    private void OnSearchChanged(AutoSuggestBox sender, AutoSuggestBoxTextChangedEventArgs args)
    {
        var query = sender.Text.Trim();
        _syncing = true;
        Reconcile(_all.Values.OrderByDescending(i => i.Conversation.LastActivity ?? DateTimeOffset.MinValue).Where(i => i.Matches(query)).ToList());
        if (_openId is { } open && _all.TryGetValue(open, out var current) && _items.Contains(current)) List.SelectedItem = current;
        _syncing = false;
        Empty.Visibility = _items.Count == 0 && Loading.Visibility == Visibility.Collapsed ? Visibility.Visible : Visibility.Collapsed;
    }

    private void OnRefresh(object sender, RoutedEventArgs e) => _poller?.Kick();
}
