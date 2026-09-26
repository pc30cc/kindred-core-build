using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Media.Animation;
using Microsoft.UI.Xaml.Navigation;
using Webyar.App.Helpers;
using Webyar.App.Services;
using Webyar.Core.Analytics;
using Webyar.Core.Api;
using Webyar.Core.Inbox;

namespace Webyar.App.Views;

/// <summary>
/// Website analytics, as the web console's SEO → Web Analytics and the Mac
/// app read it: the visits the chat widget's snippet already records, over a
/// shared date range. Owners and admins whose plan has the `web_analytics`
/// module see it; the server checks the same module on every report, and a
/// refusal here says so and has the sidebar look at the plan again.
/// </summary>
public sealed partial class AnalyticsPage : Page
{
    private Poller? _livePoller;
    private Storyboard? _pulse;
    /// <summary>Bumped by every range change and refresh, so a slow answer for the old range is dropped.</summary>
    private int _generation;
    private bool _shown;

    private AnalyticsSection _section = AnalyticsSection.Overview;
    private AnalyticsRange _range = AnalyticsRange.Month;

    /// <summary>The report's dimension on each page that has several.</summary>
    private string _sourceDimension = "channel";
    private string _pagesKind = "top";
    private string _geoDimension = "country";
    /// <summary>The trend shows page views instead of visits.</summary>
    private bool _trendViews;

    private WebAnalyticsOverview? _overview;
    /// <summary>The same report for the days just before the range, for the headline numbers' change.</summary>
    private WebAnalyticsOverview? _previous;
    /// <summary>Report rows by "report.dimension", for the range on show.</summary>
    private readonly Dictionary<string, WebAnalyticsRows<WebAnalyticsRow>> _breakdowns = [];
    private readonly Dictionary<string, WebAnalyticsRows<WebAnalyticsPage>> _pageLists = [];
    private WebAnalyticsRows<WebAnalyticsEvent>? _events;
    /// <summary>Visitors on the site right now.</summary>
    private int? _live;

    private readonly HashSet<string> _loading = [];
    private string? _error;
    /// <summary>The server says the plan does not include web analytics (it may have changed since the sidebar last looked).</summary>
    private bool _locked;

    public AnalyticsPage()
    {
        InitializeComponent();
    }

    private static AppHost Host => App.Current.Host;

    protected override void OnNavigatedTo(NavigationEventArgs e)
    {
        base.OnNavigatedTo(e);
        _shown = true;
        ApplyLanguage();
        BuildSections();
        _livePoller = new Poller("live visitors", LoadLiveAsync, () => TimeSpan.FromSeconds(30));
        _livePoller.Start();
        Load();
        Render();
    }

    protected override void OnNavigatedFrom(NavigationEventArgs e)
    {
        base.OnNavigatedFrom(e);
        _shown = false;
        _generation++;
        _livePoller?.Dispose();
        _livePoller = null;
        _pulse?.Stop();
    }

    private void ApplyLanguage()
    {
        var s = Host.Strings;
        HeaderText.Text = s["navAnalytics"];
        SubtitleText.Text = s["waSubtitle"];
        ToolTipService.SetToolTip(RefreshButton, s["refresh"]);
        Range7.Content = s[AnalyticsRange.Week.RangeKey()];
        Range28.Content = s[AnalyticsRange.Month.RangeKey()];
        Range90.Content = s[AnalyticsRange.Quarter.RangeKey()];
        RetryButton.Content = s["retry"];
        TruncatedText.Text = s["waTruncated"];
        LockedTitle.Text = s["waLocked"];
        LockedHint.Text = s["waLockedHint"];
    }

