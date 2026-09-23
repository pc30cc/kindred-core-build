using System.Collections.ObjectModel;
using System.Text.Json;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Navigation;
using Microsoft.Web.WebView2.Core;
using Webyar.App.Helpers;
using Webyar.App.Services;
using Webyar.App.ViewModels;
using Webyar.Core.Api;
using Webyar.Core.Inbox;
using Webyar.Core.Localization;

namespace Webyar.App.Views;

/// <summary>
/// The web console's Visitors page as a native page: who is on the site now,
/// where they are and what they are reading, with the same filters, numbers,
/// details and page history, and a map. Polls every five seconds, the web's
/// default live refresh.
/// </summary>
public sealed partial class VisitorsPage : Page
{
    private readonly ObservableCollection<VisitorItem> _items = [];
    private readonly List<VisitorItem> _all = [];
    private Poller? _poller;
    private Poller? _mapPoller;
    private bool _includeOffline;
    private string? _country;
    private bool _mapReady;
    private bool _mapConfigured;
    private string? _selectedId;
    private int _historyGeneration;

    public VisitorsPage()
    {
        InitializeComponent();
        List.ItemsSource = _items;
    }

    private static AppHost Host => App.Current.Host;

    protected override void OnNavigatedTo(NavigationEventArgs e)
    {
        base.OnNavigatedTo(e);
        ApplyLanguage();
        _poller = new Poller("visitors", LoadAsync, () => TimeSpan.FromSeconds(5)); // no realtime feed for visitors
        _poller.Start();
        Palette.ThemeChanged += SendTheme;
        _ = StartMapAsync();
    }

    protected override void OnNavigatedFrom(NavigationEventArgs e)
    {
        base.OnNavigatedFrom(e);
        _poller?.Dispose();
        _mapPoller?.Dispose();
        Palette.ThemeChanged -= SendTheme;
        Map.Close();
    }

    private void ApplyLanguage()
    {
        var s = Host.Strings;
        HeaderText.Text = s["navVisitors"];
        SubtitleText.Text = s["visitorsSubtitle"];
        Search.PlaceholderText = s["visitorsSearch"];
        OnlineFilter.Content = s["visitorsFilterOnline"];
        ChatFilter.Content = s["visitorsFilterChat"];
        OfflineSwitch.OnContent = OfflineSwitch.OffContent = s["visitorsIncludeOffline"];
        ToolTipService.SetToolTip(RefreshButton, s["visitorsRefresh"]);
        ToolTipService.SetToolTip(CopyButton, s["visitorCopySession"]);
        StatOnlineLabel.Text = s["visitorsStatOnline"];
        StatActiveLabel.Text = s["visitorsStatActive"];
        StatCountriesLabel.Text = s["visitorsStatCountries"];
        StatPagesLabel.Text = s["visitorsStatPages"];
        DetailTitle.Text = s["visitorDetails"];
        HistoryTitle.Text = s["visitorPageHistory"];
        MapFallbackText.Text = s["visitorsMapHint"];
    }

    // ── Data ──

    private async Task LoadAsync(CancellationToken ct)
    {
        if (Host.Workspace is not { } ws) return;
        var s = Host.Strings;
        IReadOnlyList<LiveVisitor> list;
        try
        {
            list = await Host.Api.LiveVisitorsAsync(ws.Id, _includeOffline, ct);
        }
        catch (ApiException) when (_all.Count == 0)
        {
            Loading.IsActive = false;
            Loading.Visibility = Visibility.Collapsed;
            ShowEmpty(s["visitorsErrorTitle"], s["visitorsRetry"]);
            throw;
        }
        var now = DateTimeOffset.Now;
        var byId = _all.ToDictionary(i => i.Id);
        var next = new List<VisitorItem>();
        foreach (var v in list.OrderByDescending(v => v.LastActivityAt ?? DateTimeOffset.MinValue))
        {
            if (byId.TryGetValue(v.Id, out var item)) item.Update(v, s, now);
            else item = new VisitorItem(v, s, now);
            next.Add(item);
        }
        _all.Clear();
        _all.AddRange(next);
        Loading.IsActive = false;
        Loading.Visibility = Visibility.Collapsed;
        ShowStats();
        ShowCountries();
        Filter();
        if (_selectedId is { } id && _all.FirstOrDefault(i => i.Id == id) is { } open) ShowDetail(open, reloadHistory: false);
        (App.Current.Window?.Shell)?.SetVisitorsOnline(_all.Count(i => i.Status == "online"));
    }

