using System.Text.Json;
using Microsoft.UI;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.Web.WebView2.Core;
using Webyar.App.Services;

namespace Webyar.App.Views;

/// <summary>
/// One copy of the call's media page (Assets/Call/call.html, LiveKit) in a
/// WebView2: inside the main window while the call is docked in its page, or
/// filling the call's own window. The media lives in the page, so moving the
/// call between the two means this page leaves the room and a new one joins
/// it — a second or two of silence, and the call goes on.
/// </summary>
internal sealed class CallSurface
{
    private readonly TaskCompletionSource _detached = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private bool _ready;
    private bool _closed;

    public CallSurface(bool docked)
    {
        Docked = docked;
        // The panel's rounded card is drawn by the page; around it the page shows through.
        if (docked) View.DefaultBackgroundColor = Colors.Transparent;
        View.FlowDirection = FlowDirection.LeftToRight;
    }

    public WebView2 View { get; } = new();

    /// <summary>In the page (the docked panel) rather than a window of its own.</summary>
    public bool Docked { get; }

    /// <summary>The page has loaded LiveKit and listens.</summary>
    public bool IsReady => _ready;

    /// <summary>A message from the page: its type, and the whole message.</summary>
    public event Action<CallSurface, string, JsonElement>? Message;

    /// <summary>The page asked for a height (the docked panel follows its content).</summary>
    public event Action<CallSurface, double>? HeightWanted;

    public async Task StartAsync()
    {
        await View.EnsureCoreWebView2Async();
        var core = View.CoreWebView2;
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
        core.WebMessageReceived += OnWebMessage;
        core.Navigate(Docked ? "https://webyar.app/Call/call.html?docked=1" : "https://webyar.app/Call/call.html");
    }

    private void OnWebMessage(CoreWebView2 sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        try
        {
            using var doc = JsonDocument.Parse(e.TryGetWebMessageAsString());
            var root = doc.RootElement;
            var type = root.GetProperty("type").GetString() ?? string.Empty;
            switch (type)
            {
                case "ready":
                    _ready = true;
                    break;
                case "detached":
                    _detached.TrySetResult();
                    return;
                case "height":
                    if (root.TryGetProperty("h", out var h) && h.TryGetDouble(out var height)) HeightWanted?.Invoke(this, height);
                    return;
            }
            if (_closed && type != "log") return;
            Message?.Invoke(this, type, root);
        }
        catch (Exception ex)
        {
            Log.Error("call message", ex);
        }
    }

    public void Post(object message)
    {
        try
        {
            if (_ready && !_closed) View.CoreWebView2?.PostWebMessageAsString(JsonSerializer.Serialize(message));
        }
        catch (Exception e)
        {
            Log.Error("call post", e);
        }
    }

    /// <summary>
    /// Leaves the room without ending the call (the other copy of the page is
    /// about to join it), and says when it is out — or after three seconds.
    /// </summary>
    public Task DetachAsync()
    {
        if (!_ready || _closed) _detached.TrySetResult();
        else Post(new { type = "detach" });
        _closed = true;
        return Task.WhenAny(_detached.Task, Task.Delay(3000));
    }

    /// <summary>Stops the page for good; its microphone and camera are let go.</summary>
    public void Close()
    {
        _closed = true;
        _detached.TrySetResult();
        try
        {
            View.Close();
        }
        catch (Exception e)
        {
            Log.Error("call surface close", e);
        }
    }
}
