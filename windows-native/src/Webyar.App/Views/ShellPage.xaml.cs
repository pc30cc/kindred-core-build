using System.ComponentModel;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Controls.Primitives;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Navigation;
using Microsoft.Windows.AppNotifications;
using Webyar.App.Helpers;
using Webyar.App.Services;
using Webyar.Core.Api;
using Webyar.Core.Inbox;
using Webyar.Core.Localization;

namespace Webyar.App.Views;

/// <summary>The signed-in frame: the navigation rail, the banners, and the page on show.</summary>
public sealed partial class ShellPage : Page
{
    private BackgroundNotifier? _notifier;
    private string? _pendingConversation;
    private QueueEntry? _ringing;
    private DateTimeOffset _ringSince;
    private Microsoft.UI.Dispatching.DispatcherQueueTimer? _ringTimer;

    /// <summary>How long the banner keeps chiming; the server treats a 45 s ring as missed.</summary>
    private static readonly TimeSpan RingFor = TimeSpan.FromSeconds(45);

    public ShellPage()
    {
        InitializeComponent();
        NavigationCacheMode = NavigationCacheMode.Disabled;
        ContentFrame.Navigated += (_, _) => SyncSelection();
        // The settings item only exists once the template is applied.
        Nav.Loaded += (_, _) => { if (Nav.SettingsItem is NavigationViewItem settings) settings.Content = Host.Strings["tabSettings"]; };
    }

    private static AppHost Host => App.Current.Host;

    public InboxPage? Inbox => ContentFrame.Content as InboxPage;

    protected override void OnNavigatedTo(NavigationEventArgs e)
    {
        base.OnNavigatedTo(e);
        Host.LanguageChanged += OnLanguageChanged;
        Host.Updates.PropertyChanged += OnUpdateChanged;
        Host.MeChanged += RenderMe;
        if (Host.CallQueue is { } q)
        {
            q.Changed += ShowCallsBadge;
            q.Ringing += OnRinging;
        }
        ApplyLanguage();
        ShowCallsBadge();
        ShowUpdate();
        CheckWindowsNotifications();

        Host.PlanChanged += ApplyPlan;
        ApplyPlan();
        Host.Engagement.Changed += RenderAnnouncements;
        Host.Engagement.Broadcast += OnBroadcast;
        RenderAnnouncements();
        StartInboxSidebar();
        if (Host.Workspace is { } ws)
        {
            _notifier = new BackgroundNotifier(Host, ws.Id) { VisibleConversation = () => Inbox?.OpenConversationId };
            _notifier.UnreadChanged += SetUnread;
            _notifier.Start();
        }
        // Webyar.exe --page=contacts|visitors|analytics|calls|settings opens straight on that section.
        var page = Environment.GetCommandLineArgs().FirstOrDefault(a => a.StartsWith("--page=", StringComparison.Ordinal))?[7..];
        OpenPage(page);
    }

    protected override void OnNavigatedFrom(NavigationEventArgs e)
    {
        base.OnNavigatedFrom(e);
        Teardown();
    }

    /// <summary>Stops everything this page started; the window calls it on sign-out.</summary>
    public void Teardown()
    {
        Host.LanguageChanged -= OnLanguageChanged;
        Host.Updates.PropertyChanged -= OnUpdateChanged;
        _notifier?.Dispose();
        _notifier = null;
        _countsPoller?.Dispose();
        _countsPoller = null;
        _planPoller?.Dispose();
        _planPoller = null;
        Host.PlanChanged -= ApplyPlan;
        Host.Engagement.Changed -= RenderAnnouncements;
        Host.Engagement.Broadcast -= OnBroadcast;
        Host.MeChanged -= RenderMe;
        if (Host.CallQueue is { } q)
        {
            q.Changed -= ShowCallsBadge;
            q.Ringing -= OnRinging;
        }
        StopRinging();
        Inbox?.Teardown();
    }

    public void OpenConversation(string id)
    {
        if (Inbox is { } inbox)
        {
            inbox.Open(id);
            return;
        }
        _pendingConversation = id;
        Nav.SelectedItem = InboxOpenItem;
    }

    /// <summary>Shows a section by its tag: inbox, contacts, visitors, analytics, calls or settings.</summary>
    public void OpenPage(string? tag)
    {
        // The settings item only exists once the pane's template is applied.
        if (tag == "settings" && Nav.SettingsItem is null)
        {
            Nav.Loaded += OpenSettingsWhenLoaded;
            return;
        }
        Nav.SelectedItem = tag switch
        {
            "contacts" => ContactsItem,
            "visitors" => VisitorsItem,
            "analytics" => AnalyticsItem,
            "calls" => CallCenterItem,
            "colleagues" => ColleaguesItem,
            "email" => EmailItem,
            "settings" => Nav.SettingsItem ?? InboxOpenItem,
            _ => InboxOpenItem,
        };
    }

