using Microsoft.UI;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Media.Animation;
using Webyar.App.Helpers;
using Webyar.App.Services;
using Webyar.Core.Api;
using Webyar.Core.Calls;
using Webyar.Core.Inbox;

namespace Webyar.App.Views;

/// <summary>
/// The shell's call surfaces beyond the ringing card, as on the Mac: the card
/// for a call a colleague handed to this operator, the layer the docked call is
/// drawn on, the call bar at the foot of the sidebar while the call's page is
/// not on screen (mute, back to it, out into a window, hang up or leave), the
/// waiting count in the tray, and the ring spreading from a ringing caller's face.
/// </summary>
public sealed partial class ShellPage
{
    private readonly HandedCalls _handed = new();
    private bool _joiningHanded;
    private string? _handedError;
    private Microsoft.UI.Dispatching.DispatcherQueueTimer? _callClock;
    private Storyboard? _pulse;

    private static readonly SolidColorBrush CallLive = new(Windows.UI.Color.FromArgb(255, 0x3D, 0xD6, 0x8C));
    private static readonly SolidColorBrush CallQuiet = new(Windows.UI.Color.FromArgb(255, 0x98, 0xA2, 0xB3));
    private static readonly SolidColorBrush CallDanger = new(Windows.UI.Color.FromArgb(255, 0xE5, 0x48, 0x4D));
    private static readonly SolidColorBrush CallWarning = new(Windows.UI.Color.FromArgb(255, 0xF7, 0x6B, 0x15));

    private void StartCalls()
    {
        CallDock.SetLayer(CallLayer);
        LiveCall.Changed += OnCallChanged;
        CallDock.Changed += RenderActiveCall;
        Nav.PaneOpened += OnPaneChanged;
        Nav.PaneClosed += OnPaneChanged;
        Host.Callers.Changed += OnCallerProfiles;
        RenderActiveCall();
        RenderHanded();
    }

    private void OnCallChanged()
    {
        CallDock.Place();
        RenderActiveCall();
    }

    private void OnPaneChanged(NavigationView sender, object args) => RenderActiveCall();

    private void StopCalls()
    {
        LiveCall.Changed -= OnCallChanged;
        CallDock.Changed -= RenderActiveCall;
        Nav.PaneOpened -= OnPaneChanged;
        Nav.PaneClosed -= OnPaneChanged;
        Host.Callers.Changed -= OnCallerProfiles;
        CallDock.SetLayer(null);
        _callClock?.Stop();
        ActiveCallBar.Visibility = Visibility.Collapsed;
        ActiveCallRail.Visibility = Visibility.Collapsed;
        // A handed-over call belongs to the workspace (and operator) it came in for.
        _handed.Reset();
        _handedError = null;
        HandedBar.Visibility = Visibility.Collapsed;
        App.Current.SetWaitingCalls(0, false);
        // The desk keeps polling while it is on show; the shell going means it goes too.
        (ContentFrame.Content as CallCenterPage)?.Teardown();
    }

    /// <summary>The tray's "waiting calls" line follows the line and the plan.</summary>
    private void ShowWaitingInTray() =>
        App.Current.SetWaitingCalls(Host.CallQueue?.Queue.Count ?? 0, Host.Plan.CallCenter);

    /// <summary>A caller's face: their name or email, and their device and country from their visitor session.</summary>
    private static void ShowCallerFace(Controls.Avatar avatar, CallSession? call, string? sessionId)
    {
        var profile = Host.Callers.For(call?.VisitorSessionId ?? sessionId);
        avatar.DisplayName = call?.VisitorName;
        avatar.Email = call?.VisitorEmail;
        avatar.Os = profile?.Device?.Os;
        avatar.CountryCode = profile?.Geo?.CountryCode;
    }

    private void OnCallerProfiles()
    {
        if (_ringing is { } r) ShowCallerFace(CallBarAvatar, r.CallSession, r.VisitorSessionId);
        if (_handed.Current is not null) RenderHanded();
    }

    // ── The ring around a ringing caller ──

    private void StartPulse()
    {
        try
        {
            // Windows' "Animation effects" off: no ring, as the Mac honours Reduce Motion.
            if (!new Windows.UI.ViewManagement.UISettings().AnimationsEnabled) return;
            _pulse ??= CreatePulse();
            _pulse.Begin();
        }
        catch (Exception e)
        {
            Log.Error("ring pulse", e);
        }
    }

    private void StopPulse()
    {
        _pulse?.Stop();
        RingPulse.Opacity = 0;
    }

