using System.ComponentModel;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Controls.Primitives;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Navigation;
using Microsoft.Windows.AppNotifications;
using Webyar.App.Services;
using Webyar.Core.Localization;

namespace Webyar.App.Views;

/// <summary>The signed-in frame: the navigation rail, the banners, and the page on show.</summary>
public sealed partial class ShellPage : Page
{
    private BackgroundNotifier? _notifier;
    private string? _pendingConversation;

    public ShellPage()
    {
        InitializeComponent();
        NavigationCacheMode = NavigationCacheMode.Disabled;
        ContentFrame.Navigated += (_, _) => SyncSelection();
    }

    private static AppHost Host => App.Current.Host;

    public InboxPage? Inbox => ContentFrame.Content as InboxPage;

    protected override void OnNavigatedTo(NavigationEventArgs e)
    {
        base.OnNavigatedTo(e);
        Host.LanguageChanged += OnLanguageChanged;
        Host.Updates.PropertyChanged += OnUpdateChanged;
        ApplyLanguage();
        ShowUpdate();
        CheckWindowsNotifications();

        if (Host.Workspace is { } ws)
        {
            _notifier = new BackgroundNotifier(Host, ws.Id) { VisibleConversation = () => Inbox?.OpenConversationId };
            _notifier.UnreadChanged += SetUnread;
            _notifier.Start();
        }
        Nav.SelectedItem = InboxItem;
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

    private void OnNavigate(NavigationView sender, NavigationViewSelectionChangedEventArgs args)
    {
        if (args.IsSettingsSelected)
        {
            if (ContentFrame.Content is not SettingsPage) ContentFrame.Navigate(typeof(SettingsPage));
            return;
        }
        if (args.SelectedItem == InboxItem && ContentFrame.Content is not InboxPage)
        {
            Inbox?.Teardown();
            ContentFrame.Navigate(typeof(InboxPage), _pendingConversation);
            _pendingConversation = null;
        }
    }

    private void SyncSelection()
    {
        var want = ContentFrame.Content is SettingsPage ? Nav.SettingsItem : InboxItem;
        if (!ReferenceEquals(Nav.SelectedItem, want)) Nav.SelectedItem = want;
    }

    private void OnLanguageChanged()
    {
        ApplyLanguage();
        // Rebuild the page on show so every word is in the new language.
        var page = ContentFrame.Content switch { SettingsPage => typeof(SettingsPage), _ => typeof(InboxPage) };
        Inbox?.Teardown();
        ContentFrame.Navigate(page, Inbox?.OpenConversationId);
        ContentFrame.BackStack.Clear();
        _notifier?.Kick();
    }

    private void ApplyLanguage()
    {
        var s = Host.Strings;
        InboxItem.Content = s["tabInbox"];
        if (Nav.SettingsItem is NavigationViewItem settings) settings.Content = s["tabSettings"];
        var name = Host.User?.FullName is { Length: > 0 } n ? n : Host.User?.Email ?? s["account"];
        AccountItem.Content = name;
        ToolTipService.SetToolTip(AccountItem, Host.Workspace?.Name is { Length: > 0 } w ? $"{name} — {w}" : name);
        Nav.PaneTitle = Host.Workspace?.Name ?? s["appName"];
        UpdateButton.Content = s["updateRestart"];
        ToastsOffBar.Title = s["windowsNotificationsOff"];
        ToastsOffBar.Message = s["windowsNotificationsOffBody"];
        ToastsOffButton.Content = s["openWindowsSettings"];
        BuildAccountMenu();
    }

    private void BuildAccountMenu()
    {
        var s = Host.Strings;
        AccountMenu.Items.Clear();
        if (Host.User?.Email is { } email) AccountMenu.Items.Add(new MenuFlyoutItem { Text = email, IsEnabled = false });
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