    private void ShowStats()
    {
        var lang = Host.Strings.Language;
        string N(int n) => Digits.Localize(n.ToString(System.Globalization.CultureInfo.InvariantCulture), lang);
        var online = _all.Count(i => i.Status == "online");
        StatOnline.Text = N(online);
        StatActive.Text = N(_all.Count(i => i.Status is "online" or "idle"));
        StatCountries.Text = N(_all.Select(i => i.Visitor.Geo?.CountryCode).Where(c => !string.IsNullOrEmpty(c)).Distinct().Count());
        StatPages.Text = N(_all.Select(i => i.Visitor.CurrentPage).Where(p => !string.IsNullOrEmpty(p)).Distinct().Count());
        CountText.Text = N(online);
    }

    private void ShowCountries()
    {
        var s = Host.Strings;
        var codes = _all.Select(i => (i.Visitor.Geo?.CountryCode, i.Visitor.Geo?.Country))
            .Where(c => !string.IsNullOrEmpty(c.CountryCode)).DistinctBy(c => c.CountryCode).OrderBy(c => c.Country).ToList();
        var wanted = new List<string> { s["visitorsAllCountries"] };
        wanted.AddRange(codes.Select(c => c.Country is { Length: > 0 } n ? n : c.CountryCode!));
        var current = CountryFilter.Items.Cast<ComboBoxItem>().Select(i => (string)i.Content).ToList();
        if (current.SequenceEqual(wanted)) return;
        _suppressCountry = true;
        CountryFilter.Items.Clear();
        CountryFilter.Items.Add(new ComboBoxItem { Content = wanted[0], Tag = null });
        foreach (var c in codes) CountryFilter.Items.Add(new ComboBoxItem { Content = c.Country is { Length: > 0 } n ? n : c.CountryCode, Tag = c.CountryCode });
        var index = _country is null ? 0 : codes.FindIndex(c => c.CountryCode == _country) + 1;
        CountryFilter.SelectedIndex = Math.Max(0, index);
        _suppressCountry = false;
    }

    private bool _suppressCountry;

    private void Filter()
    {
        var q = Search.Text?.Trim() ?? string.Empty;
        var wanted = _all.Where(i => i.Matches(q))
            .Where(i => OnlineFilter.IsChecked != true || i.Status == "online")
            .Where(i => ChatFilter.IsChecked != true || i.Visitor.Conversation is not null)
            .Where(i => _country is null || i.Visitor.Geo?.CountryCode == _country)
            .ToList();
        // Keep rows in place: remove the gone, then insert or move the rest.
        for (var i = _items.Count - 1; i >= 0; i--) if (!wanted.Contains(_items[i])) _items.RemoveAt(i);
        for (var i = 0; i < wanted.Count; i++)
        {
            var at = _items.IndexOf(wanted[i]);
            if (at == i) continue;
            if (at >= 0) _items.Move(at, i);
            else _items.Insert(i, wanted[i]);
        }
        if (_selectedId is { } id && _items.FirstOrDefault(i => i.Id == id) is { } sel && !ReferenceEquals(List.SelectedItem, sel)) List.SelectedItem = sel;

        var s = Host.Strings;
        if (_items.Count > 0) Empty.Visibility = Visibility.Collapsed;
        else if (_all.Count == 0) ShowEmpty(s["visitorsEmptyTitle"], s["visitorsEmptyBody"]);
        else ShowEmpty(s["visitorsNoResults"], string.Empty);
    }

    private void ShowEmpty(string title, string body)
    {
        EmptyTitle.Text = title;
        EmptyBody.Text = body;
        EmptyBody.Visibility = body.Length > 0 ? Visibility.Visible : Visibility.Collapsed;
        Empty.Visibility = Visibility.Visible;
    }

    private void OnSearch(AutoSuggestBox sender, AutoSuggestBoxTextChangedEventArgs args) => Filter();
    private void OnFilter(object sender, RoutedEventArgs e) => Filter();
    private void OnRefresh(object sender, RoutedEventArgs e) { _poller?.Kick(); _mapPoller?.Kick(); }

    private void OnIncludeOffline(object sender, RoutedEventArgs e)
    {
        _includeOffline = OfflineSwitch.IsOn;
        _poller?.Kick();
    }

