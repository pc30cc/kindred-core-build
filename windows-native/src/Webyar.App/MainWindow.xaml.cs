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
        // Windows 11: Mica behind the title bar and the navigation pane, as in
        // the inbox apps and the WinUI Gallery. Windows 10 keeps the flat grey.
        if (Microsoft.UI.Composition.SystemBackdrops.MicaController.IsSupported())
        {
            SystemBackdrop = new MicaBackdrop();
            Root.Background = new SolidColorBrush(Colors.Transparent);
        }
        TitleIcon.ImageSource = new BitmapImage(new Uri(AppPaths.Icon));
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
        Activated += (_, e) =>
        {
            IsForeground = e.WindowActivationState != WindowActivationState.Deactivated;
            if (IsForeground) Host.Presence?.NoteInteraction();
        };
        // Any key or click counts as being at the desk (active rather than away), as on the web.
        Root.AddHandler(UIElement.KeyDownEvent, new Microsoft.UI.Xaml.Input.KeyEventHandler((_, _) => Host.Presence?.NoteInteraction()), true);
        Root.AddHandler(UIElement.PointerPressedEvent, new Microsoft.UI.Xaml.Input.PointerEventHandler((_, _) => Host.Presence?.NoteInteraction()), true);
        Host.LanguageChanged += ApplyLanguage;
        Host.Client.Unauthorized += (_, _) => Host.RunOnUi(() => SignedOut());
        _platformTimer.Tick += async (_, _) =>
        {
            await RefreshPlatformQuietlyAsync();
            Host.LogCacheStats();
        };
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
        _platformTimer.Start();

        // Local-first: the last session's inbox is on this PC. Show it now and
        // let the server confirm the session and refresh it in the background,
        // instead of holding a splash through five requests (or forever offline).
        if (Host.Client.HasSession && Host.Settings.SessionUserId is { } owner && await TryEnterFromPcAsync(owner))
        {
            _ = ConfirmSessionAsync(owner);
            return;
        }

        await RefreshPlatformQuietlyAsync();
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

    /// <summary>
    /// Opens the shell straight from the PC's copy — only the copy that
    /// belongs to the account whose session token this is, and only when it
    /// knows the workspace to show. False when there is nothing to show yet.
    /// </summary>
    private async Task<bool> TryEnterFromPcAsync(string owner)
    {
        var started = DateTimeOffset.UtcNow;
        var (user, workspaces) = await Host.RestoreSessionAsync(owner);
        var workspace = workspaces.FirstOrDefault(w => w.Id == Host.Settings.WorkspaceId);
        if (user?.Id != owner || workspace is null) return false;
        Host.User = user;
        Host.Workspaces = workspaces;
        Host.Workspace = workspace;
        await OpenWorkspaceAsync(waitForPlan: false);
        Log.Write($"[startup] shell from the PC's copy in {(DateTimeOffset.UtcNow - started).TotalMilliseconds:0} ms");
        OpenPendingNotification();
        return true;
    }

    /// <summary>
    /// After a launch from the PC's copy: the platform settings, the session
    /// (a 401 signs out through <see cref="ApiClient.Unauthorized"/>), then the
    /// operator and their workspaces, saved for the next launch. Offline, the
    /// copy simply stays on screen and the pollers keep trying.
    /// </summary>
    private async Task ConfirmSessionAsync(string owner)
    {
        await RefreshPlatformQuietlyAsync();
        // Realtime started on the defaults; if Super Admin has it off, stop it now.
        if (!Host.Config.RealtimeEnabled && Host.RealtimeConnected) await Host.StartRealtimeAsync();
        var scope = Host.Scope;
        try
        {
            var user = await Host.Api.CurrentUserAsync();
            if (user.Id != owner)
            {
                // Never shown another account's copy; start over with the right one.
                Log.Write("[startup] session belongs to another account");
                SignedOut();
                return;
            }
            if (Host.Scope != scope) return;
            Host.User = user;
            var fresh = await Host.Api.WorkspacesAsync();
            if (Host.Scope != scope || fresh.Count == 0) return;
            var gone = Host.Workspaces.Where(w => fresh.All(f => f.Id != w.Id)).Select(w => w.Id).ToList();
            Host.Workspaces = fresh;
            if (Host.Local is { } store)
            {
                // Removed from a workspace: its conversations leave this PC too.
                foreach (var id in gone) await store.DeleteWorkspaceAsync(id);
            }
            await Host.SaveSessionAsync();
            if (fresh.FirstOrDefault(w => w.Id == Host.Workspace?.Id) is { } current)
            {
                Host.Workspace = current;
                Host.RunOnUi(() => Shell?.RefreshWorkspaces());
            }
            else
            {
                await SwitchWorkspaceAsync(fresh[0]);
            }
        }
        catch (ApiException e) when (e.Failure == ApiFailure.Unauthorized)
        {
            // The Unauthorized event has already started the sign-out.
        }
        catch (Exception e)
        {
            Log.Error("confirm session", e);
        }
    }

    /// <summary>After a sign-in or a restored session: pick the workspace and open the shell.</summary>
    public async Task EnterAsync()
    {
        if (Host.User is { } user) await Host.AttachAccountAsync(user);
        try
        {
            Host.Workspaces = await Host.Api.WorkspacesAsync();
            Log.Write($"workspaces: {Host.Workspaces.Count}");
        }
        catch (ApiException e) when (e.Failure != ApiFailure.Unauthorized)
        {
            Log.Error("workspaces", e);
            // Offline: the workspaces this PC knew for this account.
            if (Host.Workspaces.Count == 0 && Host.Local is { } store) Host.Workspaces = (await store.LoadSessionAsync()).Workspaces;
        }
        Host.Workspace = Host.Workspaces.FirstOrDefault(w => w.Id == Host.Settings.WorkspaceId) ?? Host.Workspaces.FirstOrDefault()
            ?? (Host.Settings.WorkspaceId is { } id ? new Workspace(id, string.Empty) : null);
        if (Host.Workspace is not null && Host.Workspace.Id != Host.Settings.WorkspaceId)
        {
            Host.Settings.WorkspaceId = Host.Workspace.Id;
            Host.Settings.Save();
        }
        await Host.SaveSessionAsync();
        await OpenWorkspaceAsync();
        OpenPendingNotification();
    }

    private void OpenPendingNotification()
    {
        if (_pendingOpen is { } open)
        {
            _pendingOpen = null;
            OpenFromNotification(open);
        }
    }

    /// <summary>
    /// Starts the chosen workspace: its plan first (briefly, so the rail does
    /// not show and then hide sections), then realtime, presence and the shell.
    /// From the PC's copy the plan is not waited for: gated sections appear
    /// when it arrives, they never disappear.
    /// </summary>
    private async Task OpenWorkspaceAsync(bool waitForPlan = true)
    {
        // Whatever the last workspace still had in flight is disowned first.
        Host.BeginWorkspaceScope();
        Host.ResetPlan();
        // The plan this PC last saw for the workspace first; the server's answer replaces it.
        await Host.RestorePlanAsync();
        var plan = Host.LoadPlanAsync();
        if (waitForPlan && Host.Plan.State == PlanState.Loading) await Task.WhenAny(plan, Task.Delay(TimeSpan.FromSeconds(5)));
        await Host.StartRealtimeAsync();
        var presence = Host.StartPresenceAsync();
        Splash.Visibility = Visibility.Collapsed;
        RootFrame.Navigate(typeof(ShellPage));
        Host.Engagement.Start();
        Host.Engagement.Refresh();
        await presence;
    }

    /// <summary>Moves to another of the operator's workspaces, as the web's workspace menu does.</summary>
    public async Task SwitchWorkspaceAsync(Workspace workspace)
    {
        if (workspace.Id == Host.Workspace?.Id) return;
        // A call belongs to the workspace it started in.
        await CallWindow.EndForQuitAsync(TimeSpan.FromSeconds(2));
        // Cancel the old workspace's work, switch scope, then draw the new one from the PC and sync.
        Shell?.Teardown();
        Host.StopPresence();
        Host.Workspace = workspace;
        Host.Settings.WorkspaceId = workspace.Id;
        Host.Settings.Save();
        App.Current.SetUnread(0);
        Splash.Visibility = Visibility.Visible;
        await OpenWorkspaceAsync();
        RootFrame.BackStack.Clear();
    }

    public void ShowLogin()
    {
        Splash.Visibility = Visibility.Collapsed;
        App.Current.SetUnread(0);
        RootFrame.Navigate(typeof(LoginPage));
        RootFrame.BackStack.Clear();
    }

    private bool _signingOut;
    private string? _forgetAccount;

    /// <summary>
    /// The server no longer knows this session, or the operator signed out.
    ///
    /// What happens to the PC's copy: every view is torn down and every
    /// memory cache emptied before the sign-in page shows, so the next person
    /// at this PC sees nothing of this operator, not even for a frame. The
    /// conversation file itself is deleted when the operator signed out
    /// (<paramref name="forgetAccount"/>); after a lapsed session it is kept
    /// and reopened only if the same account signs in again. Downloaded
    /// files stay (per workspace, and only ever looked up by ids the server
    /// hands a signed-in member); Clear cache removes them.
    /// </summary>
    public async void SignedOut(string? forgetAccount = null)
    {
        if (forgetAccount is not null) _forgetAccount = forgetAccount;
        if (_signingOut) return;
        if (RootFrame.Content is LoginPage)
        {
            ForgetAccountData();
            return;
        }
        _signingOut = true;
        try
        {
            // Nothing would be left on screen to hang up with, and the microphone would stay live.
            _ = CallWindow.EndForQuitAsync(TimeSpan.Zero);
            Shell?.Teardown();
            Host.User = null;
            Host.Account = null;
            Host.StopPresence();
            // No workspace while signed out (the next sign-in picks it again from the
            // settings), so this only stops the old channel instead of reopening it.
            Host.Workspace = null;
            await Host.StartRealtimeAsync();
            if (_forgetAccount is null)
            {
                // A lapsed session: its token is dead, and the next launch must not show this copy before a sign-in.
                Host.Client.DiscardSession();
            }
            Host.Settings.SessionUserId = null;
            Host.Settings.Save();
            await Host.DetachAccountAsync(deleteData: false);
            ForgetAccountData();
            _ = Task.Run(OpenedFiles.Clear);
            ShowLogin();
        }
        finally
        {
            _signingOut = false;
        }
    }

    private void ForgetAccountData()
    {
        if (_forgetAccount is not { } owner || Host.Local?.Owner == owner) return;
        _forgetAccount = null;
        Core.Local.LocalStore.DeleteFiles(AppPaths.LocalData, owner);
        Log.Write("[store] account data deleted on sign-out");
    }

    public void OpenFromNotification(IReadOnlyDictionary<string, string> args)
    {
        // A notice from another workspace opens there, not under the one on show now.
        if (Shell is not null && args.TryGetValue("workspace", out var wsId) && wsId.Length > 0 && wsId != Host.Workspace?.Id)
        {
            if (Host.Workspaces.FirstOrDefault(w => w.Id == wsId) is not { } target) return;
            _ = OpenInWorkspaceAsync(target, args);
            return;
        }
        if (args.TryGetValue("page", out var page) && !args.ContainsKey("conversation"))
        {
            if (Shell is not { } sh) _pendingOpen = args;
            else if (page == "calls" && args.TryGetValue("call", out var call)) sh.OpenCall(call);
            else sh.OpenPage(page);
            return;
        }
        if (!args.TryGetValue("conversation", out var id)) return;
        if (Shell is { } shell) shell.OpenConversation(id);
        else _pendingOpen = args;
    }

    private async Task OpenInWorkspaceAsync(Workspace target, IReadOnlyDictionary<string, string> args)
    {
        try
        {
            await SwitchWorkspaceAsync(target);
        }
        catch (Exception e)
        {
            Log.Error("switch workspace from notification", e);
            return;
        }
        if (Host.Workspace?.Id == target.Id) OpenFromNotification(args);
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
        Helpers.Palette.SetTheme(Root.ActualTheme);
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
        // Menus, flyouts and tooltips live outside the frame's tree; the theme
        // font resource reaches them (and every control created from now on).
        Application.Current.Resources["ContentControlThemeFontFamily"] = font;
        UpdateInsets();
    }

    /// <summary>
    /// Keeps our title-bar content clear of the system caption buttons, which
    /// stay on the physical right even when the rest of the layout runs right to left.
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
        // The title bar itself never flips (see MainWindow.xaml), so the insets are physical.
        StartInset.Width = new GridLength(left);
        EndInset.Width = new GridLength(right);
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
