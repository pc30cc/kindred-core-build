using Microsoft.UI;
using Microsoft.UI.Windowing;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Webyar.App.Services;
using Windows.Graphics;

namespace Webyar.App.Views;

/// <summary>
/// A call taken out of its page into a window of its own, as the Mac's call
/// window: dark, 420×560 for a voice call and 960×640 for video, full screen
/// and keep-on-top from the page's corner buttons, and wider while the notes
/// are open beside a voice call. Its close button puts the call back into its
/// page — only an ended call closes it for good. The call itself is
/// <see cref="LiveCall"/>; this window only holds its media page.
/// </summary>
public sealed partial class CallWindow : Window
{
    private static readonly Windows.UI.Color Dark = Windows.UI.Color.FromArgb(255, 0x0C, 0x0E, 0x14);

    private readonly LiveCall _call;
    private readonly bool _video;
    private bool _onTop;
    private bool _quiet;
    private int? _narrowWidth;

    internal CallWindow(LiveCall call, CallSurface surface, bool video, string name, bool onTop)
    {
        _call = call;
        _video = video;
        _onTop = onTop;
        var s = App.Current.Host.Strings;
        Title = $"{name} — {s[video ? "videoCall" : "voiceCall"]}";
        Content = new Grid
        {
            Background = new SolidColorBrush(Dark),
            Children = { surface.View },
        };
        try
        {
            AppWindow.SetIcon(AppPaths.WindowIcon);
        }
        catch (Exception e)
        {
            Log.Error("call icon", e);
        }
        var bar = AppWindow.TitleBar;
        bar.BackgroundColor = Dark;
        bar.ForegroundColor = Colors.White;
        bar.ButtonBackgroundColor = Dark;
        bar.ButtonForegroundColor = Colors.White;
        bar.InactiveBackgroundColor = Dark;
        bar.ButtonInactiveBackgroundColor = Dark;
        AppWindow.Resize(new SizeInt32(Scale(video ? 960 : 420), Scale(video ? 640 : 560)));
        ApplyOnTop();
        // Windowing fails fast if one of its callbacks throws, so nothing may escape these.
        AppWindow.Closing += (_, e) =>
        {
            if (_quiet) return;
            try
            {
                e.Cancel = !_call.WindowClosing();
            }
            catch (Exception ex)
            {
                Log.Error("call window closing", ex);
            }
        };
        AppWindow.Changed += (_, e) =>
        {
            if (!e.DidPresenterChange) return;
            try
            {
                if (!IsFullScreen) ApplyOnTop();
                _call.PostWindowState();
            }
            catch (Exception ex)
            {
                Log.Error("call presenter", ex);
            }
        };
    }

    public bool IsFullScreen => AppWindow.Presenter.Kind == AppWindowPresenterKind.FullScreen;

    /// <summary>Back to the call: the window to the front, restored if it was minimised.</summary>
    public void BringToFront()
    {
        try
        {
            if (AppWindow.Presenter is OverlappedPresenter { State: OverlappedPresenterState.Minimized } p) p.Restore();
            AppWindow.Show();
        }
        catch (Exception e)
        {
            Log.Error("call to front", e);
        }
        Activate();
    }

    public void SetFullScreen(bool on)
    {
        try
        {
            AppWindow.SetPresenter(on ? AppWindowPresenterKind.FullScreen : AppWindowPresenterKind.Overlapped);
            if (!on) ApplyOnTop();
        }
        catch (Exception e)
        {
            Log.Error("call full screen", e);
        }
        _call.PostWindowState();
    }

    public void SetOnTop(bool on)
    {
        _onTop = on;
        ApplyOnTop();
    }

    private void ApplyOnTop()
    {
        if (AppWindow.Presenter is OverlappedPresenter p) p.IsAlwaysOnTop = _onTop;
    }

    /// <summary>A voice call's window is narrow: it widens for the notes and narrows again after, as on the Mac.</summary>
    public void FitSidePanel(bool open)
    {
        try
        {
            if (_video || AppWindow.Presenter is not OverlappedPresenter { State: OverlappedPresenterState.Restored }) return;
            var wide = Scale(780);
            var pos = AppWindow.Position;
            var size = AppWindow.Size;
            if (open)
            {
                if (size.Width >= wide) return;
                _narrowWidth = size.Width;
                AppWindow.MoveAndResize(new RectInt32(pos.X - (wide - size.Width) / 2, pos.Y, wide, size.Height));
            }
            else if (_narrowWidth is { } narrow)
            {
                _narrowWidth = null;
                AppWindow.MoveAndResize(new RectInt32(pos.X + (size.Width - narrow) / 2, pos.Y, narrow, size.Height));
            }
        }
        catch (Exception e)
        {
            Log.Error("call notes size", e);
        }
    }

    /// <summary>No WebView2 runtime on this machine: say so in the window rather than fail silently.</summary>
    public void ShowFatal(string text)
    {
        Content = new Grid
        {
            Background = new SolidColorBrush(Dark),
            Children = { new TextBlock { Text = text, Foreground = new SolidColorBrush(Colors.White), HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center, FontSize = 15 } },
        };
    }

    /// <summary>Closes the window without asking the call (it moved back into its page, or ended).</summary>
    public void CloseQuietly()
    {
        _quiet = true;
        try
        {
            // Out of full screen first, or the screen it had is left behind.
            if (IsFullScreen) AppWindow.SetPresenter(AppWindowPresenterKind.Overlapped);
            Close();
        }
        catch (Exception e)
        {
            // Already closed (the app is quitting).
            Log.Error("call close", e);
        }
    }

    private int Scale(int dip)
    {
        var hwnd = Win32Interop.GetWindowFromWindowId(AppWindow.Id);
        var dpi = GetDpiForWindow(hwnd);
        return (int)(dip * (dpi > 0 ? dpi / 96.0 : 1.0));
    }

    [System.Runtime.InteropServices.DllImport("user32.dll")]
    private static extern uint GetDpiForWindow(IntPtr hwnd);
}
