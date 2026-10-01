using System.ComponentModel;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Navigation;
using Webyar.App.Helpers;
using Webyar.App.Services;
using Webyar.App.ViewModels;
using Webyar.Core.Api;
using Webyar.Core.Localization;
using Webyar.Core.Support;

namespace Webyar.App.Views;

/// <summary>
/// This machine's preferences. Who gets notified about what is the operator's
/// account setting and lives on the server (edited in the web console); only
/// "show toasts here" and the sound are local.
/// </summary>
public sealed partial class SettingsPage : Page
{
    private bool _ready;

    public SettingsPage()
    {
        InitializeComponent();
    }

    private static AppHost Host => App.Current.Host;

    protected override void OnNavigatedTo(NavigationEventArgs e)
    {
        base.OnNavigatedTo(e);
        var settings = Host.Settings;
        ApplyLanguage();
        LanguagePicker.SelectedIndex = Host.Strings.Language switch { Core.Localization.Language.En => 1, Core.Localization.Language.Tr => 2, _ => 0 };
        AppearancePicker.SelectedIndex = (int)settings.Appearance;
        ToastsToggle.IsOn = settings.Notifications;
        SoundToggle.IsOn = settings.NotificationSound;
        StartupToggle.IsOn = settings.StartWithWindows;
        TrayToggle.IsOn = settings.CloseToTray;
        ShowStorage();
        Host.PlatformChanged += ShowStorage;
        Host.MeChanged += OnMeChanged;
        Host.Updates.PropertyChanged += OnUpdateChanged;
        ShowUpdate();
        StartSupport();
        _ready = true;
    }

    protected override void OnNavigatedFrom(NavigationEventArgs e)
    {
        base.OnNavigatedFrom(e);
        Host.Updates.PropertyChanged -= OnUpdateChanged;
        Host.PlatformChanged -= ShowStorage;
        Host.MeChanged -= OnMeChanged;
        StopSupport();
    }

    /// <summary>The account arrived (or could not be read): its photo replaces the skeleton.</summary>
    private void OnMeChanged() => Host.RunOnUi(() =>
    {
        AccountAvatar.ImageUrl = Host.Account?.AvatarUrl;
        AccountAvatar.IsPending = Host.AccountPending;
    });

    /// <summary>
    /// The Storage section, when Super Admin shows it to operators. Hidden, the
    /// cache itself works exactly the same; only this view of it is left out.
    /// </summary>
    private void ShowStorage()
    {
        var visible = Host.Settings.StorageSettingsVisible;
        StorageHeader.Visibility = CacheExpander.Visibility = visible ? Visibility.Visible : Visibility.Collapsed;
        if (visible) _ = ShowCacheAsync();
    }

    private void ApplyLanguage()
    {
        var s = Host.Strings;
        PageTitle.Text = s["tabSettings"];
        GeneralHeader.Text = s["general"];
        LanguageLabel.Text = s["language"];
        AppearanceLabel.Text = s["appearance"];
        AppearanceHint.Text = s["appearanceHint"];
        AppearancePicker.Items.Clear();
        foreach (var key in new[] { "appearanceSystem", "appearanceLight", "appearanceDark" }) AppearancePicker.Items.Add(s[key]);

        NotificationsHeader.Text = s["notifications"];
        ToastsLabel.Text = s["desktopNotifications"];
        ToastsHint.Text = s["desktopNotificationsHint"];
        SoundLabel.Text = s["notificationSoundLocal"];
        ServerPrefsHint.Text = s["notificationsServerFooter"];
        WindowsSettingsLink.Text = s["openWindowsSettings"];

        DesktopHeader.Text = s["desktop"];
        StartupLabel.Text = s["startWithWindows"];
        StartupHint.Text = s["startWithWindowsHint"];
        TrayLabel.Text = s["closeToTray"];
        TrayHint.Text = s["closeToTrayHint"];

        UpdatesHeader.Text = s["updates"];
        CheckButton.Content = s["checkForUpdates"];
        RestartButton.Content = s["updateRestart"];

        AccountName.Text = Host.User?.FullName ?? string.Empty;
        AccountEmail.Text = Host.User?.Email ?? string.Empty;
        AccountWorkspace.Text = Host.Workspace?.Name ?? string.Empty;
        AccountAvatar.DisplayName = AccountName.Text.Length > 0 ? AccountName.Text : AccountEmail.Text;
        AccountAvatar.ImageUrl = Host.Account?.AvatarUrl;
        // The account (and its photo) not loaded yet: a skeleton, not a face that changes a moment later.
        AccountAvatar.IsPending = Host.AccountPending;
        SignOutButton.Content = s["signOut"];

        StorageHeader.Text = s["storage"];
        CacheLabel.Text = s["cacheTotal"];
        CacheHint.Text = s["cacheTotalHint"];
        CacheMessagesLabel.Text = s["cacheMessages"];
        CacheFilesLabel.Text = s["cacheFiles"];
        CacheFolderLabel.Text = s["fileCacheFolder"];
        CachePath.Text = AppPaths.Cache;
        OpenCacheButton.Content = s["openFolder"];
        ToolTipService.SetToolTip(CopyPathButton, s["copyPath"]);
        ClearCacheLabel.Text = s["clearCache"];
        ClearCacheHint.Text = s["clearCacheAllHint"];
        ClearCacheButton.Content = s["clearCache"];

        SupportHeader.Text = s["supportSection"];
        SupportLabel.Text = s["supportChat"];
        AutomationProperties.SetName(SupportCard, s["supportChat"]);
    }

