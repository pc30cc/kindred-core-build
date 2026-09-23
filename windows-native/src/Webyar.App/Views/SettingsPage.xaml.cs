using System.ComponentModel;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Navigation;
using Webyar.App.Services;
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
        LanguagePicker.SelectedIndex = Host.Strings.Language switch { Language.En => 1, Language.Tr => 2, _ => 0 };
        AppearancePicker.SelectedIndex = (int)settings.Appearance;
        ToastsToggle.IsOn = settings.Notifications;
        SoundToggle.IsOn = settings.NotificationSound;
        StartupToggle.IsOn = settings.StartWithWindows;
        TrayToggle.IsOn = settings.CloseToTray;
        ServerBox.Text = settings.ApiOrigin == ApiClient.DefaultOrigin.ToString().TrimEnd('/') ? string.Empty : settings.ApiOrigin ?? string.Empty;
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
        WindowsSettingsLink.Content = s["openWindowsSettings"];

        DesktopHeader.Text = s["desktop"];
        StartupLabel.Text = s["startWithWindows"];
        StartupHint.Text = s["startWithWindowsHint"];
        TrayLabel.Text = s["closeToTray"];
        TrayHint.Text = s["closeToTrayHint"];

        UpdatesHeader.Text = s["updates"];
        CheckButton.Content = s["checkForUpdates"];
        RestartButton.Content = s["updateRestart"];

        AccountHeader.Text = s["account"];
        AccountName.Text = Host.User?.FullName ?? string.Empty;
        AccountEmail.Text = Host.User?.Email ?? string.Empty;
        SignOutButton.Content = s["signOut"];
        ServerLabel.Text = s["serverAddress"];
        ServerBox.PlaceholderText = ApiClient.DefaultOrigin.ToString().TrimEnd('/');
        ServerHint.Text = s["serverAddressHint"];
        ServerSave.Content = s["save"];
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

    private async void OnSaveServer(object sender, RoutedEventArgs e)
    {
        var text = ServerBox.Text.Trim().TrimEnd('/');
        Uri origin;
        if (text.Length == 0) origin = ApiClient.DefaultOrigin;
        else if (!Uri.TryCreate(text.Contains("://", StringComparison.Ordinal) ? text : $"https://{text}", UriKind.Absolute, out var parsed) || parsed.Scheme != Uri.UriSchemeHttps)
        {
            ServerHint.Text = Host.Strings["serverInvalid"];
            return;
        }
        else origin = parsed;

        Host.Client.Origin = origin;
        Host.Settings.ApiOrigin = origin.ToString().TrimEnd('/');
        Host.Settings.Save();
        ServerHint.Text = Host.Strings["saved"];
        await Host.RefreshPlatformAsync();
    }
}