    /// <summary>One row per report: its icon on a coloured tile, its name and what it answers.</summary>
    private void BuildSections()
    {
        var s = Host.Strings;
        SectionList.Items.Clear();
        foreach (var section in AnalyticsSections.All)
        {
            var tint = AnalyticsUi.Tint(section.Tint());
            var row = new Grid { ColumnSpacing = 12 };
            row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            row.Children.Add(AnalyticsUi.Tile(section.Glyph(), section.Tint(), 34, 10, 13));
            var text = new StackPanel { Spacing = 2, VerticalAlignment = VerticalAlignment.Center };
            text.Children.Add(new TextBlock { Text = s[section.TitleKey()], FontSize = 13.5, FontWeight = Microsoft.UI.Text.FontWeights.SemiBold, TextTrimming = TextTrimming.CharacterEllipsis, Foreground = Palette.Resource("TextBrush") });
            text.Children.Add(new TextBlock { Text = s[section.HintKey()], FontSize = 11.5, TextTrimming = TextTrimming.CharacterEllipsis, Foreground = Palette.Resource("Text2Brush") });
            Grid.SetColumn(text, 1);
            row.Children.Add(text);
            var chevron = new FontIcon { Glyph = s.IsRightToLeft ? "" : "", FontSize = 10, Foreground = tint, Opacity = 0.7, VerticalAlignment = VerticalAlignment.Center };
            Grid.SetColumn(chevron, 2);
            row.Children.Add(chevron);
            SectionList.Items.Add(new ListViewItem { Content = row, Tag = section });
        }
        SectionList.SelectedIndex = Array.IndexOf(AnalyticsSections.All, _section);
    }

    // ── Showing ──

    private void OnSection(object sender, SelectionChangedEventArgs e)
    {
        if ((SectionList.SelectedItem as ListViewItem)?.Tag is not AnalyticsSection section || section == _section) return;
        _section = section;
        DetailScroll.ChangeView(null, 0, null, true);
        Load();
        Render();
    }

    private void OnRange(object sender, RoutedEventArgs e)
    {
        var picked = (sender as FrameworkElement)?.Tag is string t && int.TryParse(t, out var days) ? (AnalyticsRange)days : _range;
        Range7.IsChecked = picked == AnalyticsRange.Week;
        Range28.IsChecked = picked == AnalyticsRange.Month;
        Range90.IsChecked = picked == AnalyticsRange.Quarter;
        if (picked == _range) return;
        _range = picked;
        Reset();
        Load();
        Render();
    }

    /// <summary>Asks again for everything on show.</summary>
    private void OnRefresh(object sender, RoutedEventArgs e)
    {
        Reset();
        Load();
        Render();
        _livePoller?.Kick();
    }

    /// <summary>Forgets the reports for the old range. Answers still out are for it: they will be dropped, so they must not block the new ones.</summary>
    private void Reset()
    {
        _generation++;
        _loading.Clear();
        _overview = null;
        _previous = null;
        _breakdowns.Clear();
        _pageLists.Clear();
        _events = null;
        _error = null;
    }

    // ── Loading ──

    /// <summary>What the page on show needs, unless already here for this range.</summary>
    private void Load()
    {
        switch (_section)
        {
            case AnalyticsSection.Overview:
                if (_overview is null) Fetch("overview", false, (ws, a, b, ct) => Host.Api.AnalyticsOverviewAsync(ws, a, b, ct), v => _overview = v);
                if (_previous is null)
                {
                    var (pa, pb) = _range.PreviousBounds(DateTimeOffset.UtcNow);
                    Fetch("overview.previous", true, (ws, _, _, ct) => Host.Api.AnalyticsOverviewAsync(ws, pa, pb, ct), v => _previous = v);
                }
                break;
            case AnalyticsSection.Sources:
            {
                var key = "sources." + _sourceDimension;
                var dim = _sourceDimension;
                if (!_breakdowns.ContainsKey(key)) Fetch(key, false, (ws, a, b, ct) => Host.Api.AnalyticsTrafficSourcesAsync(ws, dim, a, b, ct), v => _breakdowns[key] = v);
                break;
            }
            case AnalyticsSection.Pages:
            {
                var key = "pages." + _pagesKind;
                var kind = _pagesKind;
                if (!_pageLists.ContainsKey(key)) Fetch(key, false, (ws, a, b, ct) => Host.Api.AnalyticsPagesAsync(ws, kind, a, b, ct), v => _pageLists[key] = v);
                break;
            }
            case AnalyticsSection.Geography:
            {
                var key = "geo." + _geoDimension;
                var dim = _geoDimension;
                if (!_breakdowns.ContainsKey(key)) Fetch(key, false, (ws, a, b, ct) => Host.Api.AnalyticsGeographyAsync(ws, dim, a, b, ct), v => _breakdowns[key] = v);
                break;
            }
            case AnalyticsSection.Technology:
                foreach (var dim in TechDimensions)
                {
                    var key = "tech." + dim;
                    if (!_breakdowns.ContainsKey(key)) Fetch(key, false, (ws, a, b, ct) => Host.Api.AnalyticsTechnologyAsync(ws, dim, a, b, ct), v => _breakdowns[key] = v);
                }
                break;
            case AnalyticsSection.Events:
                if (_events is null) Fetch("events", false, (ws, a, b, ct) => Host.Api.AnalyticsEventsAsync(ws, a, b, ct), v => _events = v);
                break;
        }
    }