    private void OpenSettingsWhenLoaded(object sender, RoutedEventArgs e)
    {
        Nav.Loaded -= OpenSettingsWhenLoaded;
        DispatcherQueue.TryEnqueue(() => OpenPage("settings"));
    }

    private void OnNavigate(NavigationView sender, NavigationViewSelectionChangedEventArgs args)
    {
        var tag = args.IsSettingsSelected ? "settings" : (args.SelectedItem as NavigationViewItem)?.Tag as string ?? "inbox";
        // A toast, a --page= launch or a stale selection can point at a section
        // the plan does not include: it never opens, the inbox does instead.
        if (!Allowed(tag))
        {
            Nav.SelectedItem = InboxOpenItem;
            return;
        }
        var page = tag switch
        {
            "settings" => typeof(SettingsPage),
            "contacts" => typeof(ContactsPage),
            "visitors" => typeof(VisitorsPage),
            "analytics" => typeof(AnalyticsPage),
            "calls" => typeof(CallCenterPage),
            "colleagues" => typeof(ColleaguesPage),
            "email" => typeof(EmailPage),
            _ => typeof(InboxPage),
        };
        if (ContentFrame.Content?.GetType() != page)
        {
            Inbox?.Teardown();
            ContentFrame.Navigate(page, page == typeof(InboxPage) ? _pendingConversation : null);
            if (page == typeof(InboxPage)) _pendingConversation = null;
        }
        if (Inbox is { } inbox) ShowInbox(inbox, tag);
    }

    /// <summary>Points the inbox page at the queue or channel a pane item stands for.</summary>
    private void ShowInbox(InboxPage inbox, string tag)
    {
        var s = Host.Strings;
        if (tag.StartsWith("channel/", StringComparison.Ordinal))
        {
            var channel = tag[8..];
            inbox.ShowInbox(InboxFilter.Open, channel, ChannelLabel(channel, s));
            return;
        }
        var filter = tag.StartsWith("inbox/", StringComparison.Ordinal) && Enum.TryParse<InboxFilter>(tag[6..], out var f) ? f : InboxFilter.Open;
        inbox.ShowInbox(filter, null, s[InboxTitleKey(filter)]);
    }

    private static string InboxTitleKey(InboxFilter f) => f switch
    {
        InboxFilter.Ai => "navInboxAi",
        InboxFilter.NeedsHuman => "navInboxNeedsHuman",
        InboxFilter.Pending => "navInboxPending",
        InboxFilter.Resolved => "navInboxResolved",
        InboxFilter.Spam => "navInboxSpam",
        _ => "navInboxOpen",
    };

    /// <summary>The web's channelLabel (ChannelBadge.tsx): brand names as they are, the widget translated.</summary>
    private static string ChannelLabel(string key, Strings s) => key switch
    {
        "telegram" => "Telegram",
        "bale" => "بله",
        "whatsapp" => "WhatsApp",
        "instagram" => "Instagram",
        "x" => "X (Twitter)",
        "email" => "Email",
        "phone" => "Phone",
        "widget" => s["channelWidget"],
        _ => key,
    };

    private static string ChannelGlyph(string key) => key switch
    {
        "telegram" or "bale" => "\uE724",
        "whatsapp" => "\uE8BD",
        "instagram" => "\uE722",
        "email" => "\uE715",
        "phone" => "\uE717",
        "x" => "\uE8F2",
        _ => "\uE8F2",
    };

    // ── Inbox badges and channel inboxes ──

    private Poller? _countsPoller;
    private bool _channelsLoaded;

    private void StartInboxSidebar()
    {
        if (Host.Workspace is not { } ws) return;
        _countsPoller = new Poller("sidebar counts", ct => LoadSidebarAsync(ws.Id, ct), () => TimeSpan.FromSeconds(15));
        _countsPoller.Start();
        // The super admin can change the plan at any time; pick it up without a restart.
        _planPoller = new Poller("plan", async ct =>
        {
            // An unreadable plan hides every gated section, so it is asked for
            // again soon; a good one is refreshed every few minutes.
            await Task.Delay(Host.Plan.State == PlanState.Failed ? TimeSpan.FromSeconds(20) : TimeSpan.FromMinutes(3), ct);
            await Host.LoadPlanAsync(ct);
        }, () => TimeSpan.Zero);
        _planPoller.Start();
    }

