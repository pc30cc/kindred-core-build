using System.ComponentModel;
using Microsoft.UI.Input;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Navigation;
using Webyar.App.Controls;
using Webyar.App.Helpers;
using Webyar.App.Services;
using Webyar.App.ViewModels;
using Webyar.Core.Api;
using Webyar.Core.Inbox;
using Webyar.Core.Localization;
using Webyar.Core.Support;
using Windows.ApplicationModel.DataTransfer;
using Windows.System;
using Windows.UI.Core;

namespace Webyar.App.Views;

/// <summary>
/// Online support: the chat with the platform's own team (Android:
/// SupportScreens.kt, SupportClosedScreens.kt, SupportRoutes.kt). What it
/// shows and when lives in <see cref="SupportChat"/> (Webyar.Core); this page
/// draws it — the open conversation or a fresh page, the closed ones read
/// back with their rating — and reads it again as Android does: on the
/// team's realtime news, every 15 seconds while on screen, the presence
/// every minute.
/// </summary>
public sealed partial class SupportPage : Page
{
    private static readonly TimeSpan HistoryEvery = TimeSpan.FromSeconds(15);
    private const int StatusEveryTicks = 4;

    /// <summary>The colour stars are.</summary>
    private static readonly SolidColorBrush StarGold = new(Windows.UI.Color.FromArgb(255, 0xF2, 0xA9, 0x00));

    /// <summary>
    /// One chat for the signed-in operator, kept across visits: a message
    /// still on its way when the page is left is delivered all the same, and
    /// coming back shows the chat at once instead of loading it again.
    /// </summary>
    private static SupportChat? _shared;
    private static string? _sharedUser;

    /// <summary>The last status any view read; Settings shows its row from it at once.</summary>
    internal static SupportStatus? KnownStatus { get; set; }

    /// <summary>The offline banner's week, open or folded, for the rest of the session.</summary>
    private static bool _hoursExpanded = true;

    private enum Mode { Chat, ClosedList, ClosedConversation }

    /// <summary>From this page width the closed conversations sit in a column beside the chat.</summary>
    private const double WideFrom = 860;

    private bool _wide;
    private string? _sideSignature;

    private SupportChat _chat = null!;
    private Mode _mode = Mode.Chat;
    private string? _openClosedId;
    private Microsoft.UI.Dispatching.DispatcherQueueTimer? _timer;
    private int _ticks;
    private bool _stickToBottom = true;

    /// <summary>Rows already drawn, by key, with what they were drawn from — a poll that changes nothing redraws nothing.</summary>
    private readonly Dictionary<string, (string Signature, FrameworkElement Element)> _rows = [];
    private List<string> _rowOrder = [];
    private readonly Dictionary<string, AttachmentItem> _files = [];
    private readonly Dictionary<string, int> _draftScores = [];
    private readonly Dictionary<string, string> _draftComments = [];

    public SupportPage()
    {
        InitializeComponent();
    }

    private static AppHost Host => App.Current.Host;

    public static SupportChat SharedChat()
    {
        var user = Host.User?.Id;
        if (_shared is null || _sharedUser != user)
        {
            _shared = new SupportChat(Host.Api, () => Host.Strings);
            _sharedUser = user;
            _ = _shared.RefreshAsync();
        }
        return _shared;
    }

    protected override void OnNavigatedTo(NavigationEventArgs e)
    {
        base.OnNavigatedTo(e);
        var s = Host.Strings;
        FlowDirection = s.IsRightToLeft ? FlowDirection.RightToLeft : FlowDirection.LeftToRight;
        ToolTipService.SetToolTip(BackButton, s["back"]);
        AutomationProperties.SetName(BackButton, s["back"]);
        ToolTipService.SetToolTip(AttachButton, s["supportAttachHint"]);
        AutomationProperties.SetName(AttachButton, s["attachFile"]);
        ToolTipService.SetToolTip(SendButton, s["send"]);
        AutomationProperties.SetName(SendButton, s["send"]);
        Composer.PlaceholderText = s["messagePlaceholder"];
        ComposerHint.Text = s["composerHint"];
        ClosedButtonText.Text = s["supportClosedAction"];
        ToolTipService.SetToolTip(ClosedButton, s["supportClosedTitle"]);
        OfflineText.Text = s["supportOfflineBanner"];
        HoursTitle.Text = s["supportHoursTitle"];
        RetryButton.Content = s["retry"];
        EndedBody.Text = s["supportEndedPanelBody"];
        StartNewButton.Content = s["supportStartNew"];
        ReadOnlyText.Text = s["supportReadOnly"];
        BackToCurrentText.Text = s["supportBackToCurrent"];
        SideTitle.Text = s["supportClosedTitle"];
        _sideSignature = null;
        BuildSkeleton();

        _chat = SharedChat();
        _chat.WorkspaceId = Host.Workspace?.Id;
        _chat.Changed += OnChatChanged;
        _chat.Delivered += OnDelivered;
        // Back on screen: read what happened meanwhile (the first time, the chat's own read is on its way).
        if (_chat.Phase != SupportPhase.Loading) _ = _chat.RefreshAsync();
        _chat.Visible = true;
        Host.InboxChanged += OnRealtime;
        Palette.ThemeChanged += OnThemeChanged;
        _timer = DispatcherQueue.CreateTimer();
        _timer.Interval = HistoryEvery;
        _timer.Tick += OnTick;
        _timer.Start();
        Composer.Text = _chat.Draft;
        Render();
        if (_chat.Composer != SupportComposer.Ended) Composer.Focus(FocusState.Programmatic);
    }

    protected override void OnNavigatedFrom(NavigationEventArgs e)
    {
        base.OnNavigatedFrom(e);
        _timer?.Stop();
        _timer = null;
        Host.InboxChanged -= OnRealtime;
        Palette.ThemeChanged -= OnThemeChanged;
        _chat.Changed -= OnChatChanged;
        _chat.Delivered -= OnDelivered;
        _chat.Visible = false;
        _chat.ClearNotice();
    }

    private void OnTick(Microsoft.UI.Dispatching.DispatcherQueueTimer sender, object args)
    {
        _ticks++;
        if (_ticks % StatusEveryTicks == 0) _ = _chat.LoadStatusAsync();
        _ = _chat.LoadHistoryAsync();
    }

    /// <summary>The team's news on the operator's own channel: the history moved.</summary>
    private void OnRealtime(Core.Realtime.InboxEvent e)
    {
        if (e.Kind is { } kind && SupportRules.LiveKinds.Contains(kind)) _ = _chat.LoadHistoryAsync();
    }

    private void OnThemeChanged()
    {
        // Code-built rows took their brushes when drawn: draw them again in the new theme.
        _rows.Clear();
        _rowOrder.Clear();
        _sideSignature = null;
        BuildSkeleton();
        Render();
    }

    private void OnChatChanged() => Render();

    /// <summary>A picked file landed: its bytes and preview carry over to the server's copy, nothing is downloaded again.</summary>
    private void OnDelivered(PendingSupportItem entry, SupportItem item)
    {
        if (entry.File is null || !_files.Remove("pending:" + entry.ClientMessageId, out var local)) return;
        if (item.Files.FirstOrDefault() is { } sent) AttachmentItem.Alias(local.Id, sent.StoreId);
        else AttachmentItem.Forget(local.Id);
    }

