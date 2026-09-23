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

        if (Host.Workspace is { } ws)
        {
            _notifier = new BackgroundNotifier(Host, ws.Id) { VisibleConversation = () => Inbox?.OpenConversationId };
            _notifier.UnreadChanged += SetUnread;
            _notifier.Start();
        }
        // Webyar.exe --page=contacts|visitors|calls|settings opens straight on that section.
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
        Nav.SelectedItem = InboxItem;
    }

    /// <summary>Shows a section by its tag: inbox, contacts, visitors, calls or settings.</summary>
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
            "calls" => CallCenterItem,
            "settings" => Nav.SettingsItem ?? InboxItem,
            _ => InboxItem,
        };
    }

    private void OpenSettingsWhenLoaded(object sender, RoutedEventArgs e)
    {
        Nav.Loaded -= OpenSettingsWhenLoaded;
        DispatcherQueue.TryEnqueue(() => OpenPage("settings"));
    }

    private void OnNavigate(NavigationView sender, NavigationViewSelectionChangedEventArgs args)
    {
        var page = args.IsSettingsSelected ? typeof(SettingsPage) : (args.SelectedItem as NavigationViewItem)?.Tag switch
        {
            "contacts" => typeof(ContactsPage),
            "visitors" => typeof(VisitorsPage),
            "calls" => typeof(CallCenterPage),
            _ => typeof(InboxPage),
        };
        if (ContentFrame.Content?.GetType() == page) return;
        Inbox?.Teardown();
        ContentFrame.Navigate(page, page == typeof(InboxPage) ? _pendingConversation : null);
        if (page == typeof(InboxPage)) _pendingConversation = null;
    }

    private void SyncSelection()
    {
        object want = ContentFrame.Content switch
        {
            SettingsPage => Nav.SettingsItem,
            ContactsPage => ContactsItem,
            VisitorsPage => VisitorsItem,
            CallCenterPage => CallCenterItem,
            _ => InboxItem,
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
        ContactsItem.Content = s["tabContacts"];
        VisitorsItem.Content = s["navVisitors"];
        CallCenterItem.Content = s["navCallCenter"];
        if (Nav.SettingsItem is NavigationViewItem settings) settings.Content = s["tabSettings"];
        var name = Host.User?.FullName is { Length: > 0 } n ? n : Host.User?.Email ?? s["account"];
        ToolTipService.SetToolTip(AccountItem, Host.Workspace?.Name is { Length: > 0 } w ? $"{name} — {w}" : name);
        RenderMe();
        WorkspaceName.Text = Host.Workspace?.Name is { Length: > 0 } wn ? wn : s["appName"];
        WorkspaceLogo.ImageSource = new Microsoft.UI.Xaml.Media.Imaging.BitmapImage(
            Host.Workspace?.LogoUrl is { } logo && logo.StartsWith("https://", StringComparison.OrdinalIgnoreCase) ? new Uri(logo) : new Uri(AppPaths.Icon));
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

    private void OnAccountTapped(object sender, TappedRoutedEventArgs e) => FlyoutBase.ShowAttachedFlyout(AccountItem);

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
        App.Current.Window!.SignedOut();
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