    private Poller? _planPoller;
    private int? _automated;
    private IReadOnlyList<string> _channels = [];

    /// <summary>
    /// Shows exactly the sections the plan (and role) allows, as the web
    /// sidebar does; if the page on show just went away, back to the inbox.
    /// </summary>
    private void ApplyPlan()
    {
        var plan = Host.Plan;
        static Visibility V(bool on) => on ? Visibility.Visible : Visibility.Collapsed;
        ContactsItem.Visibility = V(plan.Contacts);
        VisitorsItem.Visibility = V(plan.Visitors);
        AnalyticsItem.Visibility = V(plan.WebAnalytics);
        CallCenterItem.Visibility = V(plan.CallCenter);
        EmailItem.Visibility = V(plan.EmailInbox);
        InboxAiItem.Visibility = V(plan.AiQueue(_automated));
        InboxNeedsHumanItem.Visibility = V(plan.NeedsHumanQueue);
        InternalInboxItem.Visibility = V(plan.TeamChat);
        foreach (var item in OtherInboxesItem.MenuItems.OfType<NavigationViewItem>())
        {
            if (item.Tag is string t && t.StartsWith("channel/", StringComparison.Ordinal)) item.Visibility = V(plan.ChannelInPlan(t[8..]));
        }
        OtherInboxesItem.Visibility = V(plan.IsAdmin && _channels.Any(plan.ChannelInPlan));
        // A plan change may add or remove channel inboxes: ask the server again (it applies the plan).
        if (plan.State != PlanState.Loading && !ReferenceEquals(plan, _channelsPlan))
        {
            _channelsPlan = plan;
            _channelsLoaded = false;
            _countsPoller?.Kick();
        }
        if (Nav.SelectedItem is NavigationViewItem selected)
        {
            var tag = selected.Tag as string ?? string.Empty;
            var gone = selected.Visibility == Visibility.Collapsed || !Allowed(tag);
            if (gone) Nav.SelectedItem = InboxOpenItem;
        }
        RenderWorkspaces();
    }

    private WorkspacePlan? _channelsPlan;

    /// <summary>
    /// Whether the plan (and the operator's role) includes the section a pane
    /// tag stands for — the same rules that show or hide its item. While the
    /// plan is still loading nothing is refused here; the rail hides gated
    /// items, and the plan's arrival takes the operator out of a section it excludes.
    /// </summary>
    private bool Allowed(string tag)
    {
        var plan = Host.Plan;
        if (plan.State == PlanState.Loading) return true;
        if (tag.StartsWith("channel/", StringComparison.Ordinal))
        {
            var key = tag[8..];
            return plan.IsAdmin && plan.ChannelInPlan(key) && _channels.Contains(key);
        }
        return tag switch
        {
            "contacts" => plan.Contacts,
            "visitors" => plan.Visitors,
            "analytics" => plan.WebAnalytics,
            "calls" => plan.CallCenter,
            "colleagues" => plan.TeamChat,
            "email" => plan.EmailInbox,
            "inbox/Ai" => plan.AiQueue(_automated),
            "inbox/NeedsHuman" => plan.NeedsHumanQueue,
            _ => true,
        };
    }

    // ── Super Admin announcements and broadcasts ──

    private readonly List<InfoBar> _broadcastBars = [];

    private static InfoBarSeverity SeverityOf(string? s) => s switch
    {
        "success" => InfoBarSeverity.Success,
        "warning" => InfoBarSeverity.Warning,
        "critical" => InfoBarSeverity.Error,
        _ => InfoBarSeverity.Informational,
    };

    private static Button? LinkButton(string? url, string? label, string fallback)
    {
        if (url is not { Length: > 0 } || !Uri.TryCreate(url, UriKind.Absolute, out var uri) || uri.Scheme != Uri.UriSchemeHttps) return null;
        var b = new Button { Content = label is { Length: > 0 } ? label : fallback, CornerRadius = new CornerRadius(8) };
        b.Click += async (_, _) => await Windows.System.Launcher.LaunchUriAsync(uri);
        return b;
    }

    /// <summary>Announcements for this workspace's plan, in the strip under the title bar.</summary>
    private void RenderAnnouncements()
    {
        var s = Host.Strings;
        Announcements.Children.Clear();
        foreach (var a in Host.Engagement.Announcements)
        {
            var bar = new InfoBar
            {
                Title = a.Title ?? string.Empty,
                Message = a.Body ?? string.Empty,
                Severity = SeverityOf(a.Severity),
                IsClosable = a.Dismissible,
                IsOpen = true,
                CornerRadius = new CornerRadius(12),
            };
            if (LinkButton(a.CtaUrl, a.CtaLabel, s["adLearnMore"]) is { } link) bar.ActionButton = link;
            var campaign = a;
            bar.Closed += (_, _) => Host.Engagement.Dismiss(campaign);
            Announcements.Children.Add(bar);
        }
        foreach (var b in _broadcastBars) Announcements.Children.Add(b);
        Announcements.Visibility = Announcements.Children.Count > 0 ? Visibility.Visible : Visibility.Collapsed;
    }