    // ── Drawing ──

    private void Render()
    {
        var s = Host.Strings;
        if (_chat.Status is { } known) KnownStatus = known;
        RenderHeader(s);
        RenderBanner(s);
        ReadOnlyBar.Visibility = Visibility.Collapsed;
        if (_mode == Mode.ClosedList) RenderClosedList(s);
        else RenderTranscriptMode(s);
        RenderNotice();
        RenderSide(s);
    }

    /// <summary>How wide the transcript's column is at most; the closed list's.</summary>
    private const double TranscriptWidth = 760, ClosedListWidth = 820;

    /// <summary>
    /// The transcript as one column in the middle of the chat, as wide as it
    /// may be — a ScrollViewer gives its content only the width it asks for,
    /// which left the bubbles (the operator's own too) huddled on the left.
    /// The frame also fills the viewport's height, so a short conversation
    /// sits at the bottom, by the composer.
    /// </summary>
    private void OnTranscriptSizeChanged(object sender, SizeChangedEventArgs e)
    {
        var pad = TranscriptScroll.Padding;
        var width = Math.Max(0, e.NewSize.Width - pad.Left - pad.Right);
        TranscriptFrame.Width = width;
        TranscriptFrame.MinHeight = Math.Max(0, e.NewSize.Height - pad.Top - pad.Bottom);
        Transcript.Width = Math.Min(TranscriptWidth, width);
        if (_stickToBottom || TranscriptScroll.ScrollableHeight - TranscriptScroll.VerticalOffset < 80)
            DispatcherQueue.TryEnqueue(() => TranscriptScroll.ChangeView(null, TranscriptScroll.ScrollableHeight, null, disableAnimation: true));
    }

    private void OnClosedSizeChanged(object sender, SizeChangedEventArgs e)
    {
        var pad = ClosedScroll.Padding;
        var width = Math.Max(0, e.NewSize.Width - pad.Left - pad.Right);
        ClosedFrame.Width = width;
        ClosedList.Width = Math.Min(ClosedListWidth, width);
    }

    /// <summary>The page grew past, or shrank below, the width where the closed conversations get their own column.</summary>
    private void OnRootSizeChanged(object sender, SizeChangedEventArgs e)
    {
        var wide = e.NewSize.Width >= WideFrom;
        var width = wide ? (e.NewSize.Width >= 1180 ? 340 : 300) : 0;
        if (wide == _wide && SideColumn.Width.Value == width) return;
        var changed = wide != _wide;
        _wide = wide;
        SidePane.Visibility = wide ? Visibility.Visible : Visibility.Collapsed;
        SideColumn.Width = new GridLength(width);
        Root.ColumnSpacing = wide ? 10 : 0;
        if (!changed) return;
        _sideSignature = null;
        // The list has its column now: the chat takes the page again.
        if (wide && _mode == Mode.ClosedList) SetMode(Mode.Chat);
        else Render();
    }

    private void RenderHeader(Strings s)
    {
        var status = _chat.Status;
        var chat = _mode == Mode.Chat;
        TeamMark.Visibility = chat ? Visibility.Visible : Visibility.Collapsed;
        ClosedButton.Visibility = !_wide && chat && _chat.Phase == SupportPhase.Loaded && _chat.Closed.Count > 0 ? Visibility.Visible : Visibility.Collapsed;
        ClosedCountText.Text = Digits.Localize(_chat.Closed.Count.ToString(System.Globalization.CultureInfo.InvariantCulture), s.Language);
        PresenceDot.Visibility = Visibility.Collapsed;
        SubtitleSkeleton.Visibility = Visibility.Collapsed;
        TitleSkeleton.Visibility = Visibility.Collapsed;
        TitleText.Visibility = Visibility.Visible;
        SubtitleLine.Visibility = Visibility.Visible;

        switch (_mode)
        {
            case Mode.Chat:
                if (status is null)
                {
                    // Who answers is not known yet: the skeleton, not a name that changes a moment later.
                    TitleText.Visibility = SubtitleLine.Visibility = Visibility.Collapsed;
                    TitleSkeleton.Visibility = SubtitleSkeleton.Visibility = Visibility.Visible;
                    TeamMarkSkeleton.Visibility = Visibility.Visible;
                    TeamMarkGlyph.Visibility = TeamAvatar.Visibility = TeamMarkDot.Visibility = Visibility.Collapsed;
                    break;
                }
                TitleText.Text = string.IsNullOrWhiteSpace(status.TeamName) ? s["supportTitle"] : status.TeamName;
                SubtitleText.Text = SupportRules.Presence(status.Online, s);
                SubtitleText.Foreground = Palette.Resource(status.Online ? "SuccessBrush" : "Text2Brush");
                PresenceDot.Fill = Palette.Resource(status.Online ? "SuccessBrush" : "Text3Brush");
                PresenceDot.Visibility = Visibility.Visible;
                TeamMarkSkeleton.Visibility = Visibility.Collapsed;
                var face = !string.IsNullOrWhiteSpace(status.TeamAvatar);
                TeamAvatar.Visibility = face ? Visibility.Visible : Visibility.Collapsed;
                TeamMarkGlyph.Visibility = face ? Visibility.Collapsed : Visibility.Visible;
                if (face)
                {
                    TeamAvatar.DisplayName = TitleText.Text;
                    TeamAvatar.ImageUrl = status.TeamAvatar;
                }
                TeamMarkDot.Fill = Palette.Resource(status.Online ? "SuccessBrush" : "Text3Brush");
                TeamMarkDot.Visibility = Visibility.Visible;
                break;
            case Mode.ClosedList:
                TitleText.Text = s["supportClosedTitle"];
                SubtitleText.Text = s["supportTitle"];
                SubtitleText.Foreground = Palette.Resource("Text2Brush");
                break;
            case Mode.ClosedConversation:
                var c = _openClosedId is { } id ? _chat.Conversation(id) : null;
                TitleText.Text = SupportRules.ClosedTitle(_openClosedId is { } pid ? _chat.Preview(pid) : null, s);
                SubtitleText.Text = c is null ? string.Empty : SupportRules.ClosedSubtitle(c, s, DateTimeOffset.Now);
                SubtitleText.Foreground = Palette.Resource("Text2Brush");
                break;
        }
    }

    private void RenderBanner(Strings s)
    {
        var status = _chat.Status;
        if (_mode != Mode.Chat || status is null || !status.Shown || status.Online)
        {
            OfflineBanner.Visibility = Visibility.Collapsed;
            return;
        }
        OfflineBanner.Visibility = Visibility.Visible;
        NextOpenText.Text = status.NextOpenAt is { } at ? SupportRules.NextOpen(at, s, DateTimeOffset.Now) : string.Empty;
        NextOpenText.Visibility = status.NextOpenAt is null ? Visibility.Collapsed : Visibility.Visible;
        var lines = status.Hours is { } hours ? SupportHoursText.Lines(hours, s) : [];
        HoursToggle.Visibility = lines.Count > 0 ? Visibility.Visible : Visibility.Collapsed;
        HoursChevron.Glyph = _hoursExpanded ? "" : "";
        HoursLines.Visibility = lines.Count > 0 && _hoursExpanded ? Visibility.Visible : Visibility.Collapsed;
        HoursLines.Children.Clear();
        foreach (var line in lines) HoursLines.Children.Add(Text(line, 12.5, "Text2Brush"));
        if (status.Hours?.Timezone is { } zone && SupportHoursText.ZoneDiffers(zone))
            HoursLines.Children.Add(Text(s.Get("supportTimeZone", "zone", SupportHoursText.ZoneName(zone)), 12, "Text3Brush"));
    }

