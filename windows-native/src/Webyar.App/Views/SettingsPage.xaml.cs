using System.ComponentModel;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Navigation;
using Webyar.App.Services;
using Webyar.App.ViewModels;
using Webyar.Core.Api;
using Webyar.Core.Localization;

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
        _ = ShowCacheAsync();
        Host.Updates.PropertyChanged += OnUpdateChanged;
        ShowUpdate();
        _ready = true;
    }

    protected override void OnNavigatedFrom(NavigationEventArgs e)
    {
        base.OnNavigatedFrom(e);
        Host.Updates.PropertyChanged -= OnUpdateChanged;
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
        SignOutButton.Content = s["signOut"];

        StorageHeader.Text = s["storage"];
        CacheLabel.Text = s["fileCache"];
        CacheHint.Text = s["fileCacheHint"];
        CacheFolderLabel.Text = s["fileCacheFolder"];
        CachePath.Text = FileCache.Folder;
        OpenCacheButton.Content = s["openFolder"];
        ToolTipService.SetToolTip(CopyPathButton, s["copyPath"]);
        ClearCacheLabel.Text = s["clearCache"];
        ClearCacheHint.Text = s["clearCacheHint"];
        ClearCacheButton.Content = s["clearCache"];
    }

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
        var (bytes, count) = await Task.Run(FileCache.Measure);
        var s = Host.Strings;
        CacheSize.Text = AttachmentItem.FormatSize(bytes, s);
        ClearCacheButton.IsEnabled = count > 0;
    }

    private void OnOpenCache(object sender, RoutedEventArgs e)
    {
        try
        {
            System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo("explorer.exe", $"\"{FileCache.Folder}\"") { UseShellExecute = true });
        }
        catch (Exception ex)
        {
            Log.Error("open cache folder", ex);
        }
    }

    private void OnCopyCachePath(object sender, RoutedEventArgs e)
    {
        var package = new Windows.ApplicationModel.DataTransfer.DataPackage();
        package.SetText(FileCache.Folder);
        Windows.ApplicationModel.DataTransfer.Clipboard.SetContent(package);
    }

    private async void OnClearCache(object sender, RoutedEventArgs e)
    {
        var s = Host.Strings;
        var dialog = new ContentDialog
        {
            XamlRoot = XamlRoot,
            Title = s["clearCache"],
            Content = s["clearCacheConfirm"],
            PrimaryButtonText = s["clearCache"],
            CloseButtonText = s["cancel"],
            DefaultButton = ContentDialogButton.Close,
            FlowDirection = s.IsRightToLeft ? FlowDirection.RightToLeft : FlowDirection.LeftToRight,
        };
        if (await dialog.ShowAsync() != ContentDialogResult.Primary) return;
        ClearCacheButton.IsEnabled = false;
        await Task.Run(FileCache.Clear);
        AttachmentItem.ClearMemory();
        await ShowCacheAsync();
        ClearCacheHint.Text = s["cacheCleared"];
    }
}