    private static readonly string[] TechDimensions = ["device", "os", "browser"];

    /// <summary>
    /// One report for the range on show; its answer is kept only if the range
    /// is still the same. A `quiet` report is only an extra: when it fails the
    /// page shows without it.
    /// </summary>
    private async void Fetch<T>(string key, bool quiet, Func<string, string, string, CancellationToken, Task<T>> request, Action<T> apply)
    {
        if (Host.Workspace is not { } ws || !_loading.Add(key)) return;
        var gen = _generation;
        var (start, end) = _range.Bounds(DateTimeOffset.UtcNow);
        if (!quiet) _error = null;
        try
        {
            var value = await request(ws.Id, start, end, CancellationToken.None);
            if (gen != _generation || !_shown) return;
            apply(value);
            _locked = false;
        }
        catch (ApiException e) when (e.Status == 403)
        {
            if (gen != _generation || quiet || !_shown) return;
            // The plan no longer carries it: say so, and have the sidebar look again.
            _locked = true;
            _ = Host.LoadPlanAsync(CancellationToken.None);
        }
        catch (Exception e)
        {
            if (gen != _generation || quiet || !_shown) return;
            if (e is not ApiException { Failure: ApiFailure.Transport }) Log.Error($"web analytics {key}", e);
            _error = ErrorText.For(e, Host.Strings);
        }
        finally
        {
            if (gen == _generation) _loading.Remove(key);
        }
        if (_shown) Render();
    }

    private async Task LoadLiveAsync(CancellationToken ct)
    {
        if (Host.Workspace is not { } ws) return;
        try
        {
            _live = await Host.Api.AnalyticsLiveVisitorsAsync(ws.Id, ct);
        }
        catch (ApiException e) when (e.Status == 403)
        {
            _live = null;
        }
        RenderLive();
    }

    // ── Rendering ──

    private void RenderLive()
    {
        var s = Host.Strings;
        if (_live is not { } count)
        {
            LivePill.Visibility = Visibility.Collapsed;
            _pulse?.Stop();
            return;
        }
        var on = count > 0;
        LivePill.Visibility = Visibility.Visible;
        LivePill.Background = Palette.Resource(on ? "SuccessSoftBrush" : "ElevatedBrush");
        LiveDot.Fill = Palette.Resource(on ? "SuccessBrush" : "Text3Brush");
        LivePulse.Fill = Palette.Resource("SuccessBrush");
        LiveText.Text = s.Get("waLiveNow", "count", AnalyticsFormat.Count(count, s));
        LiveText.Foreground = Palette.Resource(on ? "SuccessBrush" : "Text2Brush");
        if (on && AnalyticsUi.AnimationsOn) StartPulse();
        else
        {
            _pulse?.Stop();
            LivePulse.Opacity = 0;
        }
    }