    /// <summary>A ring spreading from the face every 1.2 s, eased out, fading as it grows.</summary>
    private Storyboard CreatePulse()
    {
        var board = new Storyboard { RepeatBehavior = new RepeatBehavior { Type = RepeatBehaviorType.Forever } };
        var duration = new Duration(TimeSpan.FromSeconds(1.2));
        DoubleAnimation Animate(DependencyObject target, string property, double from, double to)
        {
            var a = new DoubleAnimation { From = from, To = to, Duration = duration, EasingFunction = new QuadraticEase { EasingMode = EasingMode.EaseOut } };
            Storyboard.SetTarget(a, target);
            Storyboard.SetTargetProperty(a, property);
            board.Children.Add(a);
            return a;
        }
        Animate(RingPulseScale, "ScaleX", 1, 1.5);
        Animate(RingPulseScale, "ScaleY", 1, 1.5);
        Animate(RingPulse, "Opacity", 0.7, 0);
        return board;
    }

    // ── Calls handed over by a colleague ──

    /// <summary>
    /// The calls under way, every other queue poll. A transfer leaves the call
    /// assigned to this operator and live, with the colleague still in the room
    /// until this operator joins; the banner offers to join it.
    /// </summary>
    private void OnActiveCalls(IReadOnlyList<CallSession> calls)
    {
        var before = _handed.Current;
        var fresh = Host.Plan.CallCenter ? _handed.Notice(calls, Host.User?.Id, LiveCall.ActiveCallId) : null;
        if (fresh is not null)
        {
            Log.Write($"[calls] handed over {fresh.Id}");
            if (Host.Settings.NotificationSound) Chime.Play();
            if (Host.Settings.Notifications && App.Current.Window?.IsForeground != true) _ = AnnounceHandedAsync(fresh);
        }
        if (!ReferenceEquals(before, _handed.Current))
        {
            _handedError = null;
            RenderHanded();
            // The colleague's name, once the workspace's people are known.
            if (_handed.Current is { TransferFromAgentId: { } } && fresh is not null) _ = RenderHandedWithNamesAsync();
        }
    }

    private async Task AnnounceHandedAsync(CallSession call)
    {
        var s = Host.Strings;
        var from = await ColleagueNameAsync(call.TransferFromAgentId);
        Host.Notifier.Show(s["callHandedTitle"],
            from.Length == 0 ? CallNames.Caller(call, call.Id, s) : s.Get("callHandedFrom", "name", from),
            s.IsRightToLeft, silent: true,
            new Dictionary<string, string> { ["page"] = "calls", ["workspace"] = Host.Workspace?.Id ?? string.Empty });
    }

    private static async Task<string> ColleagueNameAsync(string? userId)
    {
        if (string.IsNullOrEmpty(userId)) return string.Empty;
        try
        {
            await Host.MembersAsync();
        }
        catch (Exception e)
        {
            Log.Error("members", e);
        }
        return Host.MemberName(userId);
    }

    private async Task RenderHandedWithNamesAsync()
    {
        await ColleagueNameAsync(_handed.Current?.TransferFromAgentId);
        RenderHanded();
    }

    private void RenderHanded()
    {
        if (_handed.Current is not { } c)
        {
            HandedBar.Visibility = Visibility.Collapsed;
            return;
        }
        var s = Host.Strings;
        ShowCallerFace(HandedAvatar, c, null);
        HandedTitle.Text = s["callHandedTitle"];
        HandedName.Text = CallNames.Caller(c, c.ContactId ?? c.VisitorSessionId ?? c.Id, s);
        var from = c.TransferFromAgentId is { } id ? Host.MemberName(id) : string.Empty;
        HandedMeta.Text = string.Join(" · ", new[] { from.Length > 0 ? s.Get("callHandedFrom", "name", from) : null, c.TransferReason }
            .Where(x => !string.IsNullOrWhiteSpace(x)));
        HandedMeta.Visibility = HandedMeta.Text.Length > 0 ? Visibility.Visible : Visibility.Collapsed;
        HandedError.Text = _handedError ?? string.Empty;
        HandedError.Visibility = _handedError is null ? Visibility.Collapsed : Visibility.Visible;
        HandedClose.Content = s["close"];
        HandedJoinText.Text = s["callJoin"];
        HandedJoinGlyph.Glyph = c.IsVideo ? "" : "";
        HandedJoin.IsEnabled = !_joiningHanded;
        HandedJoinRing.IsActive = _joiningHanded;
        HandedJoinRing.Visibility = _joiningHanded ? Visibility.Visible : Visibility.Collapsed;
        HandedBar.Visibility = Visibility.Visible;
    }

    private void OnHandedClose(object sender, RoutedEventArgs e)
    {
        _handed.Dismiss();
        _handedError = null;
        RenderHanded();
    }