    private void OnToggleHours(object sender, RoutedEventArgs e)
    {
        _hoursExpanded = !_hoursExpanded;
        RenderBanner(Host.Strings);
    }

    private void RenderNotice()
    {
        if (_chat.Notice is { } text)
        {
            Notice.Severity = InfoBarSeverity.Error;
            Notice.Message = text;
            Notice.IsOpen = true;
        }
        else
        {
            Notice.IsOpen = false;
        }
    }

    private void OnNoticeClosed(InfoBar sender, InfoBarClosedEventArgs args) => _chat.ClearNotice();

    /// <summary>Shows one of the body's layers: the transcript, the closed list, the skeleton or a state.</summary>
    private void ShowLayer(UIElement layer)
    {
        foreach (var l in new UIElement[] { TranscriptScroll, ClosedScroll, Skeleton, StatePanel })
            l.Visibility = ReferenceEquals(l, layer) ? Visibility.Visible : Visibility.Collapsed;
    }

    private void ShowState(string glyph, string title, string? body, bool retry)
    {
        StateGlyph.Glyph = glyph;
        StateTitle.Text = title;
        StateBody.Text = body ?? string.Empty;
        StateBody.Visibility = string.IsNullOrEmpty(body) ? Visibility.Collapsed : Visibility.Visible;
        RetryButton.Visibility = retry ? Visibility.Visible : Visibility.Collapsed;
        ShowLayer(StatePanel);
    }

    private void RenderTranscriptMode(Strings s)
    {
        ComposerCard.Visibility = EndedPanel.Visibility = Visibility.Collapsed;
        switch (_chat.Phase)
        {
            case SupportPhase.Loading:
                ShowLayer(Skeleton);
                return;
            case SupportPhase.Failed:
                ShowState("", s["offlineTitle"], _chat.FailedMessage, retry: true);
                return;
        }

        IReadOnlyList<SupportRow> rows;
        if (_mode == Mode.ClosedConversation)
        {
            var c = _openClosedId is { } id ? _chat.Conversation(id) : null;
            if (c is null)
            {
                ShowState("", s["supportClosedEmpty"], null, retry: false);
                return;
            }
            ReadOnlyBar.Visibility = Visibility.Visible;
            rows = SupportTimeline.Build([c], _chat.ItemsOf(c.Id), []);
        }
        else
        {
            switch (_chat.Composer)
            {
                case SupportComposer.Ended:
                    EndedTitle.Text = SupportRules.EndedSentence(_chat.Shown?.Status == SupportConversation.StatusClosed ? SupportConversation.StatusClosed : SupportConversation.StatusResolved, s);
                    EndedPanel.Visibility = Visibility.Visible;
                    break;
                default:
                    ComposerCard.Visibility = Visibility.Visible;
                    if (Composer.Text != _chat.Draft)
                    {
                        Composer.Text = _chat.Draft;
                        Composer.SelectionStart = Composer.Text.Length;
                    }
                    UpdateSendEnabled();
                    break;
            }
            if (_chat.IsEmpty)
            {
                ShowState("", s["supportGreeting"], s["supportGreetingBody"], retry: false);
                return;
            }
            rows = _chat.Rows();
        }
        ShowLayer(TranscriptScroll);
        DrawRows(rows, s);
    }

    private void DrawRows(IReadOnlyList<SupportRow> rows, Strings s)
    {
        var atBottom = TranscriptScroll.ScrollableHeight - TranscriptScroll.VerticalOffset < 80;
        var now = DateTimeOffset.Now;
        var order = new List<string>(rows.Count);
        var wanted = new HashSet<string>();
        foreach (var row in rows)
        {
            var signature = Signature(row);
            wanted.Add(row.Key);
            order.Add(row.Key);
            if (_rows.TryGetValue(row.Key, out var drawn) && drawn.Signature == signature) continue;
            _rows[row.Key] = (signature, Build(row, s, now));
        }
        foreach (var gone in _rows.Keys.Where(k => !wanted.Contains(k)).ToList()) _rows.Remove(gone);

        var children = Transcript.Children;
        var same = order.SequenceEqual(_rowOrder) && children.Count == order.Count &&
                   order.Select((k, i) => ReferenceEquals(children[i], _rows[k].Element)).All(x => x);
        if (!same)
        {
            children.Clear();
            foreach (var key in order) children.Add(_rows[key].Element);
            _rowOrder = order;
        }
        if (atBottom || _stickToBottom)
        {
            _stickToBottom = false;
            TranscriptScroll.UpdateLayout();
            TranscriptScroll.ChangeView(null, TranscriptScroll.ScrollableHeight, null, disableAnimation: !same);
        }
    }

    /// <summary>What a row was drawn from: the same signature draws the same thing.</summary>
    private string Signature(SupportRow row)
    {
        var c = row.Conversation;
        return row.Kind switch
        {
            SupportRowKind.Bubble => $"b|{row.Item?.Id}|{row.Item?.Body}|{row.Item?.Files.Count}|{row.Pending?.Failed}|{row.StartsRun}|{row.EndsRun}|{row.DayHeader?.Date}|{row.Item?.SenderAvatar}",
            SupportRowKind.Joined => $"j|{row.Item?.SenderName}|{row.DayHeader?.Date}",
            SupportRowKind.NewConversation => $"n|{row.Time}",
            SupportRowKind.Ended => $"e|{c?.Status}|{c?.EndedAt}",
            SupportRowKind.Rating => $"r|{c?.CanRate}|{c?.Rating?.Score}|{c?.Rating?.Comment}|{c is not null && _chat.RatingBusy.Contains(c.Id)}",
            _ => row.Key,
        };
    }

    private FrameworkElement Build(SupportRow row, Strings s, DateTimeOffset now) => row.Kind switch
    {
        SupportRowKind.NewConversation => NewConversationLine(SupportRules.NewConversation(row.Time, s, now)),
        SupportRowKind.Joined => WithDay(row, s, now, Pill(SupportRules.Joined(row.Item?.SenderName, s))),
        SupportRowKind.Ended => EndedLine(row.Conversation!, s, now),
        SupportRowKind.Rating => RatingCard(row.Conversation!, s),
        _ => WithDay(row, s, now, Bubble(row, s)),
    };

    private static FrameworkElement WithDay(SupportRow row, Strings s, DateTimeOffset now, FrameworkElement content)
    {
        if (row.DayHeader is not { } day) return content;
        var panel = new StackPanel();
        panel.Children.Add(DayChip(SupportRules.DayHeader(day, s, now)));
        panel.Children.Add(content);
        return panel;
    }