    /// <summary>A notice Super Admin sent to every open app: a Windows toast and a banner.</summary>
    private void OnBroadcast(Core.Api.DesktopBroadcast b)
    {
        var s = Host.Strings;
        var bar = new InfoBar
        {
            Title = b.Title,
            Message = b.Body ?? string.Empty,
            Severity = SeverityOf(b.Severity),
            IsClosable = true,
            IsOpen = true,
            CornerRadius = new CornerRadius(12),
        };
        if (LinkButton(b.Url, null, s["adLearnMore"]) is { } link) bar.ActionButton = link;
        bar.Closed += (_, _) =>
        {
            _broadcastBars.Remove(bar);
            RenderAnnouncements();
        };
        _broadcastBars.Add(bar);
        if (_broadcastBars.Count > 3) _broadcastBars.RemoveAt(0);
        RenderAnnouncements();
        if (Host.Settings.Notifications)
            Host.Notifier.Show(b.Title, b.Body ?? string.Empty, s.IsRightToLeft, silent: !Host.Settings.NotificationSound, new Dictionary<string, string>());
    }

    /// <summary>The workspaces came back from the server after a launch from the PC's copy.</summary>
    public void RefreshWorkspaces()
    {
        RenderWorkspaces();
        BuildAccountMenu();
    }

    /// <summary>The workspace header: name and logo, and the others to switch to.</summary>
    private void RenderWorkspaces()
    {
        var s = Host.Strings;
        var current = Host.Workspace;
        WorkspaceName.Text = current?.Name is { Length: > 0 } wn ? wn : s["appName"];
        WorkspaceLogo.ImageSource = new Microsoft.UI.Xaml.Media.Imaging.BitmapImage(
            current?.LogoUrl is { } logo && logo.StartsWith("https://", StringComparison.OrdinalIgnoreCase) ? new Uri(logo) : new Uri(AppPaths.Icon));
        // Always clickable: the list is fetched again each time it opens, so a
        // workspace joined elsewhere (on the web, by an invitation) shows up here.
        var many = Host.Workspaces.Count > 1;
        WorkspaceButton.IsEnabled = true;
        WorkspaceChevron.Visibility = Visibility.Visible;
        ToolTipService.SetToolTip(WorkspaceButton, s["switchWorkspace"]);
        WorkspaceMenu.Items.Clear();
        WorkspaceMenu.Items.Add(new MenuFlyoutItem { Text = s["switchWorkspace"], IsEnabled = false });
        foreach (var w in Host.Workspaces)
        {
            var item = new RadioMenuFlyoutItem
            {
                Text = w.Name is { Length: > 0 } n ? n : w.Slug ?? w.Id,
                GroupName = "workspace",
                IsChecked = w.Id == current?.Id,
            };
            var target = w;
            item.Click += async (_, _) =>
            {
                if (target.Id == Host.Workspace?.Id || App.Current.Window is not { } window) return;
                await window.SwitchWorkspaceAsync(target);
            };
            WorkspaceMenu.Items.Add(item);
        }
        if (!many && current is not null && Host.Workspaces.Count == 0)
            WorkspaceMenu.Items.Add(new RadioMenuFlyoutItem { Text = WorkspaceName.Text, GroupName = "workspace", IsChecked = true });
    }

    private bool _refreshingWorkspaces;

    /// <summary>Opening the workspace menu: bring the list up to date while it shows.</summary>
    private async void OnWorkspaceMenuOpening(object? sender, object e)
    {
        if (_refreshingWorkspaces) return;
        _refreshingWorkspaces = true;
        try
        {
            var fresh = await Host.Api.WorkspacesAsync();
            Log.Write($"workspaces: {fresh.Count}");
            if (fresh.Count > 0 && !fresh.Select(w => w.Id).SequenceEqual(Host.Workspaces.Select(w => w.Id)))
            {
                Host.Workspaces = fresh;
                RenderWorkspaces();
                BuildAccountMenu();
            }
        }
        catch (Exception ex)
        {
            Log.Error("workspaces", ex);
        }
        finally
        {
            _refreshingWorkspaces = false;
        }
    }