    private void OnCountry(object sender, SelectionChangedEventArgs e)
    {
        if (_suppressCountry) return;
        _country = (CountryFilter.SelectedItem as ComboBoxItem)?.Tag as string;
        Filter();
    }

    // ── Detail ──

    private void OnSelect(object sender, SelectionChangedEventArgs e)
    {
        if (List.SelectedItem is not VisitorItem item) return;
        ShowDetail(item, reloadHistory: item.Id != _selectedId);
        SendSelect(item);
    }

    private void OnCloseDetail(object sender, RoutedEventArgs e)
    {
        _selectedId = null;
        List.SelectedItem = null;
        DetailPane.Visibility = Visibility.Collapsed;
        DetailColumn.Width = new GridLength(0);
    }

    private void ShowDetail(VisitorItem item, bool reloadHistory)
    {
        var s = Host.Strings;
        var v = item.Visitor;
        _selectedId = item.Id;
        DetailColumn.Width = new GridLength(360);
        DetailPane.Visibility = Visibility.Visible;
        DetailAvatar.DisplayName = item.RawName;
        DetailAvatar.Email = item.Email;
        DetailAvatar.Os = item.Os;
        DetailAvatar.CountryCode = item.CountryCode;
        DetailAvatar.ImageUrl = item.AvatarUrl;
        DetailAvatar.PresenceState = item.Status;
        DetailName.Text = item.Name;
        var (fore, back, label) = item.Status switch
        {
            "online" => ("SuccessBrush", "SuccessSoftBrush", "visitorOnline"),
            "idle" => ("WarningBrush", "WarningSoftBrush", "visitorIdle"),
            _ => ("Text2Brush", "ElevatedBrush", "visitorOffline"),
        };
        DetailStatusChip.Background = Palette.Resource(back);
        DetailStatusText.Foreground = Palette.Resource(fore);
        DetailStatusText.Text = s[label];
        ChatButtonText.Text = v.Conversation is null ? s["visitorStartChat"] : s["visitorOpenChat"];

        DetailRows.Children.Clear();
        Row("", s["visitorCurrentPage"], v.CurrentPage, ltr: true);
        Row("", s["visitorLocation"], VisitorText.Location(v.Geo) ?? s["visitorsUnknownLocation"]);
        if (v.IpDisplay is { Length: > 0 } ip) Row("", s["visitorIp"], ip, ltr: true);
        var browserOs = string.Join(" · ", new[] { v.Browser, v.Os }.Where(x => !string.IsNullOrWhiteSpace(x)));
        if (browserOs.Length > 0) Row("", s["visitorBrowserOs"], browserOs, ltr: true);
        if (v.Device is { Length: > 0 } device) Row("", s["visitorDeviceLabel"], device);
        Row("", s["visitorReferrer"], v.Referrer is { Length: > 0 } r ? r : s["visitorCameFromDirect"], ltr: v.Referrer is { Length: > 0 });
        if (v.LastActivityAt is { } at) Row("", s["visitorLastActivity"], VisitorText.Ago(at, DateTimeOffset.Now, s));
        if (reloadHistory) _ = LoadHistoryAsync(item.Id);
    }

    private void Row(string glyph, string label, string? value, bool ltr = false)
    {
        var grid = new Grid { ColumnSpacing = 12 };
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        grid.Children.Add(new Border
        {
            Width = 30,
            Height = 30,
            CornerRadius = new CornerRadius(8),
            Background = Palette.Resource("BrandSoftBrush"),
            VerticalAlignment = VerticalAlignment.Top,
            Child = new FontIcon { Glyph = glyph, FontSize = 13, Foreground = Palette.Resource("BrandBrush") },
        });
        var text = new StackPanel { Spacing = 1 };
        text.Children.Add(new TextBlock { Text = label, FontSize = 11.5, Foreground = Palette.Resource("Text3Brush") });
        var val = new TextBlock { Text = value ?? "—", FontSize = 13, TextWrapping = TextWrapping.Wrap, IsTextSelectionEnabled = true, Foreground = Palette.Resource("TextBrush") };
        if (ltr) { val.TextReadingOrder = TextReadingOrder.DetectFromContent; val.TextAlignment = TextAlignment.DetectFromContent; }
        text.Children.Add(val);
        Grid.SetColumn(text, 1);
        grid.Children.Add(text);
        DetailRows.Children.Add(grid);
    }