    /// <summary>A soft ring that grows out of the green dot and fades, every 1.6 s.</summary>
    private void StartPulse()
    {
        if (_pulse is null)
        {
            _pulse = new Storyboard { RepeatBehavior = RepeatBehavior.Forever };
            var duration = new Duration(TimeSpan.FromSeconds(1.6));
            void Add(string property, double from, double to, DependencyObject target)
            {
                var a = new DoubleAnimation { From = from, To = to, Duration = duration, EnableDependentAnimation = false };
                Storyboard.SetTarget(a, target);
                Storyboard.SetTargetProperty(a, property);
                _pulse.Children.Add(a);
            }
            Add("ScaleX", 0.45, 1, LivePulseScale);
            Add("ScaleY", 0.45, 1, LivePulseScale);
            Add("Opacity", 0.35, 0, LivePulse);
        }
        _pulse.Begin();
    }

    private void Render()
    {
        var s = Host.Strings;
        LockedState.Visibility = _locked ? Visibility.Visible : Visibility.Collapsed;
        DetailScroll.Visibility = _locked ? Visibility.Collapsed : Visibility.Visible;
        if (_locked) return;

        var tint = _section.Tint();
        SectionTile.Background = AnalyticsUi.Soft(tint);
        SectionGlyph.Glyph = _section.Glyph();
        SectionGlyph.Foreground = AnalyticsUi.Tint(tint);
        SectionTitle.Text = s[_section.TitleKey()];
        SectionHint.Text = $"{s[_section.HintKey()]} · {s[_range.RangeKey()]}";

        ErrorBar.IsOpen = _error is not null;
        ErrorBar.Message = _error ?? string.Empty;
        TruncatedNote.Visibility = Truncated ? Visibility.Visible : Visibility.Collapsed;

        var ui = new AnalyticsUi(s);
        ReportHost.Content = _section switch
        {
            AnalyticsSection.Sources => SourcesView(ui),
            AnalyticsSection.Pages => PagesView(ui),
            AnalyticsSection.Geography => GeographyView(ui),
            AnalyticsSection.Technology => TechnologyView(ui),
            AnalyticsSection.Events => EventsView(ui),
            _ => OverviewView(ui),
        };
    }

    private bool Truncated => _section switch
    {
        AnalyticsSection.Overview => _overview?.Truncated == true,
        AnalyticsSection.Sources => _breakdowns.GetValueOrDefault("sources." + _sourceDimension)?.Truncated == true,
        AnalyticsSection.Pages => _pageLists.GetValueOrDefault("pages." + _pagesKind)?.Truncated == true,
        AnalyticsSection.Geography => _breakdowns.GetValueOrDefault("geo." + _geoDimension)?.Truncated == true,
        AnalyticsSection.Technology => TechDimensions.Any(d => _breakdowns.GetValueOrDefault("tech." + d)?.Truncated == true),
        AnalyticsSection.Events => _events?.Truncated == true,
        _ => false,
    };

    // ── The reports ──

