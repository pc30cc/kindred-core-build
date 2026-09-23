using System.Runtime.InteropServices;
using Microsoft.UI;
using Microsoft.UI.Windowing;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Media.Imaging;
using Webyar.App.Services;
using Webyar.App.Views;
using Webyar.Core.Api;
using Windows.Graphics;

namespace Webyar.App;

/// <summary>
/// The one window: restores the session at launch, then shows either the
/// sign-in page or the shell. Closing it keeps the app in the tray (when the
/// operator wants that), so notifications keep arriving.
/// </summary>
public sealed partial class MainWindow : Window
{
    private readonly DispatcherTimer _platformTimer = new() { Interval = TimeSpan.FromHours(1) };
    private IReadOnlyDictionary<string, string>? _pendingOpen;

    public MainWindow()
    {
        InitializeComponent();
        ExtendsContentIntoTitleBar = true;
        SetTitleBar(TitleBarArea);
        TitleIcon.Source = new BitmapImage(new Uri(AppPaths.Icon));
        try
        {
            AppWindow.SetIcon(AppPaths.WindowIcon);
        }
        catch (Exception e)
        {
            Log.Error("window icon", e);
        }


        if (AppWindow.Presenter is OverlappedPresenter presenter)
        {
            presenter.PreferredMinimumWidth = Scale(880);
            presenter.PreferredMinimumHeight = Scale(580);
        }
        RestoreBounds();

        // Windowing fails fast (the whole process dies) if one of its callbacks
        // throws, so nothing may escape these handlers.
        AppWindow.Closing += (s, e) => Guard("closing", () => OnClosing(s, e));
        AppWindow.Changed += (_, e) =>
        {
            if (e.DidSizeChange || e.DidPresenterChange) Guard("insets", UpdateInsets);
        };
        Root.ActualThemeChanged += (_, _) => Guard("theme", ApplyTheme);
        Activated += (_, e) => IsForeground = e.WindowActivationState != WindowActivationState.Deactivated;
        Host.LanguageChanged += ApplyLanguage;
        Host.Client.Unauthorized += (_, _) => Host.RunOnUi(SignedOut);
        _platformTimer.Tick += async (_, _) => await RefreshPlatformQuietlyAsync();
        ApplyLanguage();
        ApplyTheme();
    }

    private static AppHost Host => App.Current.Host;

    /// <summary>Whether the window is in front and focused right now.</summary>
    public bool IsForeground { get; private set; }

    public ShellPage? Shell => RootFrame.Content as ShellPage;

    public async Task StartAsync(IReadOnlyDictionary<string, string>? launch)
    {
        _pendingOpen = launch;
        Splash.Visibility = Visibility.Visible;
        await RefreshPlatformQuietlyAsync();
        _platformTimer.Start();

        if (!Host.Client.HasSession)
        {
            ShowLogin();
            return;
        }
        try
        {
            Host.User = await Host.Api.CurrentUserAsync();
            await EnterAsync();
        }
        catch (ApiException e) when (e.Failure == ApiFailure.Unauthorized)
        {
            ShowLogin();
        }
        catch (Exception e)
        {
            // Offline at launch: keep the session and show the shell, which retries on its own.
            Log.Error("restore session", e);
            await EnterAsync();
        }
    }

    /// <summary>After a sign-in or a restored session: pick the workspace and open the shell.</summary>
    public async Task EnterAsync()
    {
        try
        {
            Host.Workspaces = await Host.Api.WorkspacesAsync();
        }
        catch (ApiException e) when (e.Failure != ApiFailure.Unauthorized)
        {
            Log.Error("workspaces", e);
        }
        Host.Workspace = Host.Workspaces.FirstOrDefault(w => w.Id == Host.Settings.WorkspaceId) ?? Host.Workspaces.FirstOrDefault()
            ?? (Host.Settings.WorkspaceId is { } id ? new Workspace(id, string.Empty) : null);
        if (Host.Workspace is not null && Host.Workspace.Id != Host.Settings.WorkspaceId)
        {
            Host.Settings.WorkspaceId = Host.Workspace.Id;
            Host.Settings.Save();
        }
        await Host.StartRealtimeAsync();
        Splash.Visibility = Visibility.Collapsed;
        RootFrame.Navigate(typeof(ShellPage));
        if (_pendingOpen is { } open)
        {
            _pendingOpen = null;
            OpenFromNotification(open);
        }
    }

    public void ShowLogin()
    {
        Splash.Visibility = Visibility.Collapsed;
        App.Current.SetUnread(0);
        RootFrame.Navigate(typeof(LoginPage));
        RootFrame.BackStack.Clear();
    }

    /// <summary>The server no longer knows this session (or the operator signed out).</summary>
    public async void SignedOut()
    {
        if (RootFrame.Content is LoginPage) return;
        Shell?.Teardown();
        Host.User = null;
        await Host.StartRealtimeAsync(); // with no workspace this only stops the old one
        ShowLogin();
    }

    public void OpenFromNotification(IReadOnlyDictionary<string, string> args)
    {
        if (!args.TryGetValue("conversation", out var id)) return;
        if (Shell is { } shell) shell.OpenConversation(id);
        else _pendingOpen = args;
    }

