using System.Text.Json;
using Webyar.App.Helpers;
using Webyar.App.Services;
using Webyar.Core.Api;
using Webyar.Core.Calls;
using Webyar.Core.Inbox;

namespace Webyar.App.Views;

/// <summary>
/// The one call the operator can be on, as the Mac's CallCoordinator and
/// LiveCall. An operator never dials a visitor directly: the invitation is the
/// offer, the widget accepts it, and only then does a room exist — so a call
/// from a conversation waits on the invitation, then joins the room with the
/// token the web console would get. A call answered on the call-center desk
/// joins the room the desk's accept made.
///
/// A call lives in the page it belongs to: under the conversation's header, or
/// over the call on the desk (<see cref="CallDock"/>). The operator can go to
/// any other page meanwhile — the call bar at the foot of the sidebar keeps it
/// at hand and leads back — or take the call out into a window of its own
/// (<see cref="CallWindow"/>), full screen if they like, and put it back.
/// The media runs in a WebView2 page (<see cref="CallSurface"/>), which cannot
/// move between windows: moving the call starts a new page that joins the same
/// room as the old one leaves it.
/// </summary>
public sealed class LiveCall
{
    public enum Presentation { Docked, Window }

    private enum Phase { Waiting, Connecting, Connected, Ended }

    /// <summary>A call answered on the desk (or joined after a hand-over): the room already exists.</summary>
    private sealed record DeskCall(string CallId, CallAccept Accept, CallSession? Session);

    /// <summary>The caller's face, drawn as everywhere else: photo, else their device's logo, else the person disc; their country.</summary>
    /// <param name="Pending">The caller's profile is still on its way: the face is a skeleton until it lands.</param>
    public sealed record CallFace(string? Name, string? Email, string? Os, string? CountryCode, string? ImageUrl, bool Pending = false);

    private static LiveCall? _current;

    private readonly Conversation? _conversation;
    private readonly DeskCall? _desk;
    private readonly string _workspaceId;
    private readonly string _channel;
    private readonly string _name;
    private readonly CancellationTokenSource _stop = new();
    private readonly CallNoteBook _notes = new();
    /// <summary>Done once the server has been told the call ended (or it could not be): what quitting waits for.</summary>
    private readonly TaskCompletionSource _told = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private CallSurface? _surface;
    private CallWindow? _window;
    /// <summary>The page being let go of after a move: the new one joins once it is out of the room.</summary>
    private Task _leaving = Task.CompletedTask;
    private CallInvitation? _invitation;
    private string? _sessionId;
    private bool _ended;
    private bool _closed;
    private Phase _phase = Phase.Waiting;
    private string _outcome = "hungUp";
    private DateTimeOffset? _connectedAt;
    private bool _muted;
    private bool _cameraOn;
    private Poller? _notesPoller;
    private string? _noteError;
    // Transfer: handed to this colleague (or department); the call stays up until they join.
    private string? _transferredTo;
    private string? _transferText;
    private string? _transferTargetId;
    private bool _transferring;
    private bool _handoverJoined;
    private string? _localIdentity;
    private IReadOnlyList<string> _roomOperators = [];
    /// <summary>What the page has been told to warn about, said again by a page that takes over.</summary>
    private readonly List<object> _warnings = [];
    private bool _notesOpen;
    private bool _onTop;
    private double _dockHeight;
    /// <summary>The room's address and token, for the page (and any page that takes over).</summary>
    private JoinInfo? _join;

    private sealed record JoinInfo(string Url, string Token, object[] Ice, bool Relay);

    private LiveCall(Conversation? c, string workspaceId, string channel, string name, DeskCall? desk = null)
    {
        _conversation = c;
        _desk = desk;
        _workspaceId = workspaceId;
        _channel = channel;
        _name = name;
        _sessionId = desk?.CallId;
        _cameraOn = channel == "video";
        // Until the page measures itself: the Mac's panel heights, a video picture or a single row.
        _dockHeight = channel == "video" ? 300 : 66;
        Host.Callers.Changed += OnCallerProfiles;
    }

    private static AppHost Host => App.Current.Host;

    // ── The one call there can be ──

    /// <summary>The call under way, if any.</summary>
    public static LiveCall? Running => _current;

    /// <summary>Raised on the UI thread whenever the call starts, connects, mutes, moves, is handed on, ends or closes.</summary>
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