    private static FrameworkElement DayChip(string text)
    {
        var grid = new Grid { Margin = new Thickness(0, 14, 0, 8), ColumnSpacing = 12 };
        grid.ColumnDefinitions.Add(new ColumnDefinition());
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        grid.ColumnDefinitions.Add(new ColumnDefinition());
        grid.Children.Add(Rule());
        var chip = new Border { Padding = new Thickness(10, 3, 10, 3), CornerRadius = new CornerRadius(8), Background = Palette.Resource("ElevatedBrush") };
        chip.Child = Text(text, 11.5, "Text3Brush", semibold: true);
        Grid.SetColumn(chip, 1);
        grid.Children.Add(chip);
        var right = Rule();
        Grid.SetColumn(right, 2);
        grid.Children.Add(right);
        return grid;
    }

    private static Microsoft.UI.Xaml.Shapes.Rectangle Rule(string brush = "LineBrush") =>
        new() { Height = 1, Fill = Palette.Resource(brush), VerticalAlignment = VerticalAlignment.Center };

    private static FrameworkElement NewConversationLine(string text)
    {
        var grid = new Grid { Margin = new Thickness(0, 18, 0, 10), ColumnSpacing = 14 };
        grid.ColumnDefinitions.Add(new ColumnDefinition());
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        grid.ColumnDefinitions.Add(new ColumnDefinition());
        grid.Children.Add(Rule());
        var label = Text(text, 12.5, "BrandBrush", semibold: true);
        Grid.SetColumn(label, 1);
        grid.Children.Add(label);
        var right = Rule();
        Grid.SetColumn(right, 2);
        grid.Children.Add(right);
        return grid;
    }

    private static FrameworkElement Pill(string text)
    {
        var t = Text(text, 12, "Text2Brush");
        t.TextAlignment = TextAlignment.Center;
        t.TextReadingOrder = TextReadingOrder.DetectFromContent;
        return new Border
        {
            HorizontalAlignment = HorizontalAlignment.Center,
            Margin = new Thickness(0, 8, 0, 8),
            Padding = new Thickness(12, 4, 12, 5),
            CornerRadius = new CornerRadius(12),
            Background = Palette.Resource("ElevatedBrush"),
            Child = t,
        };
    }