    private async Task RefreshPlatformQuietlyAsync()
    {
        try
        {
            await Host.RefreshPlatformAsync();
        }
        catch (Exception e)
        {
            Log.Error("platform config", e);
        }
    }

    /// <summary>Light, dark or as Windows is — applied live, caption buttons included.</summary>
    public void ApplyTheme()
    {
        Root.RequestedTheme = Host.Settings.Appearance switch
        {
            Appearance.Light => ElementTheme.Light,
            Appearance.Dark => ElementTheme.Dark,
            _ => ElementTheme.Default,
        };
        var dark = Root.ActualTheme == ElementTheme.Dark;
        var bar = AppWindow.TitleBar;
        bar.ButtonBackgroundColor = Colors.Transparent;
        bar.ButtonInactiveBackgroundColor = Colors.Transparent;
        bar.ButtonForegroundColor = dark ? Colors.White : Colors.Black;
        bar.ButtonHoverBackgroundColor = dark ? Windows.UI.Color.FromArgb(0x20, 0xFF, 0xFF, 0xFF) : Windows.UI.Color.FromArgb(0x14, 0, 0, 0);
        bar.ButtonHoverForegroundColor = bar.ButtonForegroundColor;
    }

    private void ApplyLanguage()
    {
        var s = Host.Strings;
        Title = s["appName"];
        TitleText.Text = s["appName"];
        SplashText.Text = s["checkingSession"];
        Root.FlowDirection = s.IsRightToLeft ? FlowDirection.RightToLeft : FlowDirection.LeftToRight;
        var font = (FontFamily)Application.Current.Resources[s.Language == Core.Localization.Language.Fa ? "PersianFont" : "LatinFont"];
        RootFrame.FontFamily = font;
        TitleText.FontFamily = font;
        UpdateInsets();
    }

    /// <summary>
    /// Keeps our title-bar content clear of the system caption buttons, which
    /// stay on the physical right even when the layout runs right to left.
    /// </summary>
    private void UpdateInsets()
    {
        var bar = AppWindow.TitleBar;
        var scale = Root.XamlRoot?.RasterizationScale ?? DpiScale();
        if (!(scale > 0)) scale = 1;
        // Windows 10 reports odd insets while the window is minimized or being restored.
        static double Safe(double v) => double.IsFinite(v) && v > 0 ? v : 0;
        var left = Safe(bar.LeftInset / scale);
        var right = Safe(bar.RightInset / scale);
        var rtl = Root.FlowDirection == FlowDirection.RightToLeft;
        StartInset.Width = new GridLength(rtl ? right : left);
        EndInset.Width = new GridLength(rtl ? left : right);
    }

    private static void Guard(string what, Action action)
    {
        try
        {
            action();
        }
        catch (Exception e)
        {
            Log.Error(what, e);
        }
    }

    private void OnClosing(AppWindow sender, AppWindowClosingEventArgs e)
    {
        SaveBounds();
        if (App.Current.Quitting) return;
        e.Cancel = true;
        if (Host.Settings.CloseToTray) AppWindow.Hide();
        else App.Current.Quit();
    }

    private void RestoreBounds()
    {
        var saved = Host.Settings.Window;
        var area = DisplayArea.GetFromWindowId(AppWindow.Id, DisplayAreaFallback.Primary).WorkArea;
        if (saved is { Width: > 200, Height: > 200 } && OnSomeScreen(saved))
        {
            AppWindow.MoveAndResize(new RectInt32(saved.X, saved.Y, saved.Width, saved.Height));
            if (saved.Maximized && AppWindow.Presenter is OverlappedPresenter p) p.Maximize();
            return;
        }
        var w = Math.Min(Scale(1240), area.Width);
        var h = Math.Min(Scale(800), area.Height);
        AppWindow.MoveAndResize(new RectInt32(area.X + (area.Width - w) / 2, area.Y + (area.Height - h) / 2, w, h));
    }

    private static bool OnSomeScreen(WindowBounds b)
    {
        var area = DisplayArea.GetFromRect(new RectInt32(b.X, b.Y, b.Width, b.Height), DisplayAreaFallback.None);
        return area is not null;
    }

    private void SaveBounds()
    {
        if (AppWindow.Presenter is not OverlappedPresenter p || p.State == OverlappedPresenterState.Minimized) return;
        var maximized = p.State == OverlappedPresenterState.Maximized;
        // A maximized window reports the screen's size; keep the last normal bounds instead.
        var keep = maximized && Host.Settings.Window is { } old
            ? old with { Maximized = true }
            : new WindowBounds(AppWindow.Position.X, AppWindow.Position.Y, AppWindow.Size.Width, AppWindow.Size.Height, maximized);
        Host.Settings.Window = keep;
        Host.Settings.Save();
    }

    private int Scale(int dip) => (int)(dip * DpiScale());

    private double DpiScale()
    {
        var hwnd = Win32Interop.GetWindowFromWindowId(AppWindow.Id);
        var dpi = GetDpiForWindow(hwnd);
        return dpi > 0 ? dpi / 96.0 : 1.0;
    }

    [DllImport("user32.dll")]
    private static extern uint GetDpiForWindow(IntPtr hwnd);
}