    // ── Online support ──

    private Microsoft.UI.Dispatching.DispatcherQueueTimer? _supportTimer;
    private CancellationTokenSource? _supportRead;

    /// <summary>
    /// The row shows at once from the last known status, then reads it again —
    /// now, every minute while Settings is open ("online" is a clock as much as
    /// an event), and on the team's realtime news.
    /// </summary>
    private void StartSupport()
    {
        ShowSupport(SupportPage.KnownStatus);
        _ = ReadSupportAsync();
        _supportTimer = DispatcherQueue.CreateTimer();
        _supportTimer.Interval = TimeSpan.FromMinutes(1);
        _supportTimer.Tick += (_, _) => _ = ReadSupportAsync();
        _supportTimer.Start();
        Host.InboxChanged += OnSupportNews;
    }

    private void StopSupport()
    {
        _supportTimer?.Stop();
        _supportTimer = null;
        _supportRead?.Cancel();
        Host.InboxChanged -= OnSupportNews;
    }

    private void OnSupportNews(Core.Realtime.InboxEvent e)
    {
        if (e.Kind is { } kind && SupportRules.LiveKinds.Contains(kind)) _ = ReadSupportAsync();
    }

    private async Task ReadSupportAsync()
    {
        _supportRead?.Cancel();
        var cts = _supportRead = new CancellationTokenSource();
        try
        {
            var status = await Host.Api.SupportStatusAsync(cts.Token);
            if (cts.IsCancellationRequested) return;
            SupportPage.KnownStatus = status;
            ShowSupport(status);
        }
        catch (Exception e) when (e is ApiException or OperationCanceledException)
        {
            // Kept as last shown; a support that cannot be reached stays out of the way.
        }
    }

    /// <summary>Settings → Online support, when the server offers it: presence and the unread count.</summary>
    private void ShowSupport(SupportStatus? status)
    {
        var shown = status is { Shown: true };
        SupportHeader.Visibility = SupportCard.Visibility = shown ? Visibility.Visible : Visibility.Collapsed;
        if (status is null || !shown) return;
        var s = Host.Strings;
        SupportPresence.Text = SupportRules.Presence(status.Online, s);
        SupportPresence.Foreground = Palette.Resource(status.Online ? "SuccessBrush" : "Text2Brush");
        SupportDot.Fill = Palette.Resource(status.Online ? "SuccessBrush" : "Text3Brush");
        var unread = status.Unread > 0;
        SupportUnread.Visibility = unread ? Visibility.Visible : Visibility.Collapsed;
        SupportUnreadText.Text = Digits.Localize((status.Unread > 99 ? "99+" : status.Unread.ToString(System.Globalization.CultureInfo.InvariantCulture)), s.Language);
        AutomationProperties.SetHelpText(SupportCard, unread ? s.Get("supportUnread", "n", status.Unread) : SupportPresence.Text);
    }

    private void OnOpenSupport(object sender, RoutedEventArgs e) => Frame.Navigate(typeof(SupportPage));

    private void OnLanguageChanged(object sender, SelectionChangedEventArgs e)
    {
        if (!_ready || LanguagePicker.SelectedItem is not ComboBoxItem { Tag: string code } || Strings.Parse(code) is not { } language) return;
        if (language == Host.Strings.Language) return;
        // The shell rebuilds this page in the new language.
        Host.SetLanguage(language);
    }

    private void OnAppearanceChanged(object sender, SelectionChangedEventArgs e)
    {
        if (!_ready || AppearancePicker.SelectedIndex < 0) return;
        Host.Settings.Appearance = (Appearance)AppearancePicker.SelectedIndex;
        Host.Settings.Save();
        App.Current.Window?.ApplyTheme();
    }

    private void OnToastsToggled(object sender, RoutedEventArgs e) => Save(s => s.Notifications = ToastsToggle.IsOn);

    private void OnSoundToggled(object sender, RoutedEventArgs e) => Save(s => s.NotificationSound = SoundToggle.IsOn);

