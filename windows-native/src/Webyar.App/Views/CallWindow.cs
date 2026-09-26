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
using Webyar.Core.Calls;
using Webyar.Core.Inbox;
using Windows.Graphics;

namespace Webyar.App.Views;

/// <summary>
/// A call with a visitor, in its own window. An operator never dials a visitor
/// directly: the invitation is the offer, the widget accepts it, and only then
/// does a room exist — so this waits on the invitation, then joins the room
/// with the token the web console would get. The media runs in a WebView2
/// page (Assets/Call/call.html) with the same LiveKit SDK as the web console.
///
/// Beside the media, as on the Mac: the call's notes (the desk call's own, or
/// the conversation's internal notes), handing a desk call to a colleague or a
/// department, full screen and keep-on-top. The Mac docks a call inside its
/// main window; here the call always keeps its own window — a WinUI element
/// cannot move between windows, and taking the page out would reconnect the
/// room — so the shell shows a call bar that leads back to it instead.
/// </summary>
public sealed partial class CallWindow : Window
{
    private static CallWindow? _current;

    private enum Phase { Waiting, Connecting, Connected, Ended }

    /// <summary>A call answered on the desk (or joined after a hand-over): the room already exists.</summary>
    private sealed record DeskCall(string CallId, CallAccept Accept, CallSession? Session);

    /// <summary>The caller's face, drawn as everywhere else: photo, else their device's logo, else initials; their country.</summary>
    public sealed record CallFace(string? Name, string? Email, string? Os, string? CountryCode, string? ImageUrl);

    private readonly Conversation? _conversation;
    private readonly DeskCall? _desk;
    private readonly string _workspaceId;
    private readonly string _channel;
    private readonly string _name;
    private readonly WebView2 _web = new();
    private readonly CancellationTokenSource _stop = new();
    private readonly CallNoteBook _notes = new();
    /// <summary>Done once the server has been told the call ended (or it could not be): what quitting waits for.</summary>
    private readonly TaskCompletionSource _told = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private CallInvitation? _invitation;
    private string? _sessionId;
    private bool _ended;
    private bool _ready;
    private Phase _phase = Phase.Waiting;
    private string _outcome = "hungUp";
    private DateTimeOffset? _connectedAt;
    private bool _muted;
    private Poller? _notesPoller;
    private string? _noteError;
    // Transfer: handed to this colleague (or department); the window stays until they join.
    private string? _transferredTo;
    private string? _transferTargetId;
    private bool _transferring;
    private bool _handoverJoined;
    private string? _localIdentity;
    private IReadOnlyList<string> _roomOperators = [];
    private bool _onTop;
    private int? _narrowWidth;

    private CallWindow(Conversation? c, string workspaceId, string channel, string name, DeskCall? desk = null)
    {
        _conversation = c;
        _desk = desk;
        _workspaceId = workspaceId;
        _channel = channel;
        _name = name;
        _sessionId = desk?.CallId;
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
        // Windowing fails fast if one of its callbacks throws, so nothing may escape these.
        AppWindow.Closing += (w, e) =>
        {
            if (_ended) return;
            e.Cancel = true;
            _ = FinishAsync(_transferredTo is null ? "hungUp" : "transferred", null);
        };
        AppWindow.Changed += (_, e) =>
        {
            if (e.DidPresenterChange) Guard("call presenter", PostWindowState);
        };
        Host.Callers.Changed += OnCallerProfiles;
    }

    private static AppHost Host => App.Current.Host;

    // ── The one call there can be ──

    /// <summary>The call under way, if any: the shell's call bar reads it.</summary>
    public static CallWindow? Running => _current;

    /// <summary>Raised on the UI thread whenever the call starts, connects, mutes, is handed on, ends or closes.</summary>
    public static event Action? Changed;

    /// <summary>Raised on the UI thread when a call answered from the queue ends; carries the call id.</summary>
    public static event Action<string>? DeskCallEnded;

    public static bool IsBusy => _current is not null;

    /// <summary>The call session the operator is on: the desk call's id, or a conversation call's once the visitor joined.</summary>
    public static string? ActiveCallId => _current?._sessionId;