    private async Task LoadHistoryAsync(string sessionId)
    {
        if (Host.Workspace is not { } ws) return;
        var generation = ++_historyGeneration;
        var s = Host.Strings;
        HistoryList.Children.Clear();
        try
        {
            var h = await Host.Api.PageHistoryAsync(ws.Id, sessionId);
            if (generation != _historyGeneration) return;
            var steps = new List<(string Label, string? Url, string? Title, DateTimeOffset? When, bool Current)>();
            if (h.Entry is { } entry)
                steps.Add((s["visitorEntryPoint"], entry.LandingUrl, entry.LandingTitle, entry.LandedAt, false));
            foreach (var p in (h.Items ?? []).Reverse())
            {
                if (steps.Count > 0 && steps[^1].Url == p.Url) continue;
                steps.Add((s["visitorJourney"], p.Url, p.Title, p.ViewedAt, false));
            }
            if (h.Current is { } cur)
            {
                if (steps.Count > 0 && steps[^1].Url == cur.Url) steps.RemoveAt(steps.Count - 1);
                steps.Add((s["visitorCurrentlyOn"], cur.Url, cur.Title, cur.ViewedAt, true));
            }
            if (steps.Count == 0)
            {
                HistoryList.Children.Add(new TextBlock { Text = s["visitorPageHistoryEmpty"], Style = (Style)Application.Current.Resources["MutedText"] });
                return;
            }
            for (var i = 0; i < steps.Count; i++) HistoryList.Children.Add(Step(steps[i], i == steps.Count - 1));
        }
        catch (Exception e)
        {
            Log.Error("page history", e);
        }
    }