    private static FrameworkElement EndedLine(SupportConversation c, Strings s, DateTimeOffset now)
    {
        var sentence = SupportRules.EndedSentence(c.Status, s);
        var text = c.EndedAt is { } at ? $"{sentence} · {SupportRules.DayHeader(at, s, now)}" : sentence;
        var panel = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 6, HorizontalAlignment = HorizontalAlignment.Center, Margin = new Thickness(0, 18, 0, 6), FlowDirection = s.IsRightToLeft ? FlowDirection.RightToLeft : FlowDirection.LeftToRight };
        var resolved = c.Status != SupportConversation.StatusClosed;
        panel.Children.Add(new FontIcon { Glyph = resolved ? "" : "", FontSize = 13, Foreground = Palette.Resource(resolved ? "SuccessBrush" : "Text3Brush") });
        panel.Children.Add(Text(text, 12, "Text3Brush"));
        return panel;
    }

    // ── Bubbles ──

    private FrameworkElement Bubble(SupportRow row, Strings s)
    {
        var item = row.Item;
        var pending = row.Pending;
        var mine = row.Mine;
        var body = item?.Text ?? pending?.Body ?? string.Empty;
        var column = new StackPanel { Spacing = 4, MaxWidth = 520, HorizontalAlignment = mine ? HorizontalAlignment.Right : HorizontalAlignment.Left };

        // The agent's name over the first of their run: two people answering in turn are told apart by more than their faces.
        if (!mine && row.StartsRun && item?.SenderName is { Length: > 0 } name && !string.IsNullOrWhiteSpace(name))
        {
            var label = Text(name.Trim(), 11.5, "BrandBrush", semibold: true);
            label.Margin = new Thickness(4, 0, 4, 0);
            label.TextReadingOrder = TextReadingOrder.DetectFromContent;
            column.Children.Add(label);
        }

        foreach (var file in FilesOf(row, s)) column.Children.Add(FileView(file, mine, pending is not null));

        if (!string.IsNullOrWhiteSpace(body))
        {
            var text = new TextBlock
            {
                Text = body,
                FontSize = 14,
                LineHeight = 23,
                TextWrapping = TextWrapping.Wrap,
                IsTextSelectionEnabled = true,
                TextReadingOrder = TextReadingOrder.DetectFromContent,
                TextAlignment = TextAlignment.DetectFromContent,
                Foreground = Palette.Resource(mine ? "BubbleOutgoingTextBrush" : "TextBrush"),
            };
            var bubble = new Border
            {
                Padding = new Thickness(14, 9, 14, 10),
                HorizontalAlignment = mine ? HorizontalAlignment.Right : HorizontalAlignment.Left,
                Background = Palette.Resource(mine ? "BubbleOutgoingBrush" : "BubbleIncomingBrush"),
                CornerRadius = Corners(mine, row.StartsRun),
                Child = text,
            };
            if (!mine)
            {
                bubble.BorderBrush = Palette.Resource("BubbleIncomingBorderBrush");
                bubble.BorderThickness = new Thickness(1);
            }
            column.Children.Add(bubble);
        }

        if (Meta(row, s) is { } meta) column.Children.Add(meta);

        FrameworkElement result;
        if (mine)
        {
            column.Opacity = pending is { Failed: false } ? 0.72 : 1;
            result = column;
        }
        else
        {
            var grid = new Grid { ColumnSpacing = 10, HorizontalAlignment = HorizontalAlignment.Left };
            grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(32) });
            grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            if (row.EndsRun)
            {
                // The face at the foot of the run, as in every other transcript.
                grid.Children.Add(new Avatar
                {
                    Size = 32,
                    Kind = "operator",
                    DisplayName = item?.SenderName,
                    ImageUrl = item?.SenderAvatar,
                    VerticalAlignment = VerticalAlignment.Bottom,
                    Margin = new Thickness(0, 0, 0, 20),
                });
            }
            Grid.SetColumn(column, 1);
            grid.Children.Add(column);
            result = grid;
        }
        result.Margin = new Thickness(0, row.StartsRun ? 8 : 1, 0, 0);
        return result;
    }

    /// <summary>
    /// The tail on the sender's side, as in the other transcripts; inside a
    /// run the top corner on that side is tight too, where bubbles of one
    /// sender meet.
    /// </summary>
    private static CornerRadius Corners(bool mine, bool starts)
    {
        const double round = 18, tight = 6;
        var top = starts ? round : tight;
        return mine ? new CornerRadius(round, top, tight, round) : new CornerRadius(top, round, round, tight);
    }

    /// <summary>Under the last bubble of a run: the time; under one on its way, "sending" — or "not sent" and a retry.</summary>
    private FrameworkElement? Meta(SupportRow row, Strings s)
    {
        var pending = row.Pending;
        var line = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8, Margin = new Thickness(6, 0, 6, 4), HorizontalAlignment = row.Mine ? HorizontalAlignment.Right : HorizontalAlignment.Left };
        if (pending is null)
        {
            if (!row.EndsRun || row.Time is not { } at) return null;
            line.Children.Add(Text(Display.ClockTime(at, s.Language), 11, "Text3Brush"));
            return line;
        }
        if (!pending.Failed)
        {
            line.Children.Add(Text(s["sending"], 11, "Text3Brush"));
            return line;
        }
        line.Children.Add(new FontIcon { Glyph = "", FontSize = 12, Foreground = Palette.Resource("DangerBrush"), VerticalAlignment = VerticalAlignment.Center });
        line.Children.Add(Text(s["supportNotSent"], 11.5, "DangerBrush", semibold: true));
        var retry = new HyperlinkButton { Content = s["retry"], Padding = new Thickness(4, 0, 4, 0), FontSize = 11.5, Tag = pending.ClientMessageId, VerticalAlignment = VerticalAlignment.Center };
        retry.Click += (_, _) => _ = _chat.RetryAsync(pending.ClientMessageId);
        line.Children.Add(retry);
        return line;
    }

    private IEnumerable<AttachmentItem> FilesOf(SupportRow row, Strings s)
    {
        if (row.Item is { } item)
        {
            foreach (var a in item.Files)
            {
                if (!_files.TryGetValue(a.StoreId, out var file))
                {
                    file = new AttachmentItem(new MessageAttachment(a.StoreId, a.FileName, a.MimeType, a.SizeBytes > 0 ? a.SizeBytes : null, a.Kind), s);
                    _files[a.StoreId] = file;
                }
                yield return file;
            }
        }
        else if (row.Pending is { File: { } upload } pending)
        {
            var key = "pending:" + pending.ClientMessageId;
            if (!_files.TryGetValue(key, out var file))
            {
                file = new AttachmentItem(upload.FileName, upload.MimeType, upload.Data, s);
                _files[key] = file;
            }
            yield return file;
        }
    }

    /// <summary>A photo as itself (a skeleton until it is decoded); any other file as a card that opens it.</summary>
    private FrameworkElement FileView(AttachmentItem a, bool mine, bool pending)
    {
        if (a.IsImage)
        {
            var box = new Grid { Width = a.PreviewWidth, Height = a.PreviewHeight };
            box.Children.Add(new Border { Background = Palette.Resource("ElevatedBrush") });
            var image = new Image { Stretch = Stretch.UniformToFill, Source = a.Preview };
            box.Children.Add(image);
            void Update(object? sender, PropertyChangedEventArgs e)
            {
                box.Width = a.PreviewWidth;
                box.Height = a.PreviewHeight;
                image.Source = a.Preview;
            }
            a.PropertyChanged += Update;
            box.Unloaded += (_, _) => a.PropertyChanged -= Update;
            _ = a.LoadPreviewAsync();
            var frame = new Border { CornerRadius = new CornerRadius(16), BorderThickness = new Thickness(1), BorderBrush = Palette.Resource("BubbleIncomingBorderBrush"), Child = box };
            var button = new Button { Style = (Style)Application.Current.Resources["BubbleButtonStyle"], CornerRadius = new CornerRadius(16), Content = frame, HorizontalAlignment = mine ? HorizontalAlignment.Right : HorizontalAlignment.Left, IsEnabled = !pending };
            AutomationProperties.SetName(button, a.FileName);
            button.Click += (_, _) => Open(a);
            return button;
        }

        var card = new Grid { Width = 260, Padding = new Thickness(10), ColumnSpacing = 12 };
        card.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        card.ColumnDefinitions.Add(new ColumnDefinition());
        card.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        var tile = new Border { Width = 42, Height = 42, CornerRadius = new CornerRadius(11), Background = mine ? new SolidColorBrush(Windows.UI.Color.FromArgb(0x33, 0xFF, 0xFF, 0xFF)) : Palette.Resource("BrandSoftBrush") };
        tile.Child = new FontIcon { Glyph = a.Glyph, FontSize = 18, Foreground = mine ? new SolidColorBrush(Microsoft.UI.Colors.White) : Palette.Resource("BrandBrush") };
        card.Children.Add(tile);
        var names = new StackPanel { VerticalAlignment = VerticalAlignment.Center, Spacing = 2 };
        var fileName = Text(a.FileName, 13, mine ? "BubbleOutgoingTextBrush" : "TextBrush", semibold: true);
        fileName.TextTrimming = TextTrimming.CharacterEllipsis;
        names.Children.Add(fileName);
        names.Children.Add(Text(a.SizeText, 11.5, mine ? "BubbleOutgoingMetaBrush" : "Text3Brush"));
        Grid.SetColumn(names, 1);
        card.Children.Add(names);
        var arrow = new FontIcon { Glyph = "", FontSize = 14, VerticalAlignment = VerticalAlignment.Center, Foreground = mine ? new SolidColorBrush(Microsoft.UI.Colors.White) : Palette.Resource("Text2Brush"), Visibility = pending ? Visibility.Collapsed : Visibility.Visible };
        Grid.SetColumn(arrow, 2);
        card.Children.Add(arrow);
        var open = new Button
        {
            Style = (Style)Application.Current.Resources["BubbleButtonStyle"],
            CornerRadius = new CornerRadius(14),
            Background = Palette.Resource(mine ? "BubbleOutgoingBrush" : "BubbleIncomingBrush"),
            BorderBrush = Palette.Resource("BubbleIncomingBorderBrush"),
            BorderThickness = new Thickness(mine ? 0 : 1),
            HorizontalAlignment = mine ? HorizontalAlignment.Right : HorizontalAlignment.Left,
            IsEnabled = !pending,
            Content = card,
        };
        AutomationProperties.SetName(open, a.FileName);
        ToolTipService.SetToolTip(open, a.FileName);
        open.Click += (_, _) => Open(a);
        return open;
    }

    /// <summary>Opens a viewable file with whatever Windows opens it with; anything else is offered through "Save as".</summary>
    private async void Open(AttachmentItem a)
    {
        try
        {
            if (await OpenedFiles.OpenAsync(a) == OpenedFiles.Outcome.Saved) _chat.Report(OpenedFiles.SavedInsteadMessage(Host.Strings));
        }
        catch (Exception ex)
        {
            Log.Error("support open attachment", ex);
            _chat.Report(Host.Strings["attachmentFailed"]);
        }
    }

    // ── Rating ──

    /// <summary>
    /// Stars for an ended conversation the team answered: five to pick, a
    /// comment if the operator has one, and a button. Once rated, what they gave.
    /// </summary>
    private FrameworkElement RatingCard(SupportConversation c, Strings s)
    {
        var panel = new StackPanel { Spacing = 10, HorizontalAlignment = HorizontalAlignment.Stretch };
        var card = new Border
        {
            Margin = new Thickness(0, 8, 0, 8),
            Padding = new Thickness(20, 16, 20, 18),
            MaxWidth = 440,
            HorizontalAlignment = HorizontalAlignment.Center,
            CornerRadius = new CornerRadius(16),
            Background = Palette.Resource("SurfaceBrush"),
            BorderBrush = Palette.Resource("LineBrush"),
            BorderThickness = new Thickness(1),
            FlowDirection = s.IsRightToLeft ? FlowDirection.RightToLeft : FlowDirection.LeftToRight,
            Child = panel,
        };

        if (c.Rating is { } given)
        {
            panel.Children.Add(Centered(Text(s["supportYourRating"], 14, "TextBrush", semibold: true)));
            var stars = StarRow(given.Score, 22, null, s);
            AutomationProperties.SetName(stars, SupportRules.Stars(given.Score, s));
            panel.Children.Add(stars);
            if (!string.IsNullOrWhiteSpace(given.Comment))
            {
                var comment = Centered(Text(given.Comment.Trim(), 13, "Text2Brush"));
                comment.TextWrapping = TextWrapping.Wrap;
                comment.TextAlignment = TextAlignment.Center;
                comment.TextReadingOrder = TextReadingOrder.DetectFromContent;
                panel.Children.Add(comment);
            }
            return card;
        }

        var busy = _chat.RatingBusy.Contains(c.Id);
        panel.Children.Add(Centered(Text(s["supportRateTitle"], 14, "TextBrush", semibold: true)));
        var submit = new Button
        {
            Style = (Style)Application.Current.Resources["AccentButtonStyle"],
            HorizontalAlignment = HorizontalAlignment.Stretch,
            Content = busy ? s["sending"] : s["supportRateSubmit"],
        };
        var row = StarRow(_draftScores.GetValueOrDefault(c.Id), 26, score =>
        {
            _draftScores[c.Id] = score;
            submit.IsEnabled = !busy;
        }, s);
        panel.Children.Add(row);
        var box = new TextBox
        {
            PlaceholderText = s["supportRateComment"],
            Text = _draftComments.GetValueOrDefault(c.Id) ?? string.Empty,
            AcceptsReturn = true,
            TextWrapping = TextWrapping.Wrap,
            MinHeight = 64,
            MaxHeight = 140,
            MaxLength = SupportRules.MaxComment,
            TextReadingOrder = TextReadingOrder.DetectFromContent,
            IsEnabled = !busy,
        };
        box.TextChanged += (_, _) => _draftComments[c.Id] = box.Text;
        panel.Children.Add(box);
        submit.IsEnabled = !busy && _draftScores.GetValueOrDefault(c.Id) > 0;
        submit.Click += (_, _) =>
        {
            var score = _draftScores.GetValueOrDefault(c.Id);
            if (score > 0) _ = _chat.RateAsync(c.Id, score, box.Text);
        };
        panel.Children.Add(submit);
        return card;
    }

    /// <summary>
    /// Five stars. With <paramref name="pick"/> each is a button of its own,
    /// named by its count; without, they are the rating as given.
    /// </summary>
    private static FrameworkElement StarRow(int score, double size, Action<int>? pick, Strings s)
    {
        var row = new StackPanel { Orientation = Orientation.Horizontal, Spacing = pick is null ? 2 : 0, HorizontalAlignment = HorizontalAlignment.Center };
        var icons = new List<FontIcon>();
        void Paint(int value)
        {
            for (var i = 0; i < icons.Count; i++)
            {
                var filled = i < value;
                icons[i].Glyph = filled ? "" : "";
                icons[i].Foreground = filled ? StarGold : Palette.Resource("Text3Brush");
            }
        }
        for (var star = 1; star <= 5; star++)
        {
            var icon = new FontIcon { FontSize = size };
            icons.Add(icon);
            if (pick is null)
            {
                row.Children.Add(icon);
                continue;
            }
            var value = star;
            var button = new Button { Content = icon, Background = Palette.Transparent, BorderThickness = new Thickness(0), Padding = new Thickness(6), CornerRadius = new CornerRadius(8) };
            var label = SupportRules.Stars(value, s);
            AutomationProperties.SetName(button, label);
            ToolTipService.SetToolTip(button, label);
            button.Click += (_, _) =>
            {
                Paint(value);
                pick(value);
            };
            row.Children.Add(button);
        }
        Paint(score);
        return row;
    }

    // ── Closed conversations ──

    private void RenderClosedList(Strings s)
    {
        ComposerCard.Visibility = EndedPanel.Visibility = Visibility.Collapsed;
        switch (_chat.Phase)
        {
            case SupportPhase.Loading:
                ShowLayer(Skeleton);
                return;
            case SupportPhase.Failed:
                ShowState("", s["offlineTitle"], _chat.FailedMessage, retry: true);
                return;
        }
        var closed = _chat.Closed;
        if (closed.Count == 0)
        {
            ShowState("", s["supportClosedEmpty"], null, retry: false);
            return;
        }
        ShowLayer(ClosedScroll);
        ClosedList.Children.Clear();
        var now = DateTimeOffset.Now;
        foreach (var c in closed) ClosedList.Children.Add(ClosedRow(c, s, now));
    }

    private Button ClosedRow(SupportConversation c, Strings s, DateTimeOffset now, bool compact = false, bool selected = false)
    {
        var grid = new Grid { ColumnSpacing = compact ? 10 : 14, Padding = compact ? new Thickness(2) : new Thickness(6, 4, 6, 4) };
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        grid.ColumnDefinitions.Add(new ColumnDefinition());
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        var resolved = c.Status != SupportConversation.StatusClosed;
        var size = compact ? 34 : 40;
        var mark = new Border { Width = size, Height = size, CornerRadius = new CornerRadius(size / 2.0), Background = Palette.Resource(resolved ? "SuccessSoftBrush" : "ElevatedBrush"), VerticalAlignment = VerticalAlignment.Center };
        mark.Child = new FontIcon { Glyph = resolved ? "" : "", FontSize = compact ? 15 : 17, Foreground = Palette.Resource(resolved ? "SuccessBrush" : "Text2Brush") };
        grid.Children.Add(mark);
        var words = new StackPanel { VerticalAlignment = VerticalAlignment.Center, Spacing = 2 };
        var title = Text(SupportRules.ClosedTitle(_chat.Preview(c.Id), s), compact ? 13.5 : 14, "TextBrush", semibold: true);
        title.TextTrimming = TextTrimming.CharacterEllipsis;
        title.TextWrapping = TextWrapping.NoWrap;
        title.TextReadingOrder = TextReadingOrder.DetectFromContent;
        words.Children.Add(title);
        var subtitle = Text(SupportRules.ClosedSubtitle(c, s, now), compact ? 12 : 12.5, "Text2Brush");
        subtitle.TextTrimming = TextTrimming.CharacterEllipsis;
        subtitle.TextWrapping = TextWrapping.NoWrap;
        words.Children.Add(subtitle);
        Grid.SetColumn(words, 1);
        grid.Children.Add(words);
        FrameworkElement? trailing = null;
        if (c.Rating is { } given)
        {
            var stars = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 4, VerticalAlignment = VerticalAlignment.Center };
            stars.Children.Add(new FontIcon { Glyph = "", FontSize = 15, Foreground = StarGold });
            stars.Children.Add(Text(Digits.Localize(given.Score.ToString(System.Globalization.CultureInfo.InvariantCulture), s.Language), 13, "TextBrush", semibold: true));
            AutomationProperties.SetName(stars, SupportRules.Stars(given.Score, s));
            trailing = stars;
        }
        else if (c.CanRate)
        {
            trailing = new Border
            {
                Padding = new Thickness(10, 3, 10, 4),
                CornerRadius = new CornerRadius(10),
                Background = Palette.Resource("BrandSoftBrush"),
                VerticalAlignment = VerticalAlignment.Center,
                Child = Text(s["supportRateAction"], 12, "BrandBrush", semibold: true),
            };
        }
        if (trailing is not null)
        {
            Grid.SetColumn(trailing, 2);
            grid.Children.Add(trailing);
        }
        var button = new Button
        {
            Content = grid,
            HorizontalAlignment = HorizontalAlignment.Stretch,
            HorizontalContentAlignment = HorizontalAlignment.Stretch,
            Padding = compact ? new Thickness(8) : new Thickness(10, 10, 10, 10),
            CornerRadius = new CornerRadius(12),
            Background = Palette.Resource(selected ? "SelectedBrush" : "SurfaceBrush"),
            BorderBrush = Palette.Resource(selected ? "BrandBrush" : "LineBrush"),
            BorderThickness = new Thickness(1),
        };
        AutomationProperties.SetName(button, title.Text);
        button.Click += (_, _) => OpenClosed(c.Id);
        return button;
    }

    // ── The side column (wide page) ──

    /// <summary>
    /// The current conversation, then the closed ones newest first, the one on
    /// screen marked. Drawn again only when something in it changed, so a
    /// poll that changes nothing leaves the hover and focus where they are.
    /// </summary>
    private void RenderSide(Strings s)
    {
        if (!_wide) return;
        var closed = _chat.Phase == SupportPhase.Loaded ? _chat.Closed : [];
        var now = DateTimeOffset.Now;
        var signature = string.Join("|",
            _chat.Phase, _mode, _openClosedId, s.Language, _chat.Status?.Online, _chat.Composer, _chat.IsEmpty, now.Date,
            string.Join(";", closed.Select(c => $"{c.Id},{c.Status},{c.EndedAt},{c.CanRate},{c.Rating?.Score},{_chat.Preview(c.Id)}")));
        if (signature == _sideSignature) return;
        _sideSignature = signature;

        SideCount.Visibility = closed.Count > 0 ? Visibility.Visible : Visibility.Collapsed;
        SideCountText.Text = Digits.Localize(closed.Count.ToString(System.Globalization.CultureInfo.InvariantCulture), s.Language);
        SideList.Children.Clear();
        SideList.Children.Add(CurrentRow(s, selected: _mode != Mode.ClosedConversation));

        switch (_chat.Phase)
        {
            case SupportPhase.Loading:
                // Rows still on their way: their shape, never a spinner.
                for (var i = 0; i < 4; i++)
                    SideList.Children.Add(new Border { Height = 54, CornerRadius = new CornerRadius(12), Background = Palette.Resource("ElevatedBrush"), Opacity = 1 - i * 0.18 });
                return;
            case SupportPhase.Failed:
                return;
        }

        if (closed.Count == 0)
        {
            var empty = new StackPanel { Spacing = 8, Margin = new Thickness(12, 28, 12, 12), HorizontalAlignment = HorizontalAlignment.Center };
            var tile = new Border { Width = 52, Height = 52, CornerRadius = new CornerRadius(16), Background = Palette.Resource("ElevatedBrush"), HorizontalAlignment = HorizontalAlignment.Center };
            tile.Child = new FontIcon { Glyph = "", FontSize = 20, Foreground = Palette.Resource("Text3Brush") };
            empty.Children.Add(tile);
            empty.Children.Add(Centered(Text(s["supportClosedEmpty"], 13, "Text2Brush", semibold: true)));
            empty.Children.Add(Centered(Text(s["supportClosedColumnEmpty"], 12, "Text3Brush")));
            SideList.Children.Add(empty);
            return;
        }

        var label = Text(s["supportClosedTitle"], 11.5, "Text3Brush", semibold: true);
        label.Margin = new Thickness(6, 10, 6, 2);
        SideList.Children.Add(label);
        foreach (var c in closed)
            SideList.Children.Add(ClosedRow(c, s, now, compact: true, selected: _mode == Mode.ClosedConversation && _openClosedId == c.Id));
    }

    /// <summary>The conversation being written in (or the fresh page): the way back to it from a closed one.</summary>
    private Button CurrentRow(Strings s, bool selected)
    {
        var grid = new Grid { ColumnSpacing = 10, Padding = new Thickness(2) };
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        grid.ColumnDefinitions.Add(new ColumnDefinition());
        var mark = new Grid { Width = 34, Height = 34, VerticalAlignment = VerticalAlignment.Center };
        mark.Children.Add(new Border { CornerRadius = new CornerRadius(17), Background = Palette.Resource("BrandSoftBrush"), Child = new FontIcon { Glyph = "", FontSize = 15, Foreground = Palette.Resource("BrandBrush") } });
        if (_chat.Status is { } status)
        {
            mark.Children.Add(new Microsoft.UI.Xaml.Shapes.Ellipse
            {
                Width = 11,
                Height = 11,
                HorizontalAlignment = HorizontalAlignment.Right,
                VerticalAlignment = VerticalAlignment.Bottom,
                StrokeThickness = 2,
                Stroke = Palette.Resource(selected ? "SelectedBrush" : "SurfaceBrush"),
                Fill = Palette.Resource(status.Online ? "SuccessBrush" : "Text3Brush"),
            });
        }
        grid.Children.Add(mark);
        var words = new StackPanel { VerticalAlignment = VerticalAlignment.Center, Spacing = 2 };
        var title = Text(s["supportCurrentConversation"], 13.5, "TextBrush", semibold: true);
        title.TextWrapping = TextWrapping.NoWrap;
        title.TextTrimming = TextTrimming.CharacterEllipsis;
        words.Children.Add(title);
        var line = _chat.Phase != SupportPhase.Loaded ? string.Empty
            : _chat.Composer == SupportComposer.Ended ? SupportRules.EndedSentence(_chat.Shown?.Status == SupportConversation.StatusClosed ? SupportConversation.StatusClosed : SupportConversation.StatusResolved, s)
            : _chat.IsEmpty ? s["supportNewConversation"]
            : _chat.Status is { } st ? SupportRules.Presence(st.Online, s)
            : string.Empty;
        if (line.Length > 0)
        {
            var sub = Text(line, 12, "Text2Brush");
            sub.TextWrapping = TextWrapping.NoWrap;
            sub.TextTrimming = TextTrimming.CharacterEllipsis;
            words.Children.Add(sub);
        }
        Grid.SetColumn(words, 1);
        grid.Children.Add(words);
        var button = new Button
        {
            Content = grid,
            HorizontalAlignment = HorizontalAlignment.Stretch,
            HorizontalContentAlignment = HorizontalAlignment.Stretch,
            Padding = new Thickness(8),
            CornerRadius = new CornerRadius(12),
            Background = Palette.Resource(selected ? "SelectedBrush" : "SurfaceBrush"),
            BorderBrush = Palette.Resource(selected ? "BrandBrush" : "LineBrush"),
            BorderThickness = new Thickness(1),
        };
        AutomationProperties.SetName(button, s["supportCurrentConversation"]);
        button.Click += (_, _) =>
        {
            if (_mode != Mode.Chat) SetMode(Mode.Chat);
        };
        return button;
    }

    private void OnBackToCurrent(object sender, RoutedEventArgs e) => SetMode(Mode.Chat);


    private void OpenClosed(string id)
    {
        _openClosedId = id;
        SetMode(Mode.ClosedConversation);
    }

    private void SetMode(Mode mode)
    {
        _mode = mode;
        _rows.Clear();
        _rowOrder.Clear();
        Transcript.Children.Clear();
        _stickToBottom = true;
        Render();
        if (mode == Mode.Chat && _chat.Composer != SupportComposer.Ended) Composer.Focus(FocusState.Programmatic);
    }

    private void OnOpenClosed(object sender, RoutedEventArgs e) => SetMode(Mode.ClosedList);

    private void OnBack(object sender, RoutedEventArgs e)
    {
        switch (_mode)
        {
            case Mode.ClosedConversation:
                // Beside the column, back is the current conversation; on a narrow page, the list it came from.
                SetMode(_wide ? Mode.Chat : Mode.ClosedList);
                break;
            case Mode.ClosedList:
                SetMode(Mode.Chat);
                break;
            default:
                if (Frame.CanGoBack) Frame.GoBack();
                else Frame.Navigate(typeof(SettingsPage));
                break;
        }
    }

    private void OnRetryLoad(object sender, RoutedEventArgs e) => _chat.Retry();

    private void OnStartNew(object sender, RoutedEventArgs e)
    {
        _chat.StartNewConversation();
        Composer.Focus(FocusState.Programmatic);
    }

    // ── Composer ──

    private void OnComposerFocus(object sender, RoutedEventArgs e) =>
        ComposerCard.BorderBrush = Palette.Resource(Composer.FocusState != FocusState.Unfocused ? "ComposerFocusBrush" : "ComposerBorderBrush");

    private void OnComposerChanged(object sender, TextChangedEventArgs e)
    {
        _chat.SetDraft(Composer.Text);
        UpdateSendEnabled();
        var s = Host.Strings;
        // Near the server's limit, how much is left — not a refusal after the fact.
        var length = Composer.Text.Length;
        ComposerHint.Text = length > SupportRules.MaxBody - 400
            ? Digits.Localize($"{length}/{SupportRules.MaxBody}", s.Language)
            : s["composerHint"];
    }

    private void UpdateSendEnabled() => SendButton.IsEnabled = Composer.Text.Trim().Length > 0 && _chat.Phase == SupportPhase.Loaded;

    private void OnComposerKeyDown(object sender, KeyRoutedEventArgs e)
    {
        if (e.Key != VirtualKey.Enter) return;
        if (InputKeyboardSource.GetKeyStateForCurrentThread(VirtualKey.Shift).HasFlag(CoreVirtualKeyStates.Down)) return;
        e.Handled = true;
        Send();
    }

    private void OnSend(object sender, RoutedEventArgs e) => Send();

    private void Send()
    {
        _chat.SetDraft(Composer.Text);
        _stickToBottom = true;
        _ = _chat.SendAsync();
        Composer.Focus(FocusState.Programmatic);
    }

    private async void OnAttach(object sender, RoutedEventArgs e)
    {
        try
        {
            var picker = new Windows.Storage.Pickers.FileOpenPicker();
            // Only what the support endpoint takes: pictures, PDF and text.
            foreach (var ext in SupportRules.PickableExtensions) picker.FileTypeFilter.Add(ext);
            WinRT.Interop.InitializeWithWindow.Initialize(picker, WinRT.Interop.WindowNative.GetWindowHandle(App.Current.Window!));
            var file = await picker.PickSingleFileAsync();
            if (file is not null) await SendFileAsync(file);
        }
        catch (Exception ex)
        {
            Log.Error("support pick file", ex);
            _chat.Report(Host.Strings["attachmentFailed"]);
        }
    }

    /// <summary>A file from the picker or dropped on the chat: refused before reading it when it is too big or not a type the team takes.</summary>
    private async Task SendFileAsync(Windows.Storage.StorageFile file)
    {
        var s = Host.Strings;
        var mime = SupportRules.CanonicalMime(file.Name, file.ContentType);
        var props = await file.GetBasicPropertiesAsync();
        if (mime is null)
        {
            _chat.Report(s["supportFileTypeNotAllowed"]);
            return;
        }
        if ((long)props.Size > SupportRules.MaxFileBytes)
        {
            _chat.Report(s["supportFileTooLarge"]);
            return;
        }
        var buffer = await Windows.Storage.FileIO.ReadBufferAsync(file);
        var data = new byte[buffer.Length];
        using (var reader = Windows.Storage.Streams.DataReader.FromBuffer(buffer)) reader.ReadBytes(data);
        _stickToBottom = true;
        await _chat.SendFileAsync(data, file.Name, mime);
    }

    private bool CanDrop => _mode == Mode.Chat && _chat.Phase == SupportPhase.Loaded && _chat.Composer != SupportComposer.Ended;

    private void OnBodyDragOver(object sender, DragEventArgs e)
    {
        if (!CanDrop || !e.DataView.Contains(StandardDataFormats.StorageItems)) return;
        e.AcceptedOperation = DataPackageOperation.Copy;
        e.DragUIOverride.Caption = Host.Strings["supportAttachHint"];
    }

    private async void OnBodyDrop(object sender, DragEventArgs e)
    {
        if (!CanDrop || !e.DataView.Contains(StandardDataFormats.StorageItems)) return;
        try
        {
            var items = await e.DataView.GetStorageItemsAsync();
            foreach (var file in items.OfType<Windows.Storage.StorageFile>()) await SendFileAsync(file);
        }
        catch (Exception ex)
        {
            Log.Error("support drop file", ex);
            _chat.Report(Host.Strings["attachmentFailed"]);
        }
    }

    // ── Pieces ──

    /// <summary>The chat while it loads: bubble-shaped skeletons on both sides, never a spinner.</summary>
    private void BuildSkeleton()
    {
        Skeleton.Children.Clear();
        var shapes = new (bool Mine, double Width, double Height)[] { (false, 260, 40), (false, 190, 40), (true, 230, 40), (false, 300, 58), (true, 160, 40) };
        foreach (var (mine, width, height) in shapes)
        {
            var row = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 10, HorizontalAlignment = mine ? HorizontalAlignment.Right : HorizontalAlignment.Left };
            if (!mine) row.Children.Add(new Microsoft.UI.Xaml.Shapes.Ellipse { Width = 32, Height = 32, Fill = Palette.Resource("ElevatedBrush"), VerticalAlignment = VerticalAlignment.Bottom });
            row.Children.Add(new Border { Width = width, Height = height, CornerRadius = new CornerRadius(18), Background = Palette.Resource("ElevatedBrush"), Opacity = mine ? 0.8 : 1 });
            Skeleton.Children.Add(row);
        }
    }

    private static TextBlock Text(string text, double size, string brush, bool semibold = false) => new()
    {
        Text = text,
        FontSize = size,
        Foreground = Palette.Resource(brush),
        FontWeight = semibold ? Microsoft.UI.Text.FontWeights.SemiBold : Microsoft.UI.Text.FontWeights.Normal,
        TextWrapping = TextWrapping.Wrap,
        VerticalAlignment = VerticalAlignment.Center,
    };

    private static TextBlock Centered(TextBlock t)
    {
        t.HorizontalAlignment = HorizontalAlignment.Center;
        t.TextAlignment = TextAlignment.Center;
        return t;
    }
}
