using H.NotifyIcon;
using Microsoft.UI.Dispatching;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media.Imaging;
using CommunityToolkit.Mvvm.Input;
using Webyar.App.Services;

namespace Webyar.App;

public partial class App : Application
{
    private readonly bool _startHidden;
    private MainWindow? _window;
    private TaskbarIcon? _tray;
    private MenuFlyoutItem? _trayCalls;
    private bool _trayRinging;
    private bool _quitting;

    public App(bool startHidden)
    {
        _startHidden = startHidden;
        InitializeComponent();
        Host = new AppHost(DispatcherQueue.GetForCurrentThread());
        UnhandledException += (_, e) =>
        {
            Log.Error("unhandled", e.Exception);
            e.Handled = true;
        };
        AppDomain.CurrentDomain.UnhandledException += (_, e) =>
        {
            if (e.ExceptionObject is Exception ex) Log.Error("fatal", ex);
        };
        TaskScheduler.UnobservedTaskException += (_, e) =>
        {
            Log.Error("unobserved task", e.Exception);
            e.SetObserved();
        };
    }

    public static new App Current => (App)Application.Current;

    public AppHost Host { get; }

    public MainWindow? Window => _window;

    /// <summary>True while the app is really quitting, so close-to-tray lets the window go.</summary>
    public bool Quitting => _quitting;

    protected override void OnLaunched(LaunchActivatedEventArgs args)
    {
        Log.Write($"launch {Host.Updates.CurrentVersion}");
        _ = Task.Run(() =>
        {
            FileCache.Trim();
            AvatarImages.Trim();
        });
        Host.Notifier.Invoked += OpenFromNotification;
        Host.Notifier.Register();

        _window = new MainWindow();
        CreateTray();
        AppDomain.CurrentDomain.ProcessExit += (_, _) => _tray?.Dispose();
        ListenForSecondLaunch();

        if (!_startHidden) _window.Activate();
        _ = _window.StartAsync(Notifier.LaunchArguments());
    }

    public void ShowWindow()
    {
        if (_window is null) return;
        _window.AppWindow.Show();
        _window.Activate();
    }

    /// <summary>Velopack is about to quit and restart us: let the window close and the tray icon go.</summary>
    public void PrepareForUpdate()
    {
        _quitting = true;
        _tray?.Dispose();
        _tray = null;
    }

    public void Quit() => _ = QuitAsync();

    private async Task QuitAsync()
    {
        if (_quitting) return;
        _quitting = true;
        // A call ends properly rather than just vanishing; the hang-up gets a moment to reach the server.
        try
        {
            await Views.LiveCall.EndForQuitAsync(TimeSpan.FromSeconds(2));
        }
        catch (Exception e)
        {
            Log.Error("hang up on quit", e);
        }
        Host.Updates.ApplyOnExit();
        _tray?.Dispose();
        _window?.Close();
        Exit();
    }

    private void OpenFromNotification(IReadOnlyDictionary<string, string> args) =>
        Host.RunOnUi(() =>
        {
            ShowWindow();
            _window?.OpenFromNotification(args);
        });

    /// <summary>A second launch signals this event instead of starting another copy.</summary>
    private void ListenForSecondLaunch()
    {
        var activate = new EventWaitHandle(false, EventResetMode.AutoReset, Program.ActivateEventName);
        var thread = new Thread(() =>
        {
            while (activate.WaitOne()) Host.RunOnUi(ShowWindow);
        })
        { IsBackground = true, Name = "second-launch" };
        thread.Start();
    }

    private void CreateTray()
    {
        var s = Host.Strings;
        var menu = new MenuFlyout();
        var open = new MenuFlyoutItem { Text = s["trayOpen"] };
        open.Click += (_, _) => ShowWindow();
        var quit = new MenuFlyoutItem { Text = s["trayQuit"] };
        quit.Click += (_, _) => Quit();
        menu.Items.Add(open);
        // While the plan has the call center: how many calls wait, and the desk one click away (the Mac's menu bar).
        _trayCalls = new MenuFlyoutItem { Text = s.Get("menuWaitingCalls", "count", 0), Visibility = Visibility.Collapsed };
        _trayCalls.Click += (_, _) =>
        {
            ShowWindow();
            _window?.Shell?.OpenPage("calls");
        };
        menu.Items.Add(_trayCalls);
        menu.Items.Add(new MenuFlyoutSeparator());
        menu.Items.Add(quit);

        _tray = new TaskbarIcon
        {
            // A fixed identity: Windows then keeps one tray entry for the app and
            // reuses it after a crash, a forced close or an update restart, instead
            // of stacking a new icon beside the dead one each launch.
            Id = TrayId(),
            ToolTipText = s["appName"],
            // The tray needs a real .ico (BMP frames); H.NotifyIcon cannot turn a PNG into one.
            IconSource = new BitmapImage(new Uri(AppPaths.WindowIcon)),
            ContextFlyout = menu,
            ContextMenuMode = ContextMenuMode.SecondWindow,
            LeftClickCommand = new RelayCommand(ShowWindow),
            NoLeftClickDelay = true,
        };
        _tray.ForceCreate();
    }

    /// <summary>
    /// Stable per install location: the shell binds a tray GUID to one exe path,
    /// so the installed app and a dev build each get their own.
    /// </summary>
    private static Guid TrayId()
    {
        var path = (Environment.ProcessPath ?? "Webyar").ToLowerInvariant();
        var hash = System.Security.Cryptography.MD5.HashData(System.Text.Encoding.UTF8.GetBytes("webyar-tray:" + path));
        return new Guid(hash);
    }

    /// <summary>The tray menu's waiting-calls line; hidden while the workspace has no call center (or no one is signed in).</summary>
    public void SetWaitingCalls(int count, bool callCenter)
    {
        if (_trayCalls is null) return;
        _trayCalls.Text = Host.Strings.Get("menuWaitingCalls", "count", count);
        _trayCalls.Visibility = callCenter ? Visibility.Visible : Visibility.Collapsed;
        // While calls wait, the tray icon carries a red phone, as the Mac's menu bar icon turns into one.
        var ringing = callCenter && count > 0;
        if (_tray is null || ringing == _trayRinging) return;
        _trayRinging = ringing;
        try
        {
            _tray.IconSource = new BitmapImage(new Uri(ringing ? AppPaths.CallsWaitingIcon : AppPaths.WindowIcon));
        }
        catch (Exception e)
        {
            Log.Error("tray icon", e);
        }
    }

    /// <summary>The tray tooltip carries the unread count, like the taskbar badge in the old app.</summary>
    public void SetUnread(int count)
    {
        if (_tray is null) return;
        _tray.ToolTipText = count > 0 ? $"{Host.Strings["appName"]} — {Webyar.Core.Localization.Digits.Localize(count.ToString(), Host.Strings.Language)}" : Host.Strings["appName"];
    }
}