    /// <summary>The desk call under way (answered in the call center or joined after a hand-over), if any.</summary>
    public static string? DeskCallId => _current?._desk?.CallId;

    /// <summary>That call as the desk knew it when answered: to show it again from the call center.</summary>
    public static CallSession? DeskSession => _current?._desk?.Session;

    /// <summary>Starts a call, or brings the one already running to the front.</summary>
    public static void Start(Conversation c, string workspaceId, string channel, string name)
    {
        if (_current is { } running)
        {
            running.BringToFront();
            return;
        }
        // The buttons hide with the plan; this holds even if one lingers.
        if (channel == "video" ? !Host.Plan.VideoCalls : !Host.Plan.VoiceCalls) return;
        Open(new CallWindow(c, workspaceId, channel, name), null);
    }

    /// <summary>
    /// Opens the media for a call just accepted on the call center desk, or a
    /// call a colleague handed over. With video calls off in the plan, a video
    /// call is answered by voice. <paramref name="session"/> is the call as
    /// the desk knew it: the caller's face comes from its visitor session.
    /// </summary>
    public static void StartDesk(string callId, CallAccept accept, string workspaceId, string channel, string name, CallSession? session = null)
    {
        if (_current is { } running)
        {
            running.BringToFront();
            return;
        }
        if (channel == "video" && !Host.Plan.VideoCalls) channel = "audio";
        Open(new CallWindow(null, workspaceId, channel, name, new DeskCall(callId, accept, session)), callId);
    }

    private static void Open(CallWindow w, string? deskCallId)
    {
        _current = w;
        w.Closed += (_, _) =>
        {
            Host.Callers.Changed -= w.OnCallerProfiles;
            w._notesPoller?.Dispose();
            if (ReferenceEquals(_current, w)) _current = null;
            if (deskCallId is not null) DeskCallEnded?.Invoke(deskCallId);
            Changed?.Invoke();
        };
        w.Activate();
        Changed?.Invoke();
        _ = w.RunAsync();
    }

    /// <summary>
    /// Quitting, signing out or leaving the workspace: the call ends properly
    /// rather than just vanishing (a handed-on call is left, not ended), and
    /// the caller may wait up to <paramref name="wait"/> for the server to hear it.
    /// </summary>
    public static Task EndForQuitAsync(TimeSpan wait)
    {
        if (_current is not { } c) return Task.CompletedTask;
        if (!c._ended) _ = c.FinishAsync(c._transferredTo is null ? "hungUp" : "transferred", null);
        return Task.WhenAny(c._told.Task, Task.Delay(wait));
    }

    // ── What the shell's call bar shows and does ──

    public string Name => _name;
    public bool IsVideo => _channel == "video";
    public bool IsLive => !_ended;
    public bool IsConnected => _phase == Phase.Connected;
    public bool IsMuted => _muted;
    public bool IsTransferred => _transferredTo is not null;

    /// <summary>Ringing, connecting, the running time, or how it ended.</summary>
    public string StatusText
    {
        get
        {
            var s = Host.Strings;
            return _phase switch
            {
                Phase.Waiting => s[_desk is null ? "callWaiting" : "connectingCall"],
                Phase.Connecting => s["connectingCall"],
                Phase.Connected => CallRules.Clock(DateTimeOffset.Now - (_connectedAt ?? DateTimeOffset.Now), s.Language),
                _ => OutcomeText(_outcome),
            };
        }
    }

    public CallFace Face
    {
        get
        {
            if (_conversation is { } c)
                return new CallFace(c.Contacts?.Name ?? _name, c.Contacts?.Email, c.VisitorOs, c.VisitorCountryCode, c.Contacts?.AvatarUrl);
            var session = _desk?.Session;
            var profile = Host.Callers.For(session?.VisitorSessionId);
            return new CallFace(session?.VisitorName ?? _name, session?.VisitorEmail, profile?.Device?.Os, profile?.Geo?.CountryCode, null);
        }
    }

    /// <summary>Back to the call: its window to the front, restored if it was minimised.</summary>
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