    /// <summary>A step of the visit on a vertical line: a dot, the title, the address and when.</summary>
    private UIElement Step((string Label, string? Url, string? Title, DateTimeOffset? When, bool Current) step, bool last)
    {
        var s = Host.Strings;
        var grid = new Grid { ColumnSpacing = 12 };
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(14) });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        var rail = new Grid();
        if (!last) rail.Children.Add(new Microsoft.UI.Xaml.Shapes.Rectangle { Width = 2, Fill = Palette.Resource("LineBrush"), Margin = new Thickness(0, 14, 0, 0) });
        rail.Children.Add(new Microsoft.UI.Xaml.Shapes.Ellipse
        {
            Width = 10,
            Height = 10,
            VerticalAlignment = VerticalAlignment.Top,
            Margin = new Thickness(0, 4, 0, 0),
            Fill = Palette.Resource(step.Current ? "SuccessBrush" : "BrandBrush"),
        });
        grid.Children.Add(rail);
        var body = new StackPanel { Spacing = 1, Margin = new Thickness(0, 0, 0, 14) };
        body.Children.Add(new TextBlock { Text = step.Label, FontSize = 11, FontWeight = Microsoft.UI.Text.FontWeights.SemiBold, Foreground = Palette.Resource(step.Current ? "SuccessBrush" : "Text3Brush") });
        if (step.Title is { Length: > 0 } title) body.Children.Add(new TextBlock { Text = title, FontSize = 13, FontWeight = Microsoft.UI.Text.FontWeights.SemiBold, TextWrapping = TextWrapping.Wrap, Foreground = Palette.Resource("TextBrush") });
        body.Children.Add(new TextBlock { Text = VisitorText.ShortUrl(step.Url), FontSize = 12, TextTrimming = TextTrimming.CharacterEllipsis, Foreground = Palette.Resource("Text2Brush"), TextReadingOrder = TextReadingOrder.DetectFromContent, TextAlignment = TextAlignment.DetectFromContent });
        if (step.When is { } when) body.Children.Add(new TextBlock { Text = VisitorText.Ago(when, DateTimeOffset.Now, s), FontSize = 11, Foreground = Palette.Resource("Text3Brush") });
        Grid.SetColumn(body, 1);
        grid.Children.Add(body);
        return grid;
    }

    private async void OnChat(object sender, RoutedEventArgs e)
    {
        if (_all.FirstOrDefault(i => i.Id == _selectedId) is not { } item || Host.Workspace is not { } ws) return;
        var s = Host.Strings;
        try
        {
            ChatButton.IsEnabled = false;
            var id = item.Visitor.Conversation?.Id;
            if (id is null)
            {
                var r = await Host.Api.StartChatWithVisitorAsync(ws.Id, item.Id);
                id = r.ConversationId;
            }
            if (id is not null) App.Current.Window?.OpenFromNotification(new Dictionary<string, string> { ["conversation"] = id });
        }
        catch (Exception ex)
        {
            Log.Error("start chat", ex);
            await new ContentDialog { XamlRoot = XamlRoot, FlowDirection = FlowDirection, Title = s["visitorStartChat"], Content = ErrorText.For(ex, s), CloseButtonText = s["ok"] }.ShowAsync();
        }
        finally
        {
            ChatButton.IsEnabled = true;
        }
    }

    private void OnCopySession(object sender, RoutedEventArgs e)
    {
        if (_selectedId is null) return;
        var data = new Windows.ApplicationModel.DataTransfer.DataPackage();
        data.SetText(_selectedId);
        Windows.ApplicationModel.DataTransfer.Clipboard.SetContent(data);
        ToolTipService.SetToolTip(CopyButton, Host.Strings["visitorCopied"]);
    }

    // ── Map ──

    private async Task StartMapAsync()
    {
        try
        {
            await Map.EnsureCoreWebView2Async();
            var core = Map.CoreWebView2;
            core.Settings.AreDevToolsEnabled = false;
            core.Settings.AreDefaultContextMenusEnabled = false;
            core.SetVirtualHostNameToFolderMapping("webyar.app", Path.Combine(AppContext.BaseDirectory, "Assets"), CoreWebView2HostResourceAccessKind.Allow);
            core.WebMessageReceived += OnMapMessage;
            core.Navigate("https://webyar.app/Visitors/map.html");
        }
        catch (Exception e)
        {
            Log.Error("visitors map", e);
            MapFallback.Visibility = Visibility.Visible;
        }
    }

    private void OnMapMessage(CoreWebView2 sender, CoreWebView2WebMessageReceivedEventArgs args)
    {
        try
        {
            using var doc = JsonDocument.Parse(args.WebMessageAsJson);
            var type = doc.RootElement.TryGetProperty("type", out var t) ? t.GetString() : null;
            if (type == "ready")
            {
                _mapReady = true;
                SendTheme();
                _mapPoller = new Poller("visitors map", LoadMapAsync, () => TimeSpan.FromSeconds(10));
                _mapPoller.Start();
            }
            else if (type == "select" && doc.RootElement.TryGetProperty("id", out var id) && _all.FirstOrDefault(i => i.Id == id.GetString()) is { } item)
            {
                if (!_items.Contains(item)) { Search.Text = string.Empty; OnlineFilter.IsChecked = ChatFilter.IsChecked = false; _country = null; Filter(); }
                List.SelectedItem = item;
                List.ScrollIntoView(item);
            }
        }
        catch (JsonException)
        {
        }
    }

    private async Task LoadMapAsync(CancellationToken ct)
    {
        if (!_mapReady || Host.Workspace is not { } ws) return;
        if (!_mapConfigured)
        {
            var config = await Host.Api.VisitorMapConfigAsync(ws.Id, ct);
            if (config.ValueKind == JsonValueKind.Object && config.TryGetProperty("enabled", out var en) && en.ValueKind == JsonValueKind.False)
            {
                Map.Visibility = Visibility.Collapsed;
                MapFallback.Visibility = Visibility.Visible;
                _mapPoller?.Dispose();
                return;
            }
            Post(new { type = "config", config });
            _mapConfigured = true;
        }
        var map = await Host.Api.VisitorMapAsync(ws.Id, ct);
        if (map.ValueKind == JsonValueKind.Object && map.TryGetProperty("markers", out var markers))
            Post(new { type = "markers", markers, selected = _selectedId });
    }

    private void SendSelect(VisitorItem item)
    {
        var g = item.Visitor.Geo;
        Post(new { type = "select", id = item.Id, lat = g?.Latitude, lng = g?.Longitude });
    }

    private void SendTheme() => Post(new { type = "theme", dark = Palette.Theme == ElementTheme.Dark });

    private void Post(object message)
    {
        if (!_mapReady || Map.CoreWebView2 is null) return;
        try
        {
            Map.CoreWebView2.PostWebMessageAsJson(JsonSerializer.Serialize(message));
        }
        catch (Exception e)
        {
            Log.Error("map post", e);
        }
    }
}