    private async Task LoadSidebarAsync(string workspaceId, CancellationToken ct)
    {
        var counts = await Host.Api.SidebarCountsAsync(workspaceId, "mine", ct);
        if (_automated != counts.Automated)
        {
            _automated = counts.Automated;
            InboxAiItem.Visibility = Host.Plan.AiQueue(_automated) ? Visibility.Visible : Visibility.Collapsed;
        }
        Badge(AiBadge, counts.Automated);
        Badge(NeedsHumanBadge, counts.NeedsHuman);
        Badge(SpamBadge, counts.Spam);
        // "Other inboxes" is for owners and admins only, as on the web.
        if (_channelsLoaded || !Host.Plan.IsAdmin) return;
        try
        {
            // Installed inbox plugins the plan still allows (the server's planAllowed).
            ShowChannels(await Host.Api.PluginInboxesAsync(workspaceId, ct));
            _channelsLoaded = true;
        }
        catch (ApiException e) when (e.Status is 401 or 403 or 404)
        {
            // Owners and admins only, as on the web: everyone else simply has no "Other inboxes".
        }
    }

    private static void Badge(InfoBadge badge, int? n)
    {
        badge.Value = n ?? 0;
        badge.Visibility = n is > 0 ? Visibility.Visible : Visibility.Collapsed;
    }

    private void ShowChannels(IReadOnlyList<string> keys)
    {
        var s = Host.Strings;
        if (keys.SequenceEqual(_channels) && OtherInboxesItem.MenuItems.Count == keys.Count)
        {
            ApplyPlan();
            return;
        }
        OtherInboxesItem.MenuItems.Clear();
        foreach (var key in keys)
        {
            OtherInboxesItem.MenuItems.Add(new NavigationViewItem
            {
                Content = ChannelLabel(key, s),
                Tag = "channel/" + key,
                Icon = new FontIcon { Glyph = ChannelGlyph(key) },
            });
        }
        _channels = keys;
        // Each channel's item and the group follow the plan; a channel inbox on
        // show that the plan dropped sends the operator back to the inbox.
        ApplyPlan();
    }

    private void SyncSelection()
    {
        // Any inbox, queue or channel item stays selected while the inbox page shows it.
        if (ContentFrame.Content is InboxPage && Nav.SelectedItem is NavigationViewItem { Tag: string t } && (t == "inbox" || t.StartsWith("inbox/", StringComparison.Ordinal) || t.StartsWith("channel/", StringComparison.Ordinal))) return;
        object want = ContentFrame.Content switch
        {
            SettingsPage => Nav.SettingsItem,
            ContactsPage => ContactsItem,
            VisitorsPage => VisitorsItem,
            AnalyticsPage => AnalyticsItem,
            CallCenterPage => CallCenterItem,
            ColleaguesPage => ColleaguesItem,
            EmailPage => EmailItem,
            _ => InboxOpenItem,
        };
        if (!ReferenceEquals(Nav.SelectedItem, want)) Nav.SelectedItem = want;
    }

    private void ShowCallsBadge()
    {
        var n = Host.CallQueue?.Queue.Count ?? 0;
        CallsBadge.Value = n;
        CallsBadge.Visibility = n > 0 ? Visibility.Visible : Visibility.Collapsed;
        // The caller hung up, or a colleague answered: the banner goes with the call.
        if (_ringing is { } r && Host.CallQueue?.Queue.Any(e => e.CallSessionId == r.CallSessionId) != true)
        {
            StopRinging();
            RingNext();
        }
    }

    // ── Incoming call banner ──

    private void OnRinging(QueueEntry entry)
    {
        if (_ringing is not null) return;
        Ring(entry);
    }

    /// <summary>After one call leaves the line, rings the next one that is still new enough to ring.</summary>
    private void RingNext()
    {
        var now = DateTimeOffset.Now;
        var next = Host.CallQueue?.Queue.FirstOrDefault(e => e.CreatedAt is { } at && now - at < RingFor);
        if (next is not null) Ring(next);
    }

