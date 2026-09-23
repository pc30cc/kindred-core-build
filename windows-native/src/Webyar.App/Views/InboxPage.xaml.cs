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
    private string? _openId;
    private bool _syncing;
    private int _generation;

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
        _poller = new Poller("inbox", LoadAsync, () => Host.PollInterval(TimeSpan.FromSeconds(Host.Config.PollIntervalSeconds)));
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
        _poller?.Dispose();
        _poller = null;
        Chat.Close();
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
        }
    }

    private void ApplyLanguage()
    {
        var s = Host.Strings;
        HeaderText.Text = s["tabInbox"];
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

    private async Task LoadAsync(CancellationToken ct)
    {
        if (Host.Workspace is not { } ws) return;
        var generation = _generation;
        try
        {
            var list = await Host.Api.ConversationsAsync(ws.Id, _filter, ct);
            if (generation != _generation) return; // the filter changed while this was loading
            Apply(list);
            Error.IsOpen = false;
        }
        catch (ApiException e) when (e.Failure != ApiFailure.Unauthorized)
        {
            Error.Message = ErrorText.For(e, Host.Strings);
            Error.IsOpen = true;
            throw;
        }
        finally
        {
            Loading.IsActive = false;
            Loading.Visibility = Visibility.Collapsed;
        }
    }

    private void Apply(IReadOnlyList<Conversation> list)
    {
        var s = Host.Strings;
        var now = DateTimeOffset.Now;
        var sorted = list.OrderByDescending(c => c.LastActivity ?? DateTimeOffset.MinValue).ToList();
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