    /// <summary>Mutes or unmutes from outside the window; the page answers with the new state.</summary>
    public void ToggleMute()
    {
        if (_phase == Phase.Connected) Post(new { type = "setMute", on = !_muted });
    }

    /// <summary>Hangs up — or, once handed on, leaves: hanging up then would end the call for the colleague too.</summary>
    public void HangUpOrLeave() => _ = FinishAsync(_transferredTo is null ? "hungUp" : "transferred", null);

    // ── Running the call ──

    private async Task RunAsync()
    {
        var s = Host.Strings;
        // The notes are there from the start: a colleague's note on a handed-over call is read before it connects.
        _notesPoller = new Poller("call notes", LoadNotesAsync, () => TimeSpan.FromSeconds(5));
        _notesPoller.Start();
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

        if (_desk is { } desk)
        {
            // Accepted on the desk: the server made the room and gave us its token.
            if (desk.Accept.Connect is not { Supported: true, ServerUrl: { Length: > 0 } url } || desk.Accept.Token is not { Length: > 0 } token)
            {
                await FinishAsync("failed", desk.Accept.Connect?.Reason ?? "no_server_url");
                return;
            }
            SetPhase(Phase.Connecting);
            Post(new { type = "status", text = s["connectingCall"] });
            _join = new { type = "join", url, token, ice = Array.Empty<object>(), relay = false, channel = _channel };
            if (_ready) Post(_join);
            return;
        }

        try
        {
            // Not cancelled with the call: hung up while this is on its way, the server may still
            // make the invitation, and it is withdrawn below rather than left ringing the visitor.
            _invitation = await Host.Api.InviteToCallAsync(_conversation!.Id, _workspaceId, _channel, CancellationToken.None);
            Log.Write($"[call] invited {_invitation.Id} {_channel}");
            if (_ended)
            {
                await CancelInvitationQuietlyAsync(_invitation.Id);
                return;
            }
            // Two seconds for as long as the invitation lives — cheaper than a realtime channel for one wait.
            var misses = 0;
            while (!_stop.IsCancellationRequested)
            {
                CallInvitation inv;
                try
                {
                    inv = await Host.Api.InvitationAsync(_invitation.Id, _stop.Token);
                    misses = 0;
                }
                catch (Exception e) when (CallRules.IsTransient(e) && !_stop.IsCancellationRequested)
                {
                    // Offline a moment, or a 5xx: not the end of the call. Several in a row are.
                    if (++misses >= CallRules.InvitationMisses) throw;
                    await Task.Delay(2000, _stop.Token);
                    continue;
                }
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
            if (_ended) return;
            Log.Error("call invite", e);
            await FinishAsync("failed", e.Message);
        }
    }

    private static async Task CancelInvitationQuietlyAsync(string id)
    {
        try
        {
            await Host.Api.CancelInvitationAsync(id);
        }
        catch (Exception e)
        {
            Log.Error("cancel invitation", e);
        }
    }

    private async Task JoinAsync(string sessionId)
    {
        var s = Host.Strings;
        SetPhase(Phase.Connecting);
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

    private void SetPhase(Phase phase)
    {
        if (_phase == phase || _phase == Phase.Ended) return;
        _phase = phase;
        Changed?.Invoke();
    }

    private void OnPageMessage(CoreWebView2 sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        try
        {
            using var doc = JsonDocument.Parse(e.TryGetWebMessageAsString());
            var root = doc.RootElement;
            var s = Host.Strings;
            switch (root.GetProperty("type").GetString())
            {
                case "ready":
                    _ready = true;
                    SendInit();
                    PostNotes();
                    PostWindowState();
                    if (_join is not null) Post(_join);
                    break;
                case "connected":
                    Log.Write($"[call] connected {_sessionId}");
                    _connectedAt = DateTimeOffset.Now;
                    SetPhase(Phase.Connected);
                    break;
                case "degraded":
                    var what = Str(root, "what");
                    Post(new { type = "warn", text = s[what == "noCamera" ? "callNoCamera" : "callNoMicrophone"] });
                    // Windows' privacy settings keep the microphone or camera from desktop apps: say where to allow it.
                    if (root.TryGetProperty("blocked", out var blocked) && blocked.ValueKind == JsonValueKind.True)
                        Post(new { type = "permission", text = s["mediaPermission"], button = s["openWindowsSettings"], kind = what == "noCamera" ? "camera" : "microphone" });
                    break;
                case "mute":
                    _muted = root.TryGetProperty("on", out var on) && on.ValueKind == JsonValueKind.True;
                    Changed?.Invoke();
                    break;
                case "room":
                    _localIdentity = Str(root, "local");
                    _roomOperators = root.TryGetProperty("operators", out var ops) && ops.ValueKind == JsonValueKind.Array
                        ? ops.EnumerateArray().Select(o => o.GetString() ?? string.Empty).ToList()
                        : [];
                    CheckHandover();
                    break;
                case "addNote":
                    AddNote(Str(root, "text") ?? string.Empty);
                    break;
                case "retryNote":
                    if (Str(root, "id") is { } retry && _notes.Retry(retry) is { } again)
                    {
                        PostNotes();
                        _ = DeliverAsync(again);
                    }
                    break;
                case "discardNote":
                    if (Str(root, "id") is { } discard && _notes.Discard(discard))
                    {
                        if (!_notes.HasFailed) _noteError = null;
                        PostNotes();
                    }
                    break;
                case "notesOpen":
                    FitSidePanel(root.TryGetProperty("open", out var open) && open.ValueKind == JsonValueKind.True);
                    break;
                case "openTransfer":
                    _ = LoadTransferAsync();
                    break;
                case "transfer":
                    _ = TransferAsync(Str(root, "agentId"), Str(root, "departmentId"), Str(root, "name") ?? string.Empty, Str(root, "reason"));
                    break;
                case "fullScreen":
                    ToggleFullScreen();
                    break;
                case "exitFullScreen":
                    if (AppWindow.Presenter.Kind == AppWindowPresenterKind.FullScreen) ToggleFullScreen();
                    break;
                case "keepOnTop":
                    _onTop = !_onTop;
                    ApplyOnTop();
                    PostWindowState();
                    break;
                case "openPrivacy":
                    _ = Windows.System.Launcher.LaunchUriAsync(new Uri(Str(root, "kind") == "camera" ? "ms-settings:privacy-webcam" : "ms-settings:privacy-microphone"));
                    break;
                case "leave":
                    _ = FinishAsync("transferred", null);
                    break;
                case "ended":
                    var reason = Str(root, "reason") ?? "hungUp";
                    // Hanging up after a hand-over leaves the call rather than ending it for the colleague.
                    if (reason == "hungUp" && _transferredTo is not null) reason = "transferred";
                    _ = FinishAsync(reason, Str(root, "detail"));
                    break;
                case "log":
                    Log.Write("[call] " + Str(root, "text"));
                    break;
            }
        }
        catch (Exception ex)
        {
            Log.Error("call message", ex);
        }
    }

    private static string? Str(JsonElement e, string name) =>
        e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

    private void SendInit()
    {
        var s = Host.Strings;
        Post(new
        {
            type = "init",
            rtl = s.IsRightToLeft,
            name = _name,
            face = FacePayload(),
            channel = _channel,
            status = _desk is null ? s["callWaiting"] : s["connectingCall"],
            canTransfer = _desk is not null,
            hasNotes = _desk is not null || _conversation is not null,
            strings = new
            {
                mute = s["mute"],
                unmute = s["unmute"],
                camera = s["camera"],
                hangUp = s["hangUpCall"],
                leave = s["callLeave"],
                notes = s["callNotes"],
                notesEmpty = s["callNotesEmpty"],
                notePlaceholder = s["callNotePlaceholder"],
                noteSend = s["callNoteSend"],
                noteSending = s["callNoteSending"],
                noteFailed = s["callNoteFailed"],
                noteRetry = s["callNoteRetry"],
                noteDiscard = s["callNoteDiscard"],
                close = s["close"],
                transfer = s["callTransfer"],
                operators = s["callTransferOperators"],
                departments = s["callTransferDepartments"],
                reason = s["callTransferReason"],
                submit = s["callTransferSubmit"],
                cancel = s["cancel"],
                noOperators = s["callTransferNoOperators"],
                noDepartments = s["callTransferNoDepartments"],
                transferHint = s["callTransferHint"],
                fullScreen = s["callFullScreen"],
                exitFullScreen = s["callExitFullScreen"],
                keepOnTop = s["callKeepOnTop"],
            },
        });
    }

    /// <summary>The face as the page draws it: the web console's gradient and OS logo, or the photo, and the country letters.</summary>
    private object FacePayload()
    {
        var f = Face;
        var art = AvatarArt.For(f.Name, f.Email, f.Os);
        static string Hex(Hsl c)
        {
            var (r, g, b) = c.ToRgb();
            return $"#{r:X2}{g:X2}{b:X2}";
        }
        return new
        {
            initials = art.Initials,
            from = Hex(art.From),
            to = Hex(art.To),
            angle = art.AngleDegrees,
            os = art.Os == AvatarOs.None ? null : art.Os.ToString().ToLowerInvariant(),
            country = AvatarArt.CountryBadge(f.CountryCode),
            image = f.ImageUrl is { } url && url.StartsWith("https://", StringComparison.OrdinalIgnoreCase) ? url : null,
        };
    }

    /// <summary>The caller's device and country arrived after the window opened: draw the face again.</summary>
    private void OnCallerProfiles()
    {
        if (_desk?.Session?.VisitorSessionId is null) return;
        Post(new { type = "face", face = FacePayload() });
        Changed?.Invoke();
    }

    // ── Notes beside the call ──

    private async Task LoadNotesAsync(CancellationToken ct)
    {
        if (_ended) return;
        try
        {
            await ReadNotesAsync(ct);
        }
        catch (Exception e) when (e is not OperationCanceledException)
        {
            // Nothing read yet: show "no notes" rather than a spinner for good.
            if (_notes.Saved is null)
            {
                _notes.SavedUnavailable();
                PostNotes();
            }
            if (e is not ApiException { Failure: ApiFailure.Transport }) Log.Error("call notes", e);
        }
    }

    private async Task ReadNotesAsync(CancellationToken ct)
    {
        IEnumerable<CallNoteItem> list = [];
        if (_desk is { } desk)
        {
            list = (await Host.Api.CallNotesAsync(_workspaceId, desk.CallId, ct)).Select(n => new CallNoteItem(n.Id, n.Note, n.AuthorName, n.CreatedAt));
        }
        else if (_conversation is { } c)
        {
            list = (await Host.Api.NotesAsync(c.Id, _workspaceId, ct)).Select(n => new CallNoteItem(n.Id, n.Body,
                n.Author?.FullName is { Length: > 0 } fn ? fn : n.Author?.Email ?? (n.AuthorId is { } a ? Host.MemberName(a) : null), n.CreatedAt));
        }
        _notes.SetSaved(list);
        PostNotes();
    }

    private void AddNote(string text)
    {
        var me = Host.Account?.Profile?.FullName is { Length: > 0 } pn ? pn : Host.User?.FullName is { Length: > 0 } n ? n : Host.User?.Email;
        if (_notes.Add(text, me, DateTimeOffset.Now) is not { } note) return;
        PostNotes();
        _ = DeliverAsync(note);
    }

    private async Task DeliverAsync(CallNoteItem note)
    {
        _noteError = null;
        try
        {
            if (_desk is { } desk) await Host.Api.AddCallNoteAsync(_workspaceId, desk.CallId, note.Text);
            else if (_conversation is { } c) await Host.Api.AddNoteAsync(c.Id, _workspaceId, note.Text);
            try
            {
                await ReadNotesAsync(CancellationToken.None);
            }
            catch (Exception e)
            {
                Log.Error("call notes", e);
            }
            _notes.Delivered(note.Id);
        }
        catch (Exception e)
        {
            Log.Error("call note", e);
            _notes.Failed(note.Id);
            _noteError = ErrorText.For(e, Host.Strings);
        }
        PostNotes();
    }

    private void PostNotes()
    {
        var s = Host.Strings;
        var now = DateTimeOffset.Now;
        Post(new
        {
            type = "notes",
            notes = _notes.Shown?.Select(n => new
            {
                id = n.Id,
                text = n.Text,
                head = string.Join(" · ", new[] { n.Author, n.At is { } at ? Display.ListStamp(at, now, s) : null }.Where(x => !string.IsNullOrEmpty(x))),
                sending = n.Sending switch { NoteSending.Going => "going", NoteSending.Failed => "failed", _ => "no" },
            }),
            error = _noteError,
        });
    }

    /// <summary>A voice call's window is narrow: it widens for the notes and narrows again after, as on the Mac.</summary>
    private void FitSidePanel(bool open)
    {
        try
        {
            if (IsVideo || AppWindow.Presenter is not OverlappedPresenter { State: OverlappedPresenterState.Restored }) return;
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

    // ── Handing the call on ──

    /// <summary>Who the call can go to: operators with their state and load, and the departments that take this kind of call.</summary>
    private async Task LoadTransferAsync()
    {
        var s = Host.Strings;
        var members = Quietly(Host.MembersAsync(), "members");
        var presence = Quietly(Host.Api.CallAgentPresenceAsync(_workspaceId), "call presence");
        var departments = Quietly(Host.Api.CallDepartmentsAsync(_workspaceId), "call departments");
        var people = TransferTargets.Operators(await members, await presence, Host.User?.Id, s.Culture);
        Post(new
        {
            type = "transferOptions",
            operators = people.Select(p => new
            {
                id = p.UserId,
                name = p.Name,
                status = p.Status,
                label = p.ActiveCalls > 0 ? $"{s[TransferTargets.StatusKey(p.Status)]} · {Webyar.Core.Localization.Digits.Localize(p.ActiveCalls.ToString(System.Globalization.CultureInfo.InvariantCulture), s.Language)}" : s[TransferTargets.StatusKey(p.Status)],
            }),
            departments = TransferTargets.Departments(await departments, IsVideo).Select(d => new { id = d.Id, name = d.Name ?? "—" }),
        });
    }

    private static async Task<IReadOnlyList<T>> Quietly<T>(Task<IReadOnlyList<T>> work, string what)
    {
        try
        {
            return await work;
        }
        catch (Exception e)
        {
            Log.Error(what, e);
            return [];
        }
    }

    /// <summary>
    /// Hands the desk call to a colleague or a department. The call goes on:
    /// whoever takes it joins this same room, and this operator leaves once they
    /// are in (or when they choose to).
    /// </summary>
    private async Task TransferAsync(string? agentId, string? departmentId, string name, string? reason)
    {
        if (_desk is not { } desk || _transferring || _ended || (agentId is null && departmentId is null)) return;
        var s = Host.Strings;
        _transferring = true;
        Post(new { type = "transferState", busy = true });
        try
        {
            await Host.Api.TransferCallAsync(_workspaceId, desk.CallId, agentId, departmentId, reason);
            Log.Write($"[call] transferred {desk.CallId} to {agentId ?? departmentId}");
            _transferTargetId = agentId;
            _transferredTo = name.Length > 0 ? name : s["callTransferDepartments"];
            Post(new { type = "transferState", busy = false, done = true });
            Post(new { type = "transferred", text = s.Get("callTransferredWaiting", "name", _transferredTo) });
            Changed?.Invoke();
            CheckHandover();
        }
        catch (Exception e)
        {
            Log.Error("call transfer", e);
            Post(new { type = "transferState", busy = false, error = $"{s["callTransferFailed"]} — {ErrorText.For(e, s)}" });
        }
        finally
        {
            _transferring = false;
        }
    }

    /// <summary>After a transfer: once the colleague is in the room, say so and step out a moment later.</summary>
    private void CheckHandover()
    {
        if (_transferredTo is null || _handoverJoined || _ended) return;
        if (!Handover.Joined(_roomOperators, _localIdentity, _transferTargetId)) return;
        _handoverJoined = true;
        Log.Write("[call] colleague joined, leaving");
        Post(new { type = "transferred", text = Host.Strings.Get("callHandoverJoined", "name", _transferredTo) });
        _ = LeaveSoonAsync();
    }

    private async Task LeaveSoonAsync()
    {
        try
        {
            await Task.Delay(2500, _stop.Token);
        }
        catch (OperationCanceledException)
        {
            return;
        }
        await FinishAsync("transferred", null);
    }

    // ── Full screen and keep on top ──

    private void ToggleFullScreen()
    {
        try
        {
            if (AppWindow.Presenter.Kind == AppWindowPresenterKind.FullScreen)
            {
                AppWindow.SetPresenter(AppWindowPresenterKind.Overlapped);
                ApplyOnTop();
            }
            else
            {
                AppWindow.SetPresenter(AppWindowPresenterKind.FullScreen);
            }
        }
        catch (Exception e)
        {
            Log.Error("call full screen", e);
        }
        PostWindowState();
    }

    private void ApplyOnTop()
    {
        if (AppWindow.Presenter is OverlappedPresenter p) p.IsAlwaysOnTop = _onTop;
    }

    private void PostWindowState()
    {
        var full = AppWindow.Presenter.Kind == AppWindowPresenterKind.FullScreen;
        if (!full) ApplyOnTop();
        Post(new { type = "window", fullScreen = full, onTop = _onTop });
    }

    // ── Ending ──

    private string OutcomeText(string outcome)
    {
        var s = Host.Strings;
        return outcome switch
        {
            "declined" => s["callDeclined"],
            "expired" => s["callNoAnswer"],
            "failed" => s["callFailed"],
            "transferred" => s["callTransferredOut"],
            _ => s["callEnded"],
        };
    }

    /// <summary>The single way a call ends: the server is told on every path, then the window says why and closes.</summary>
    private async Task FinishAsync(string outcome, string? detail)
    {
        if (_ended) return;
        _ended = true;
        _outcome = outcome;
        _phase = Phase.Ended;
        _stop.Cancel();
        _notesPoller?.Dispose();
        Log.Write($"[call] ended {outcome} {detail}");
        Post(new { type = "hangup" });
        Post(new { type = "status", text = OutcomeText(outcome), ended = true });
        Changed?.Invoke();
        // Ending is idempotent server-side, so a race with the visitor's own hang-up is harmless.
        try
        {
            if (outcome == "transferred")
            {
                // Handed on: the call is the colleague's now, and it goes on without this operator.
            }
            else if (_desk is { } desk) await Host.Api.EndCallAsync(_workspaceId, desk.CallId);
            else if (_sessionId is not null) await Host.Api.HangUpAsync(_sessionId);
            else if (_invitation is not null) await Host.Api.CancelInvitationAsync(_invitation.Id);
        }
        catch (ApiException e) when (e.ServerMessage is "call_not_active" || e.Body?.Contains("call_not_active") == true)
        {
            // The visitor hung up first: the call is already over, nothing to end.
        }
        catch (Exception e)
        {
            Log.Error("call hang up", e);
        }
        finally
        {
            _told.TrySetResult();
        }
        // An ended call says why for a moment, then gets out of the way.
        await Task.Delay(outcome == "failed" ? 4000 : 1800);
        try
        {
            Close();
        }
        catch (Exception e)
        {
            // Already closed (the app is quitting).
            Log.Error("call close", e);
        }
    }

    private void ShowFatal(string text)
    {
        _ended = true;
        _phase = Phase.Ended;
        _outcome = "failed";
        _notesPoller?.Dispose();
        _told.TrySetResult();
        Changed?.Invoke();
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

    private int Scale(int dip)
    {
        var hwnd = Win32Interop.GetWindowFromWindowId(AppWindow.Id);
        var dpi = GetDpiForWindow(hwnd);
        return (int)(dip * (dpi > 0 ? dpi / 96.0 : 1.0));
    }

    [System.Runtime.InteropServices.DllImport("user32.dll")]
    private static extern uint GetDpiForWindow(IntPtr hwnd);
}