    /// <summary>Starts a call from a conversation, or leads to the one already running.</summary>
    public static void Start(Conversation c, string workspaceId, string channel, string name)
    {
        if (ShowRunning()) return;
        // The buttons hide with the plan; this holds even if one lingers.
        if (channel == "video" ? !Host.Plan.VideoCalls : !Host.Plan.VoiceCalls) return;
        Begin(new LiveCall(c, workspaceId, channel, name));
    }

    /// <summary>
    /// Opens the media for a call just accepted on the call center desk, or a
    /// call a colleague handed over. With video calls off in the plan, a video
    /// call is answered by voice. <paramref name="session"/> is the call as
    /// the desk knew it: the caller's face comes from its visitor session.
    /// </summary>
    public static void StartDesk(string callId, CallAccept accept, string workspaceId, string channel, string name, CallSession? session = null)
    {
        if (ShowRunning()) return;
        if (channel == "video" && !Host.Plan.VideoCalls) channel = "audio";
        Begin(new LiveCall(null, workspaceId, channel, name, new DeskCall(callId, accept, session)));
    }

    private static void Begin(LiveCall call)
    {
        _current = call;
        call.Attach(new CallSurface(docked: true));
        Changed?.Invoke();
        _ = call.RunAsync();
    }

    /// <summary>A call is already up: show it rather than start another.</summary>
    private static bool ShowRunning()
    {
        if (_current is not { } running) return false;
        running.ShowCall();
        return true;
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

    // ── What the shell and the pages show ──

    public string Name => _name;
    public bool IsVideo => _channel == "video";
    public bool IsLive => !_ended;
    public bool IsConnected => _phase == Phase.Connected;
    public bool IsMuted => _muted;
    public bool IsTransferred => _transferredTo is not null;
    public Presentation Shown { get; private set; } = Presentation.Docked;

    /// <summary>Which page holds the call while it is docked: "conv:{id}" or "desk:{call id}".</summary>
    public string DockKey => _desk is { } d ? $"desk:{d.CallId}" : $"conv:{_conversation?.Id}";

    /// <summary>How tall the docked panel wants to be, as its page measured it.</summary>
    public double DockHeight => _dockHeight;

    /// <summary>The docked page, while the call is in its page.</summary>
    internal CallSurface? DockedSurface => Shown == Presentation.Docked ? _surface : null;

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
            return new CallFace(session?.VisitorName ?? _name, session?.VisitorEmail, profile?.Device?.Os, profile?.Geo?.CountryCode, null,
                Host.Callers.IsPending(session?.VisitorSessionId));
        }
    }

    /// <summary>Back to the call: its window to the front, or the page it is docked in.</summary>
    public void ShowCall()
    {
        if (Shown == Presentation.Window && _window is { } w) w.BringToFront();
        else ShowCallPage();
    }

    /// <summary>The page the call belongs to: the conversation, or the call on the desk.</summary>
    public void ShowCallPage()
    {
        App.Current.ShowWindow();
        if (App.Current.Window?.Shell is not { } shell) return;
        if (_conversation is { } c) shell.OpenConversation(c.Id);
        else if (_desk is { } d) shell.OpenCall(d.CallId);
    }

    /// <summary>Mutes or unmutes from outside the page; the page answers with the new state.</summary>
    public void ToggleMute()
    {
        if (_phase == Phase.Connected) Post(new { type = "setMute", on = !_muted });
    }

    /// <summary>Hangs up — or, once handed on, leaves: hanging up then would end the call for the colleague too.</summary>
    public void HangUpOrLeave() => _ = FinishAsync(_transferredTo is null ? "hungUp" : "transferred", null);

    // ── Where the call is shown ──

    /// <summary>Takes the call out of its page into a window of its own.</summary>
    public void PopOut(bool fullScreen = false)
    {
        if (_ended || Shown == Presentation.Window) return;
        Shown = Presentation.Window;
        var surface = new CallSurface(docked: false);
        _window = new CallWindow(this, surface, IsVideo, _name, _onTop);
        Attach(surface);
        _window.Activate();
        if (fullScreen) _window.SetFullScreen(true);
        Changed?.Invoke();
    }

    /// <summary>Puts the call back into its page and closes its window — the call goes on.</summary>
    public void DockBack()
    {
        if (_ended || Shown == Presentation.Docked) return;
        Shown = Presentation.Docked;
        var window = _window;
        _window = null;
        _notesOpen = false;
        Attach(new CallSurface(docked: true));
        window?.CloseQuietly();
        Changed?.Invoke();
        ShowCallPage();
    }

    /// <summary>Full screen and back: from the page, the call goes to its own window first.</summary>
    public void ToggleFullScreen()
    {
        if (Shown == Presentation.Docked) PopOut(fullScreen: true);
        else _window?.SetFullScreen(!(_window?.IsFullScreen ?? false));
    }

    /// <summary>The call's window closed by its close button: the call goes back into its page, as on the Mac.</summary>
    internal bool WindowClosing()
    {
        if (_ended) return true;
        DockBack();
        return false;
    }

    /// <summary>A new page for the call: the old one leaves the room, then the new one joins it once loaded.</summary>
    private void Attach(CallSurface surface)
    {
        var old = _surface;
        _surface = surface;
        surface.Message += OnPageMessage;
        surface.HeightWanted += (s, h) =>
        {
            if (!ReferenceEquals(s, _surface)) return;
            _dockHeight = h;
            CallDock.Place();
        };
        if (surface.Docked) CallDock.Show(surface);
        if (old is not null)
        {
            old.Message -= OnPageMessage;
            _leaving = LetGoAsync(old);
        }
        _ = StartSurfaceAsync(surface);
    }

    private async Task LetGoAsync(CallSurface old)
    {
        await old.DetachAsync();
        if (old.Docked) CallDock.Remove(old);
        old.Close();
    }

    private async Task StartSurfaceAsync(CallSurface surface)
    {
        try
        {
            await surface.StartAsync();
        }
        catch (Exception e)
        {
            // No WebView2 runtime on this machine: say so rather than fail silently.
            Log.Error("call webview", e);
            if (!ReferenceEquals(surface, _surface)) return;
            _window?.ShowFatal(Host.Strings["callFailed"]);
            await FinishAsync("failed", "webview");
        }
    }

    // ── Running the call ──

    private async Task RunAsync()
    {
        // The notes are there from the start: a colleague's note on a handed-over call is read before it connects.
        _notesPoller = new Poller("call notes", LoadNotesAsync, () => TimeSpan.FromSeconds(5));
        _notesPoller.Start();

        var s = Host.Strings;
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
            SetJoin(new JoinInfo(url, token, [], false));
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
                    Changed?.Invoke();
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
        if (token.Warnings?.Contains("turn_missing") == true) Warn(new { type = "warn", text = s["callRelayWarning"] });
        object[] ice = token.Turn?.Urls is { Count: > 0 } urls
            ? [new { urls, username = token.Turn.Username ?? string.Empty, credential = token.Turn.Credential ?? string.Empty }]
            : [];
        SetJoin(new JoinInfo(url, token.Token, ice, token.IcePolicy == "relay"));
    }

    /// <summary>The page may still be loading LiveKit; it is sent the room once it is ready.</summary>
    private void SetJoin(JoinInfo join)
    {
        _join = join;
        if (_surface is { IsReady: true } surface) _ = JoinWhenFreeAsync(surface);
    }

    /// <summary>Joins the room from this page, once the page the call moved from is out of it.</summary>
    private async Task JoinWhenFreeAsync(CallSurface surface)
    {
        await _leaving;
        if (_join is not { } j || _ended || !ReferenceEquals(surface, _surface)) return;
        surface.Post(new
        {
            type = "join",
            url = j.Url,
            token = j.Token,
            ice = j.Ice,
            relay = j.Relay,
            channel = _channel,
            // A page taking over carries on as the call was: muted or not, the camera, the running time.
            muted = _muted,
            camOn = _cameraOn,
            since = _connectedAt?.ToUnixTimeMilliseconds(),
        });
    }

    private void SetPhase(Phase phase)
    {
        if (_phase == phase || _phase == Phase.Ended) return;
        _phase = phase;
        Changed?.Invoke();
    }

    private void OnPageMessage(CallSurface surface, string type, JsonElement root)
    {
        if (!ReferenceEquals(surface, _surface) && type != "log") return;
        var s = Host.Strings;
        switch (type)
        {
            case "ready":
                SendState(surface);
                if (_join is not null) _ = JoinWhenFreeAsync(surface);
                break;
            case "connected":
                Log.Write($"[call] connected {_sessionId}");
                _connectedAt ??= DateTimeOffset.Now;
                SetPhase(Phase.Connected);
                break;
            case "degraded":
                var what = Str(root, "what");
                if (what == "noCamera") _cameraOn = false;
                Warn(new { type = "warn", text = s[what == "noCamera" ? "callNoCamera" : "callNoMicrophone"] });
                // Windows' privacy settings keep the microphone or camera from desktop apps: say where to allow it.
                if (root.TryGetProperty("blocked", out var blocked) && blocked.ValueKind == JsonValueKind.True)
                    Warn(new { type = "permission", text = s["mediaPermission"], button = s["openWindowsSettings"], kind = what == "noCamera" ? "camera" : "microphone" });
                break;
            case "mute":
                _muted = root.TryGetProperty("on", out var on) && on.ValueKind == JsonValueKind.True;
                Changed?.Invoke();
                break;
            case "camera":
                _cameraOn = root.TryGetProperty("on", out var cam) && cam.ValueKind == JsonValueKind.True;
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
                _notesOpen = root.TryGetProperty("open", out var open) && open.ValueKind == JsonValueKind.True;
                _window?.FitSidePanel(_notesOpen);
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
                if (_window?.IsFullScreen == true) _window.SetFullScreen(false);
                break;
            case "keepOnTop":
                _onTop = !_onTop;
                _window?.SetOnTop(_onTop);
                PostWindowState();
                break;
            case "popOut":
                PopOut();
                break;
            case "dockBack":
                DockBack();
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

    private static string? Str(JsonElement e, string name) =>
        e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

    /// <summary>A warning the page shows, kept to show again on a page that takes over.</summary>
    private void Warn(object message)
    {
        _warnings.Add(message);
        Post(message);
    }

    /// <summary>Everything a freshly loaded page needs to draw the call as it stands.</summary>
    private void SendState(CallSurface surface)
    {
        var s = Host.Strings;
        surface.Post(new
        {
            type = "init",
            rtl = s.IsRightToLeft,
            docked = surface.Docked,
            name = _name,
            face = FacePayload(),
            channel = _channel,
            status = _phase switch
            {
                Phase.Waiting => s[_desk is null ? "callWaiting" : "connectingCall"],
                _ => s["connectingCall"],
            },
            waiting = _phase == Phase.Waiting,
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
                popOut = s["callPopOut"],
                dockBack = s["callDockBack"],
            },
        });
        foreach (var w in _warnings) surface.Post(w);
        if (_transferText is { } handed) surface.Post(new { type = "transferred", text = handed });
        PostNotes();
        PostWindowState();
    }

    /// <summary>The face as the page draws it: the photo, else the OS logo on its gradient, else the person on their tint; the country letters.</summary>
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
            tint = Hex(AvatarArt.Tint(f.Name, f.Email)),
            pending = f.Pending,
            from = Hex(art.From),
            to = Hex(art.To),
            angle = art.AngleDegrees,
            os = art.Os == AvatarOs.None ? null : art.Os.ToString().ToLowerInvariant(),
            country = AvatarArt.CountryBadge(f.CountryCode),
            image = f.ImageUrl is { } url && url.StartsWith("https://", StringComparison.OrdinalIgnoreCase) ? url : null,
        };
    }

    /// <summary>The caller's device and country arrived after the call opened: draw the face again.</summary>
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
            _transferText = s.Get("callTransferredWaiting", "name", _transferredTo);
            Post(new { type = "transferState", busy = false, done = true });
            Post(new { type = "transferred", text = _transferText });
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
        _transferText = Host.Strings.Get("callHandoverJoined", "name", _transferredTo);
        Post(new { type = "transferred", text = _transferText });
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

    internal void PostWindowState() =>
        Post(new { type = "window", fullScreen = _window?.IsFullScreen == true, onTop = _onTop, docked = Shown == Presentation.Docked });

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

    /// <summary>The single way a call ends: the server is told on every path, then the call says why and goes.</summary>
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
        Close();
    }

    /// <summary>The ended call has shown why for a moment: its panel goes, its window closes.</summary>
    private void Close()
    {
        if (_closed) return;
        _closed = true;
        Host.Callers.Changed -= OnCallerProfiles;
        if (_surface is { } surface)
        {
            surface.Message -= OnPageMessage;
            if (surface.Docked) CallDock.Remove(surface);
            surface.Close();
        }
        _surface = null;
        var window = _window;
        _window = null;
        window?.CloseQuietly();
        if (ReferenceEquals(_current, this)) _current = null;
        if (_desk is { } desk) DeskCallEnded?.Invoke(desk.CallId);
        Changed?.Invoke();
    }

    private void Post(object message) => _surface?.Post(message);
}