    private UIElement OverviewView(AnalyticsUi ui)
    {
        var s = ui.Strings;
        var o = _overview;
        var p = _previous;
        var vs = s.Get("waVsPrevious", "count", AnalyticsFormat.Count((int)_range, s));
        var root = new StackPanel { Spacing = 16 };

        var tiles = new[]
        {
            ui.Kpi("", 0x3B7AF2, s["waVisitors"], o is null ? null : AnalyticsFormat.Count(o.UniqueVisitors ?? 0, s),
                AnalyticsFormat.Change(o?.UniqueVisitors, p?.UniqueVisitors), true, vs),
            ui.Kpi("", 0x6E56CF, s["waSessions"], o is null ? null : AnalyticsFormat.Count(o.Sessions ?? 0, s),
                AnalyticsFormat.Change(o?.Sessions, p?.Sessions), true, vs),
            ui.Kpi("", 0x0EA5A4, s["waPageviews"], o is null ? null : AnalyticsFormat.Count(o.Pageviews ?? 0, s),
                AnalyticsFormat.Change(o?.Pageviews, p?.Pageviews), true, vs),
            ui.Kpi("", 0x30A46C, s["waPagesPerSession"], o is null ? null : AnalyticsFormat.Decimal(o.AvgPagesPerSession ?? 0, s),
                AnalyticsFormat.Change(o?.AvgPagesPerSession, p?.AvgPagesPerSession), true, vs),
            ui.Kpi("", 0xF76B15, s["waBounceRate"], o is null ? null : AnalyticsFormat.Percent((o.BounceRate ?? 0) / 100, s),
                AnalyticsFormat.Change(o?.BounceRate, p?.BounceRate), false, vs),
            ui.Kpi("", 0xD6409F, s["waAvgDuration"], o is null ? null : AnalyticsFormat.Duration(o.AvgVisitDurationSeconds ?? 0, s),
                AnalyticsFormat.Change(o?.AvgVisitDurationSeconds, p?.AvgVisitDurationSeconds), true, vs),
        };
        root.Children.Add(AnalyticsUi.Columns(tiles, 3, 150));

        // Visits or page views, day by day.
        var chart = new Controls.TrendChart(s, AnalyticsUi.Tint(0x3B7AF2).Color, _trendViews ? s["waViews"] : s["waVisitsUnit"]);
        var points = (o?.Trend ?? []).Select(d => (AnalyticsFormat.ParseDay(d.Date), (_trendViews ? d.Pageviews : d.Sessions) ?? 0))
            .Where(x => x.Item1 is not null).Select(x => (x.Item1!.Value, x.Item2)).ToList();
        UIElement trendBody;
        if (o is null) trendBody = ui.Placeholder(240, _loading.Contains("overview"));
        else if (points.All(x => x.Item2 == 0)) trendBody = ui.Empty("", s["waNoData"], s["waNoDataHint"], 0x3B7AF2);
        else
        {
            chart.SetPoints(points);
            trendBody = chart;
        }
        var trendControls = ui.Segmented([(s["waSessions"], "sessions"), (s["waPageviews"], "views")], _trendViews ? "views" : "sessions", tag =>
        {
            _trendViews = tag == "views";
            Render();
        });
        root.Children.Add(ui.Card(s["waTrend"], "", 0x3B7AF2, trendControls, trendBody));

        var channels = (o?.TopChannels ?? []).Select(r => new BarItem(r.Key, AnalyticsFormat.Channel(r.Key, s), r.Sessions ?? 0)).ToList();
        var pages = (o?.TopPages ?? []).Select(r => new BarItem(r.Path, r.Path, r.Views ?? 0) { Ltr = true }).ToList();
        root.Children.Add(AnalyticsUi.Columns(
        [
            ui.Card(s["waTopChannels"], AnalyticsSection.Sources.Glyph(), AnalyticsSection.Sources.Tint(), null,
                ui.BarList(channels, o is null, s["waVisitsUnit"], 6, AnalyticsSection.Sources.Tint())),
            ui.Card(s["waTopPages"], AnalyticsSection.Pages.Glyph(), AnalyticsSection.Pages.Tint(), null,
                ui.BarList(pages, o is null, s["waViews"], 6, AnalyticsSection.Pages.Tint())),
        ], 2, 320));
        return root;
    }

    private UIElement SourcesView(AnalyticsUi ui)
    {
        var s = ui.Strings;
        var result = _breakdowns.GetValueOrDefault("sources." + _sourceDimension);
        var channel = _sourceDimension == "channel";
        var rows = (result?.Rows ?? []).Select(r => new BarItem(r.Key, channel ? AnalyticsFormat.Channel(r.Key, s) : AnalyticsFormat.Unknown(r.Label ?? r.Key, s), r.Sessions ?? 0)
        {
            Secondary = r.Pageviews is { } v ? $"{AnalyticsFormat.Count(v, s)} {s["waViews"]}" : null,
            Ltr = !channel,
        }).ToList();
        var tint = AnalyticsSection.Sources.Tint();
        var picker = ui.Segmented([(s["waChannel"], "channel"), (s["waSource"], "source"), (s["waCampaign"], "campaign")], _sourceDimension, tag =>
        {
            _sourceDimension = tag;
            Load();
            Render();
        });
        return ui.WithInsights(rows, result is not null, s["waTotal"], tint,
            ui.Card(s["waSources"], AnalyticsSection.Sources.Glyph(), tint, picker, ui.BarList(rows, result is null, s["waVisitsUnit"], 25, tint)));
    }

