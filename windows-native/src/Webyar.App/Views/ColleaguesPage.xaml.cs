using System.Collections.ObjectModel;
using Microsoft.UI.Input;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Navigation;
using Webyar.App.Helpers;
using Webyar.App.Services;
using Webyar.App.ViewModels;
using Webyar.Core.Api;
using Webyar.Core.Inbox;
using Windows.System;
using Windows.UI.Core;

namespace Webyar.App.Views;

/// <summary>Operator-to-operator messages: the team on the left, the chat with one colleague on the right.</summary>
public sealed partial class ColleaguesPage : Page
{
    private readonly ObservableCollection<ColleagueItem> _items = [];
    private readonly Dictionary<string, ColleagueItem> _all = [];
    private readonly ObservableCollection<TeamMessageItem> _messages = [];
    private Poller? _listPoller;
    private Poller? _threadPoller;
    private string? _peer;
    private string? _me;

    public ColleaguesPage()
    {
        InitializeComponent();
        List.ItemsSource = _items;
        Messages.ItemsSource = _messages;
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
        ThreadEmpty.Text = s["colleagueThreadEmpty"];
        Composer.PlaceholderText = s["messagePlaceholder"];
        _listPoller = new Poller("colleagues", LoadListAsync, () => TimeSpan.FromSeconds(15));
        _listPoller.Start();
        Host.InboxChanged += OnRealtime;
    }

    protected override void OnNavigatedFrom(NavigationEventArgs e)
    {
        base.OnNavigatedFrom(e);
        Host.InboxChanged -= OnRealtime;
        _listPoller?.Dispose();
        _threadPoller?.Dispose();
    }

    private void OnRealtime(Core.Realtime.InboxEvent e)
    {
        _listPoller?.Kick();
        _threadPoller?.Kick();
    }

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
            Filter();
        }
        finally
        {
            Loading.IsActive = false;
            Loading.Visibility = Visibility.Collapsed;
        }
    }

    private void Filter()
    {
        var q = Search.Text.Trim();
        var wanted = _all.Values
            .Where(i => q.Length == 0 || i.Name.Contains(q, StringComparison.CurrentCultureIgnoreCase))
            .OrderByDescending(i => i.UnreadVisibility == Visibility.Visible)
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
        PeerRole.Text = item.Preview;
        Placeholder.Visibility = Visibility.Collapsed;
        Thread.Visibility = Visibility.Visible;
        _messages.Clear();
        _threadPoller?.Dispose();
        var peer = item.Id;
        _threadPoller = new Poller("team-thread", ct => LoadThreadAsync(peer, ct), () => TimeSpan.FromSeconds(5));
        _threadPoller.Start();
        Composer.Focus(FocusState.Programmatic);
    }

    private async Task LoadThreadAsync(string peer, CancellationToken ct)
    {
        if (Host.Workspace is not { } ws) return;
        var t = await Host.Api.TeamThreadAsync(ws.Id, peer, ct);
        if (peer != _peer) return;
        var me = t.Me ?? _me ?? Host.User?.Id;
        var s = Host.Strings;
        var wanted = (t.Messages ?? []).OrderBy(m => m.CreatedAt ?? DateTimeOffset.MinValue).Select(m => new TeamMessageItem(m, me, s)).ToList();
        var i = 0;
        for (; i < wanted.Count && i < _messages.Count && _messages[i].Id == wanted[i].Id; i++)
        {
        }
        while (_messages.Count > i) _messages.RemoveAt(_messages.Count - 1);
        for (; i < wanted.Count; i++) _messages.Add(wanted[i]);
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

    private void OnComposerChanged(object sender, TextChangedEventArgs e) => SendButton.IsEnabled = Composer.Text.Trim().Length > 0;

    private void OnComposerKeyDown(object sender, KeyRoutedEventArgs e)
    {
        if (e.Key != VirtualKey.Enter) return;
        if (InputKeyboardSource.GetKeyStateForCurrentThread(VirtualKey.Shift).HasFlag(CoreVirtualKeyStates.Down)) return;
        e.Handled = true;
        OnSend(this, new RoutedEventArgs());
    }

    private async void OnSend(object sender, RoutedEventArgs e)
    {
        var body = Composer.Text.Trim();
        if (body.Length == 0 || _peer is not { } peer || Host.Workspace is not { } ws) return;
        Composer.Text = string.Empty;
        try
        {
            await Host.Api.SendTeamMessageAsync(ws.Id, peer, body);
            _threadPoller?.Kick();
            _listPoller?.Kick();
        }
        catch (Exception ex)
        {
            Log.Error("team send", ex);
            Composer.Text = body;
            await new ContentDialog
            {
                XamlRoot = XamlRoot,
                FlowDirection = FlowDirection,
                Title = Host.Strings["sendFailed"],
                Content = ErrorText.For(ex, Host.Strings),
                CloseButtonText = Host.Strings["ok"],
            }.ShowAsync();
        }
    }
}