    private void Ring(QueueEntry entry)
    {
        var s = Host.Strings;
        _ringing = entry;
        _ringSince = DateTimeOffset.Now;
        var c = entry.CallSession;
        CallBarTitle.Text = s[entry.IsVideo ? "incomingVideoCall" : "incomingVoiceCall"];
        CallBarGlyph.Glyph = entry.IsVideo ? "\uE714" : "\uE717";
        CallBarName.Text = CallNames.Caller(entry, s);
        var meta = new[] { c?.VisitorPhone, c?.VisitorEmail, c?.PageTitle }.Where(x => !string.IsNullOrWhiteSpace(x)).Distinct();
        CallBarMeta.Text = string.Join(" · ", meta);
        CallBarMeta.Visibility = CallBarMeta.Text.Length > 0 ? Visibility.Visible : Visibility.Collapsed;
        CallBarAvatar.DisplayName = c?.VisitorName;
        CallBarAvatar.Email = c?.VisitorEmail;
        CallBarAnswerText.Text = s["callAnswer"];
        CallBarRejectText.Text = s["ccReject"];
        CallBarOpen.Content = s["callOpenDesk"];
        CallBarAnswer.IsEnabled = CallBarReject.IsEnabled = true;
        CallBar.Visibility = Visibility.Visible;

        if (Host.Settings.NotificationSound) Chime.Play();
        _ringTimer ??= CreateRingTimer();
        _ringTimer.Start();
    }

    private Microsoft.UI.Dispatching.DispatcherQueueTimer CreateRingTimer()
    {
        var t = DispatcherQueue.CreateTimer();
        t.Interval = TimeSpan.FromSeconds(2.5);
        t.Tick += (_, _) =>
        {
            // Keep ringing like a phone until someone acts, then fall silent but leave the banner up.
            if (_ringing is null || DateTimeOffset.Now - _ringSince > RingFor) { t.Stop(); return; }
            if (Host.Settings.NotificationSound && !CallWindow.IsBusy) Chime.Play();
        };
        return t;
    }

    private void StopRinging()
    {
        _ringTimer?.Stop();
        _ringing = null;
        CallBar.Visibility = Visibility.Collapsed;
    }

    private void OnCallBarAnswer(object sender, RoutedEventArgs e)
    {
        if (_ringing is not { } entry) return;
        StopRinging();
        OpenCallCenter(page => page.Answer(entry.CallSessionId));
    }

    private void OnCallBarOpen(object sender, RoutedEventArgs e)
    {
        if (_ringing is not { } entry) return;
        StopRinging();
        OpenCallCenter(page => page.Select(entry.CallSessionId));
    }

    private async void OnCallBarReject(object sender, RoutedEventArgs e)
    {
        if (_ringing is not { } entry || Host.Workspace is not { } ws) return;
        CallBarAnswer.IsEnabled = CallBarReject.IsEnabled = false;
        _ringTimer?.Stop();
        try
        {
            await Host.Api.RejectCallAsync(ws.Id, entry.CallSessionId);
        }
        catch (ApiException ex)
        {
            Log.Error("reject call", ex);
        }
        StopRinging();
        Host.CallQueue?.Kick();
    }

    /// <summary>Shows the call center and hands it the call once the page is up.</summary>
    private void OpenCallCenter(Action<CallCenterPage> then)
    {
        if (ContentFrame.Content is CallCenterPage open)
        {
            then(open);
            return;
        }
        OpenPage("calls");
        DispatcherQueue.TryEnqueue(() => { if (ContentFrame.Content is CallCenterPage page) then(page); });
    }

    /// <summary>A toast for a call was clicked: open the desk on that call.</summary>
    public void OpenCall(string callId)
    {
        if (_ringing?.CallSessionId == callId) StopRinging();
        OpenCallCenter(page => page.Select(callId));
    }

    /// <summary>Online visitors on the sidebar, reported by the visitors page while it is open.</summary>
    public void SetVisitorsOnline(int count)
    {
        VisitorsBadge.Value = count;
        VisitorsBadge.Visibility = count > 0 ? Visibility.Visible : Visibility.Collapsed;
    }

    private void OnLanguageChanged()
    {
        ApplyLanguage();
        // Rebuild the page on show so every word is in the new language.
        var page = ContentFrame.Content?.GetType() ?? typeof(InboxPage);
        var open = Inbox?.OpenConversationId;
        Inbox?.Teardown();
        ContentFrame.Navigate(page, page == typeof(InboxPage) ? open : null);
        ContentFrame.BackStack.Clear();
        _notifier?.Kick();
    }