    /// <summary>Joins the handed-over call: the desk's accept gives this operator a token for the same room.</summary>
    private async void OnHandedJoin(object sender, RoutedEventArgs e)
    {
        if (_handed.Current is not { } c || Host.Workspace is not { } ws || _joiningHanded) return;
        var s = Host.Strings;
        if (LiveCall.IsBusy)
        {
            _handedError = s["ccOnCall"];
            RenderHanded();
            return;
        }
        _joiningHanded = true;
        _handedError = null;
        RenderHanded();
        try
        {
            var accept = await Host.Api.AcceptCallAsync(ws.Id, c.Id);
            if (accept.Connect is not { Supported: true })
            {
                _handedError = s["ccAcceptedNoMediaHint"];
            }
            else if (Host.Workspace?.Id == ws.Id)
            {
                _handed.Dismiss();
                LiveCall.StartDesk(c.Id, accept, ws.Id, c.IsVideo ? "video" : "audio", CallNames.Caller(c, c.ContactId ?? c.VisitorSessionId ?? c.Id, s), c);
            }
        }
        catch (Exception ex)
        {
            Log.Error("join handed call", ex);
            _handedError = $"{s["callHandedFailed"]} — {ErrorText.For(ex, s)}";
        }
        finally
        {
            _joiningHanded = false;
            RenderHanded();
        }
    }

    // ── The call bar, while the docked call's page is not on screen ──

    private void RenderActiveCall()
    {
        // As on the Mac: only for a call in its page, and only while that page is not the one on show.
        if (LiveCall.Running is not { } call || call.Shown != LiveCall.Presentation.Docked || CallDock.IsOnScreen)
        {
            ActiveCallBar.Visibility = Visibility.Collapsed;
            ActiveCallRail.Visibility = Visibility.Collapsed;
            _callClock?.Stop();
            return;
        }
        var s = Host.Strings;
        var face = call.Face;
        foreach (var avatar in new[] { ActiveCallAvatar, ActiveCallRailAvatar })
        {
            avatar.DisplayName = face.Name;
            avatar.Email = face.Email;
            avatar.Os = face.Os;
            avatar.CountryCode = face.CountryCode;
            avatar.ImageUrl = face.ImageUrl;
        }
        ActiveCallName.Text = call.Name;
        ActiveCallGlyph.Glyph = call.IsVideo ? "\uE714" : "\uE717";
        var tint = call.IsConnected && call.IsLive ? CallLive : CallQuiet;
        ActiveCallGlyph.Foreground = tint;
        ActiveCallStatus.Foreground = tint;
        ActiveCallStatus.Text = call.StatusText;

        ActiveCallMuteGlyph.Glyph = call.IsMuted ? "\uEC54" : "\uE720";
        if (call.IsMuted)
        {
            ActiveCallMute.Background = new SolidColorBrush(Colors.White);
            ActiveCallMute.Foreground = new SolidColorBrush(Windows.UI.Color.FromArgb(255, 0x0C, 0x0E, 0x14));
        }
        else
        {
            ActiveCallMute.ClearValue(Control.BackgroundProperty);
            ActiveCallMute.ClearValue(Control.ForegroundProperty);
        }
        ActiveCallMute.IsEnabled = call.IsConnected && call.IsLive;
        ToolTipService.SetToolTip(ActiveCallMute, s[call.IsMuted ? "unmute" : "mute"]);
        ToolTipService.SetToolTip(ActiveCallBack, s["callBackToCall"]);
        ToolTipService.SetToolTip(ActiveCallReturn, s["callBackToCall"]);
        ToolTipService.SetToolTip(ActiveCallRail, $"{call.Name} — {s["callBackToCall"]}");
        ToolTipService.SetToolTip(ActiveCallPopOut, s["callPopOut"]);
        ActiveCallPopOut.IsEnabled = call.IsLive;
        // Handed on: hanging up here would end the call for the colleague too.
        ActiveCallHangUpGlyph.Glyph = call.IsTransferred ? "\uF3B1" : "\uE778";
        ActiveCallHangUp.Background = call.IsTransferred ? CallWarning : CallDanger;
        ActiveCallHangUp.IsEnabled = call.IsLive;
        ToolTipService.SetToolTip(ActiveCallHangUp, s[call.IsTransferred ? "callLeave" : "hangUpCall"]);
        // The narrow rail has room for the face alone.
        var open = Nav.IsPaneOpen;
        ActiveCallBar.Visibility = open ? Visibility.Visible : Visibility.Collapsed;
        ActiveCallRail.Visibility = open ? Visibility.Collapsed : Visibility.Visible;

        if (call.IsConnected && call.IsLive)
        {
            if (_callClock is null)
            {
                _callClock = DispatcherQueue.CreateTimer();
                _callClock.Interval = TimeSpan.FromSeconds(1);
                _callClock.Tick += (_, _) =>
                {
                    if (LiveCall.Running is { } running) ActiveCallStatus.Text = running.StatusText;
                    else _callClock?.Stop();
                };
            }
            if (!_callClock.IsRunning) _callClock.Start();
        }
        else
        {
            _callClock?.Stop();
        }
    }

    private void OnActiveCallMute(object sender, RoutedEventArgs e) => LiveCall.Running?.ToggleMute();

    private void OnActiveCallBack(object sender, RoutedEventArgs e) => LiveCall.Running?.ShowCallPage();

    private void OnActiveCallPopOut(object sender, RoutedEventArgs e) => LiveCall.Running?.PopOut();

    private void OnActiveCallHangUp(object sender, RoutedEventArgs e) => LiveCall.Running?.HangUpOrLeave();
}
