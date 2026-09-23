using System.Text.Json;
using Microsoft.UI;
using Microsoft.UI.Windowing;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Microsoft.Web.WebView2.Core;
using Webyar.App.Helpers;
using Webyar.App.Services;
using Webyar.Core.Api;
using Webyar.Core.Inbox;
using Windows.Graphics;

namespace Webyar.App.Views;

/// <summary>
/// A call with a visitor, in its own window. An operator never dials a visitor
/// directly: the invitation is the offer, the widget accepts it, and only then
/// does a room exist — so this waits on the invitation, then joins the room
/// with the token the web console would get. The media runs in a WebView2
/// page (Assets/Call/call.html) with the same LiveKit SDK as the web console.
/// </summary>
public sealed partial class CallWindow : Window
{
    private static CallWindow? _current;

    private readonly Conversation _conversation;
    private readonly string _workspaceId;
    private readonly string _channel;
    private readonly string _name;
    private readonly WebView2 _web = new();
    private readonly CancellationTokenSource _stop = new();
    private CallInvitation? _invitation;
    private string? _sessionId;
    private bool _ended;
    private bool _ready;

    private CallWindow(Conversation c, string workspaceId, string channel, string name)
    {
        _conversation = c;
        _workspaceId = workspaceId;
        _channel = channel;
        _name = name;
        var s = Host.Strings;
        Title = $"{name} — {s[channel == "video" ? "videoCall" : "voiceCall"]}";
        Content = new Grid
        {
            Background = new SolidColorBrush(Windows.UI.Color.FromArgb(255, 0x0C, 0x0E, 0x14)),
            Children = { _web },
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
        bar.BackgroundColor = Windows.UI.Color.FromArgb(255, 0x0C, 0x0E, 0x14);
        bar.ForegroundColor = Colors.White;
        bar.ButtonBackgroundColor = bar.BackgroundColor;
        bar.ButtonForegroundColor = Colors.White;
        bar.InactiveBackgroundColor = bar.BackgroundColor;
        bar.ButtonInactiveBackgroundColor = bar.BackgroundColor;
        var video = channel == "video";
        AppWindow.Resize(new SizeInt32(Scale(video ? 960 : 420), Scale(video ? 640 : 560)));
        AppWindow.Closing += (w, e) =>
        {
            if (_ended) return;
            e.Cancel = true;
            _ = FinishAsync("hungUp", null);
        };
    }

    private static AppHost Host => App.Current.Host;

    /// <summary>Starts a call, or brings the one already running to the front.</summary>
    public static void Start(Conversation c, string workspaceId, string channel, string name)
    {
        if (_current is { } running)
        {
            running.Activate();
            return;
        }
        var w = new CallWindow(c, workspaceId, channel, name);
        _current = w;
        w.Closed += (_, _) =>
        {
            if (ReferenceEquals(_current, w)) _current = null;
        };
        w.Activate();
        _ = w.RunAsync();
    }

    private async Task RunAsync()
    {
        var s = Host.Strings;
        try
        {
            await _web.EnsureCoreWebView2Async();
            var core = _web.CoreWebView2;
            core.Settings.AreDevToolsEnabled = false;
            core.Settings.AreDefaultContextMenusEnabled = false;
            core.Settings.IsStatusBarEnabled = false;
            // A real https origin: getUserMedia needs a secure context.
            core.SetVirtualHostNameToFolderMapping("webyar.app", Path.Combine(AppContext.BaseDirectory, "Assets"), CoreWebView2HostResourceAccessKind.Allow);
            core.PermissionRequested += (_, e) =>
            {
                if (e.PermissionKind is CoreWebView2PermissionKind.Microphone or CoreWebView2PermissionKind.Camera or CoreWebView2PermissionKind.Autoplay)
                    e.State = CoreWebView2PermissionState.Allow;
            };
            core.WebMessageReceived += OnPageMessage;
            core.Navigate("https://webyar.app/Call/call.html");
        }
        catch (Exception e)
        {
            // No WebView2 runtime on this machine: say so rather than fail silently.
            Log.Error("call webview", e);
            ShowFatal(s["callFailed"]);
            return;
        }

        try
        {
            _invitation = await Host.Api.InviteToCallAsync(_conversation.Id, _workspaceId, _channel, _stop.Token);
            Log.Write($"[call] invited {_invitation.Id} {_channel}");
            // Two seconds for as long as the invitation lives — cheaper than a realtime channel for one wait.
            while (!_stop.IsCancellationRequested)
            {
                var inv = await Host.Api.InvitationAsync(_invitation.Id, _stop.Token);
                if (inv.CallSessionId is { } session && inv.Status == "joined")
                {
                    _sessionId = session;
                    await JoinAsync(session);
                    return;
                }
                if (inv.Status is "expired" or "cancelled" or "declined")
                {
                    await FinishAsync(inv.Status == "declined" ? "declined" : "expired", null);
                    return;
                }
                await Task.Delay(2000, _stop.Token);
            }
        }
        catch (OperationCanceledException)
        {
        }
        catch (Exception e)
        {
            Log.Error("call invite", e);
            await FinishAsync("failed", e.Message);
        }
    }

    private async Task JoinAsync(string sessionId)
    {
        var s = Host.Strings;
        Post(new { type = "status", text = s["connectingCall"] });
        var name = Host.User?.FullName is { Length: > 0 } n ? n : Host.User?.Email;
        var token = await Host.Api.CallTokenAsync(sessionId, name, _stop.Token);
        var url = token.WsUrl ?? token.RtcUrl;
        if (string.IsNullOrEmpty(url))
        {
            await FinishAsync("failed", "no_server_url");
            return;
        }
        if (token.Warnings?.Contains("turn_missing") == true) Post(new { type = "warn", text = s["callRelayWarning"] });
        object[] ice = token.Turn?.Urls is { Count: > 0 } urls
            ? [new { urls, username = token.Turn.Username ?? string.Empty, credential = token.Turn.Credential ?? string.Empty }]
            : [];
        // The page may still be loading LiveKit; it asks for the join once it is ready.
        _join = new { type = "join", url, token = token.Token, ice, relay = token.IcePolicy == "relay", channel = _channel };
        if (_ready) Post(_join);
    }

    private object? _join;

    private void OnPageMessage(CoreWebView2 sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        try
        {
            using var doc = JsonDocument.Parse(e.TryGetWebMessageAsString());
            var root = doc.RootElement;
            switch (root.GetProperty("type").GetString())
            {
                case "ready":
                    _ready = true;
                    SendInit();
                    if (_join is not null) Post(_join);
                    break;
                case "connected":
                    Log.Write($"[call] connected {_sessionId}");
                    break;
                case "degraded":
                    var what = root.GetProperty("what").GetString();
                    Post(new { type = "warn", text = Host.Strings[what == "noCamera" ? "callNoCamera" : "callNoMicrophone"] });
                    break;
                case "ended":
                    var reason = root.GetProperty("reason").GetString() ?? "hungUp";
                    var detail = root.TryGetProperty("detail", out var d) && d.ValueKind == JsonValueKind.String ? d.GetString() : null;
                    _ = FinishAsync(reason, detail);
                    break;
                case "log":
                    Log.Write("[call] " + root.GetProperty("text").GetString());
                    break;
            }
        }
        catch (Exception ex)
        {
            Log.Error("call message", ex);
        }
    }

    private void SendInit()
    {
        var s = Host.Strings;
        var color = Palette.AvatarColor(_name);
        Post(new
        {
            type = "init",
            rtl = s.IsRightToLeft,
            name = _name,
            initials = Display.Initials(_name),
            color = $"#{color.R:X2}{color.G:X2}{color.B:X2}",
            channel = _channel,
            status = s["callWaiting"],
            strings = new { mute = s["mute"], camera = s["camera"], hangUp = s["hangUpCall"] },
        });
    }

    private async Task FinishAsync(string outcome, string? detail)
    {
        if (_ended) return;
        _ended = true;
        _stop.Cancel();
        Log.Write($"[call] ended {outcome} {detail}");
        var s = Host.Strings;
        var text = outcome switch
        {
            "declined" => s["callDeclined"],
            "expired" => s["callNoAnswer"],
            "failed" => s["callFailed"],
            _ => s["callEnded"],
        };
        Post(new { type = "hangup" });
        Post(new { type = "status", text, ended = true });
        // Ending is idempotent server-side, so a race with the visitor's own hang-up is harmless.
        try
        {
            if (_sessionId is not null) await Host.Api.HangUpAsync(_sessionId);
            else if (_invitation is not null) await Host.Api.CancelInvitationAsync(_invitation.Id);
        }
        catch (Exception e)
        {
            Log.Error("call hang up", e);
        }
        // An ended call says why for a moment, then gets out of the way.
        await Task.Delay(outcome == "failed" ? 4000 : 1800);
        Close();
    }

    private void ShowFatal(string text)
    {
        _ended = true;
        Content = new Grid
        {
            Background = new SolidColorBrush(Windows.UI.Color.FromArgb(255, 0x0C, 0x0E, 0x14)),
            Children = { new TextBlock { Text = text, Foreground = new SolidColorBrush(Colors.White), HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center, FontSize = 15 } },
        };
    }

    private void Post(object message)
    {
        try
        {
            if (_ready) _web.CoreWebView2?.PostWebMessageAsString(JsonSerializer.Serialize(message));
        }
        catch (Exception e)
        {
            Log.Error("call post", e);
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