    private void ApplyLanguage()
    {
        var s = Host.Strings;
        InboxItem.Content = s["tabInbox"];
        InboxOpenItem.Content = s["navInboxOpen"];
        InboxAiItem.Content = s["navInboxAi"];
        InboxNeedsHumanItem.Content = s["navInboxNeedsHuman"];
        InboxPendingItem.Content = s["navInboxPending"];
        InboxResolvedItem.Content = s["navInboxResolved"];
        InboxSpamItem.Content = s["navInboxSpam"];
        InternalInboxItem.Content = s["navInternalInbox"];
        ColleaguesItem.Content = s["navColleagues"];
        OtherInboxesItem.Content = s["navOtherInboxes"];
        foreach (var item in OtherInboxesItem.MenuItems.OfType<NavigationViewItem>())
            if (item.Tag is string t && t.StartsWith("channel/", StringComparison.Ordinal)) item.Content = ChannelLabel(t[8..], s);
        if (Inbox is { } inbox && Nav.SelectedItem is NavigationViewItem { Tag: string tag }) ShowInbox(inbox, tag);
        ContactsItem.Content = s["tabContacts"];
        VisitorsItem.Content = s["navVisitors"];
        AnalyticsItem.Content = s["navAnalytics"];
        CallCenterItem.Content = s["navCallCenter"];
        EmailItem.Content = s["emailInbox"];
        if (Nav.SettingsItem is NavigationViewItem settings) settings.Content = s["tabSettings"];
        var name = Host.User?.FullName is { Length: > 0 } n ? n : Host.User?.Email ?? s["account"];
        ToolTipService.SetToolTip(AccountItem, Host.Workspace?.Name is { Length: > 0 } w ? $"{name} — {w}" : name);
        RenderMe();
        RenderWorkspaces();
        UpdateButton.Content = s["updateRestart"];
        ToastsOffBar.Title = s["windowsNotificationsOff"];
        ToastsOffBar.Message = s["windowsNotificationsOffBody"];
        ToastsOffButton.Content = s["openWindowsSettings"];
        BuildAccountMenu();
    }

    /// <summary>The account corner: photo, name, and presence as teammates see it.</summary>
    private void RenderMe()
    {
        var s = Host.Strings;
        var name = Host.Account?.Profile?.FullName is { Length: > 0 } pn ? pn
            : Host.User?.FullName is { Length: > 0 } n ? n : Host.User?.Email ?? s["account"];
        MeName.Text = name;
        MeAvatar.DisplayName = name;
        MeAvatar.ImageUrl = Host.Account?.AvatarUrl;
        var presence = Host.Presence;
        var state = presence?.State ?? Core.Api.PresenceStates.Offline;
        MeAvatar.PresenceState = state;
        var label = s[state switch
        {
            Core.Api.PresenceStates.Active => "presenceActive",
            Core.Api.PresenceStates.Away => "presenceAway",
            Core.Api.PresenceStates.Disconnected => "presenceDisconnected",
            _ => "presenceOffline",
        }];
        MeStatus.Text = presence?.IsInvisible == true ? $"{label} · {s["statusInvisible"]}" : label;
        BuildAccountMenu();
    }

    private void BuildAccountMenu()
    {
        var s = Host.Strings;
        AccountMenu.Items.Clear();
        if (Host.User?.Email is { } email) AccountMenu.Items.Add(new MenuFlyoutItem { Text = email, IsEnabled = false });

        // Online / invisible: the web console's "invisible mode" (force_offline).
        if (Host.Presence is { } presence)
        {
            AccountMenu.Items.Add(new MenuFlyoutSeparator());
            AccountMenu.Items.Add(new MenuFlyoutItem { Text = s["statusHeader"], IsEnabled = false });
            var online = new RadioMenuFlyoutItem { Text = s["statusOnlineForVisitors"], GroupName = "status", IsChecked = !presence.IsInvisible, Icon = new FontIcon { Glyph = "\uE73E" } };
            var invisible = new RadioMenuFlyoutItem { Text = s["statusInvisible"], GroupName = "status", IsChecked = presence.IsInvisible, Icon = new FontIcon { Glyph = "\uE7B3" } };
            ToolTipService.SetToolTip(invisible, s["statusInvisibleHint"]);
            online.Click += async (_, _) => await SetInvisibleAsync(false);
            invisible.Click += async (_, _) => await SetInvisibleAsync(true);
            AccountMenu.Items.Add(online);
            AccountMenu.Items.Add(invisible);
        }
        if (Host.Workspaces.Count > 1)
        {
            var sub = new MenuFlyoutSubItem { Text = s["workspace"] };
            foreach (var ws in Host.Workspaces)
            {
                var item = new ToggleMenuFlyoutItem { Text = ws.Name, IsChecked = ws.Id == Host.Workspace?.Id };
                item.Click += async (_, _) => await SwitchWorkspaceAsync(ws);
                sub.Items.Add(item);
            }
            AccountMenu.Items.Add(sub);
        }
        AccountMenu.Items.Add(new MenuFlyoutSeparator());
        var signOut = new MenuFlyoutItem { Text = s["signOut"], Icon = new FontIcon { Glyph = "" } };
        signOut.Click += async (_, _) => await SignOutAsync();
        AccountMenu.Items.Add(signOut);
    }