    private UIElement PagesView(AnalyticsUi ui)
    {
        var s = ui.Strings;
        var result = _pageLists.GetValueOrDefault("pages." + _pagesKind);
        var rows = (result?.Rows ?? []).Select(r => new BarItem(r.Path, r.Path, r.Views ?? 0) { Ltr = true }).ToList();
        var tint = AnalyticsSection.Pages.Tint();
        var picker = ui.Segmented([(s["waPagesTop"], "top"), (s["waPagesEntry"], "entry"), (s["waPagesExit"], "exit")], _pagesKind, tag =>
        {
            _pagesKind = tag;
            Load();
            Render();
        });
        return ui.WithInsights(rows, result is not null, s["waPageviews"], tint,
            ui.Card(s["waPages"], AnalyticsSection.Pages.Glyph(), tint, picker, ui.BarList(rows, result is null, s["waViews"], 25, tint)));
    }

    private UIElement GeographyView(AnalyticsUi ui)
    {
        var s = ui.Strings;
        var result = _breakdowns.GetValueOrDefault("geo." + _geoDimension);
        var rows = (result?.Rows ?? []).Select(r =>
        {
            var raw = r.Label ?? r.Key;
            switch (_geoDimension)
            {
                case "country":
                    var (badge, name) = AnalyticsFormat.Country(raw, s);
                    return new BarItem(r.Key, AnalyticsFormat.Unknown(name, s), r.Sessions ?? 0) { Badge = badge };
                case "language":
                    return new BarItem(r.Key, AnalyticsFormat.Unknown(AnalyticsFormat.LanguageName(raw, s), s), r.Sessions ?? 0);
                default:
                    return new BarItem(r.Key, AnalyticsFormat.Unknown(raw, s), r.Sessions ?? 0);
            }
        }).ToList();
        var tint = AnalyticsSection.Geography.Tint();
        var picker = ui.Segmented([(s["waCountry"], "country"), (s["waCity"], "city"), (s["waLanguage"], "language")], _geoDimension, tag =>
        {
            _geoDimension = tag;
            Load();
            Render();
        });
        return ui.WithInsights(rows, result is not null, s["waTotal"], tint,
            ui.Card(s["waGeography"], AnalyticsSection.Geography.Glyph(), tint, picker, ui.BarList(rows, result is null, s["waVisitsUnit"], 25, tint)));
    }

    private UIElement TechnologyView(AnalyticsUi ui)
    {
        var s = ui.Strings;
        var tint = AnalyticsSection.Technology.Tint();
        UIElement Card(string dim, string title, string glyph, Func<string, string>? symbol = null, Func<string, string>? name = null)
        {
            var result = _breakdowns.GetValueOrDefault("tech." + dim);
            var rows = (result?.Rows ?? []).Select(r => new BarItem(r.Key, AnalyticsFormat.Unknown(name?.Invoke(r.Key) ?? r.Label ?? r.Key, s), r.Sessions ?? 0)
            {
                Glyph = symbol?.Invoke(r.Key),
            }).ToList();
            return ui.Card(title, glyph, tint, null, ui.BarList(rows, result is null, s["waVisitsUnit"], 8, tint));
        }
        return AnalyticsUi.Columns(
        [
            Card("device", s["waDevice"], "", AnalyticsFormat.DeviceGlyph, k => AnalyticsFormat.Device(k, s)),
            Card("os", s["waOs"], "", AnalyticsFormat.OsGlyph),
            Card("browser", s["waBrowser"], ""),
        ], 3, 300);
    }

    private UIElement EventsView(AnalyticsUi ui)
    {
        var s = ui.Strings;
        var tint = AnalyticsSection.Events.Tint();
        var rows = _events?.Rows ?? [];
        UIElement body;
        if (_events is null) body = ui.Placeholder(120, true);
        else if (rows.Count == 0) body = ui.Empty(AnalyticsSection.Events.Glyph(), s["waNoEvents"], s["waNoEventsHint"], tint);
        else body = ui.EventsTable(rows, tint);
        return ui.Card(s["waEvents"], AnalyticsSection.Events.Glyph(), tint, null, body);
    }
}