    private void OnTrayToggled(object sender, RoutedEventArgs e) => Save(s => s.CloseToTray = TrayToggle.IsOn);

    private void OnStartupToggled(object sender, RoutedEventArgs e)
    {
        if (!_ready) return;
        Save(s => s.StartWithWindows = StartupToggle.IsOn);
        StartupRegistration.Apply(StartupToggle.IsOn);
    }

    private void Save(Action<AppSettings> change)
    {
        if (!_ready) return;
        change(Host.Settings);
        Host.Settings.Save();
    }

    private async void OnOpenWindowsSettings(object sender, RoutedEventArgs e) =>
        await Windows.System.Launcher.LaunchUriAsync(new Uri("ms-settings:notifications"));

    private void OnUpdateChanged(object? sender, PropertyChangedEventArgs e) => ShowUpdate();

    private void ShowUpdate()
    {
        var s = Host.Strings;
        var u = Host.Updates;
        VersionText.Text = $"{s["version"]} {Digits.Localize(u.CurrentVersion, s.Language)}";
        var version = Digits.Localize(u.AvailableVersion ?? string.Empty, s.Language);
        UpdateStatusText.Text = u.Status switch
        {
            UpdateStatus.Checking => s["updateChecking"],
            UpdateStatus.Current => s["updateCurrent"],
            UpdateStatus.Downloading => s.Get("updateDownloading", new Dictionary<string, object> { ["version"] = version, ["percent"] = u.Progress }),
            UpdateStatus.Ready => s.Get("updateReadyBody", "version", version),
            UpdateStatus.Failed => s["updateFailed"],
            _ => string.Empty,
        };
        UpdateProgress.Visibility = u.Status == UpdateStatus.Downloading ? Visibility.Visible : Visibility.Collapsed;
        UpdateProgress.Value = u.Progress;
        CheckButton.IsEnabled = u.Status is not (UpdateStatus.Checking or UpdateStatus.Downloading or UpdateStatus.Unavailable);
        CheckButton.Visibility = u.Status == UpdateStatus.Ready ? Visibility.Collapsed : Visibility.Visible;
        RestartButton.Visibility = u.Status == UpdateStatus.Ready ? Visibility.Visible : Visibility.Collapsed;
    }

    private async void OnCheckUpdates(object sender, RoutedEventArgs e) => await Host.Updates.CheckAsync();

    private void OnRestart(object sender, RoutedEventArgs e)
    {
        App.Current.PrepareForUpdate();
        Host.Updates.ApplyAndRestart();
    }

    private async void OnSignOut(object sender, RoutedEventArgs e)
    {
        if (App.Current.Window?.Shell is { } shell) await shell.SignOutAsync();
    }

    private async Task ShowCacheAsync()
    {
        var (data, files, photos) = await Task.Run(AppHost.MeasureLocalData);
        var s = Host.Strings;
        CacheMessagesSize.Text = AttachmentItem.FormatSize(data, s);
        CacheFilesSize.Text = AttachmentItem.FormatSize(files + photos, s);
        CacheSize.Text = AttachmentItem.FormatSize(data + files + photos, s);
        ClearCacheButton.IsEnabled = data + files + photos > 0;
    }

    private void OnOpenCache(object sender, RoutedEventArgs e)
    {
        try
        {
            System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo("explorer.exe", $"\"{AppPaths.Cache}\"") { UseShellExecute = true });
        }
        catch (Exception ex)
        {
            Log.Error("open cache folder", ex);
        }
    }

    private void OnCopyCachePath(object sender, RoutedEventArgs e)
    {
        var package = new Windows.ApplicationModel.DataTransfer.DataPackage();
        package.SetText(AppPaths.Cache);
        Windows.ApplicationModel.DataTransfer.Clipboard.SetContent(package);
    }

    private async void OnClearCache(object sender, RoutedEventArgs e)
    {
        var s = Host.Strings;
        var dialog = new ContentDialog
        {
            XamlRoot = XamlRoot,
            Title = s["clearCache"],
            Content = s["clearCacheAllConfirm"],
            PrimaryButtonText = s["clearCache"],
            CloseButtonText = s["cancel"],
            DefaultButton = ContentDialogButton.Close,
            FlowDirection = s.IsRightToLeft ? FlowDirection.RightToLeft : FlowDirection.LeftToRight,
        };
        if (await dialog.ShowAsync() != ContentDialogResult.Primary) return;
        ClearCacheButton.IsEnabled = false;
        try
        {
            // Conversations, messages, files, photos and every memory copy. Not the
            // session, not the settings, nothing on the server. Open views sync again.
            await Host.ClearLocalDataAsync();
        }
        catch (Exception ex)
        {
            Log.Error("clear cache", ex);
        }
        await ShowCacheAsync();
        ClearCacheHint.Text = s["cacheCleared"];
    }
}