    private async Task SetInvisibleAsync(bool invisible)
    {
        if (Host.Presence is not { } presence || presence.IsInvisible == invisible) return;
        try
        {
            await presence.SetInvisibleAsync(invisible);
        }
        catch (Exception e)
        {
            Log.Error("set status", e);
            await new ContentDialog { XamlRoot = XamlRoot, FlowDirection = FlowDirection, Title = Host.Strings["statusChangeFailed"], Content = ErrorText.For(e, Host.Strings), CloseButtonText = Host.Strings["ok"] }.ShowAsync();
        }
    }

    private async Task SwitchWorkspaceAsync(Core.Api.Workspace ws)
    {
        if (ws.Id == Host.Workspace?.Id) return;
        Host.Settings.WorkspaceId = ws.Id;
        Host.Settings.Save();
        Teardown();
        await App.Current.Window!.EnterAsync();
    }

    public async Task SignOutAsync()
    {
        var owner = Host.User?.Id ?? Host.Settings.SessionUserId;
        var s = Host.Strings;
        var dialog = new ContentDialog
        {
            XamlRoot = XamlRoot,
            FlowDirection = s.IsRightToLeft ? FlowDirection.RightToLeft : FlowDirection.LeftToRight,
            Title = s["signOut"],
            Content = s["signOutConfirm"],
            PrimaryButtonText = s["signOut"],
            CloseButtonText = s["cancel"],
            DefaultButton = ContentDialogButton.Close,
        };
        if (await dialog.ShowAsync() != ContentDialogResult.Primary) return;
        try
        {
            await Host.Client.LogoutAsync();
        }
        catch (Exception e)
        {
            // Offline: forget the session here anyway; the server lets it lapse.
            Log.Error("logout", e);
            Host.Client.DiscardSession();
        }
        // An explicit sign-out takes this operator's conversations off the PC too.
        App.Current.Window!.SignedOut(forgetAccount: owner);
    }

    private void SetUnread(int count)
    {
        UnreadBadge.Value = count;
        UnreadBadge.Visibility = count > 0 ? Visibility.Visible : Visibility.Collapsed;
        App.Current.SetUnread(count);
    }

    private void OnUpdateChanged(object? sender, PropertyChangedEventArgs e) => ShowUpdate();

    private void ShowUpdate()
    {
        var s = Host.Strings;
        var u = Host.Updates;
        var version = Digits.Localize(u.AvailableVersion ?? string.Empty, s.Language);
        if (u.Status == UpdateStatus.Ready)
        {
            UpdateBar.Severity = u.Required ? InfoBarSeverity.Error : InfoBarSeverity.Informational;
            UpdateBar.Title = u.Required ? s["updateRequiredTitle"] : s["updateReadyTitle"];
            UpdateBar.Message = u.Required ? s["updateRequiredBody"] : s.Get("updateReadyBody", "version", version);
            UpdateBar.IsClosable = !u.Required;
            UpdateButton.Visibility = Visibility.Visible;
            UpdateBar.IsOpen = true;
        }
        else if (u.Required)
        {
            // Below the platform's minimum and nothing downloaded yet: say so, and fetch it.
            UpdateBar.Severity = InfoBarSeverity.Error;
            UpdateBar.Title = s["updateRequiredTitle"];
            UpdateBar.Message = u.Status == UpdateStatus.Downloading
                ? s.Get("updateDownloading", new Dictionary<string, object> { ["version"] = version, ["percent"] = u.Progress })
                : s["updateRequiredBody"];
            UpdateBar.IsClosable = false;
            UpdateButton.Visibility = Visibility.Collapsed;
            UpdateBar.IsOpen = true;
            if (u.Status is UpdateStatus.Idle or UpdateStatus.Current or UpdateStatus.Failed) _ = u.CheckAsync();
        }
        else
        {
            UpdateBar.IsOpen = false;
        }
    }

    private void OnRestartToUpdate(object sender, RoutedEventArgs e)
    {
        App.Current.PrepareForUpdate();
        Host.Updates.ApplyAndRestart();
    }

    private void CheckWindowsNotifications()
    {
        try
        {
            ToastsOffBar.IsOpen = Host.Settings.Notifications &&
                AppNotificationManager.Default.Setting != AppNotificationSetting.Enabled;
        }
        catch (Exception e)
        {
            Log.Error("notification setting", e);
            ToastsOffBar.IsOpen = false;
        }
    }

    private async void OnOpenWindowsSettings(object sender, RoutedEventArgs e)
    {
        await Windows.System.Launcher.LaunchUriAsync(new Uri("ms-settings:notifications"));
        ToastsOffBar.IsOpen = false;
    }
}
