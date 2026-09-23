using System.Net.WebSockets;
using System.Text;
using Webyar.Core.Api;

namespace Webyar.Core.Realtime;

/// <summary>A text WebSocket, abstracted so the connection logic can be tested without a server.</summary>
public interface IRealtimeSocket : IAsyncDisposable
{
    Task ConnectAsync(Uri url, CancellationToken ct);
    Task SendAsync(string text, CancellationToken ct);
    /// <summary>The next whole text message, or null once the socket has closed.</summary>
    Task<string?> ReceiveAsync(CancellationToken ct);
}

public sealed class ClientRealtimeSocket : IRealtimeSocket
{
    private readonly ClientWebSocket _ws = new();

    public Task ConnectAsync(Uri url, CancellationToken ct) => _ws.ConnectAsync(url, ct);

    public Task SendAsync(string text, CancellationToken ct) =>
        _ws.SendAsync(Encoding.UTF8.GetBytes(text), WebSocketMessageType.Text, endOfMessage: true, ct);

    public async Task<string?> ReceiveAsync(CancellationToken ct)
    {
        var buffer = new byte[16 * 1024];
        using var message = new MemoryStream();
        while (true)
        {
            WebSocketReceiveResult result;
            try
            {
                result = await _ws.ReceiveAsync(buffer, ct).ConfigureAwait(false);
            }
            catch (WebSocketException)
            {
                return null;
            }
            if (result.MessageType == WebSocketMessageType.Close) return null;
            message.Write(buffer, 0, result.Count);
            if (result.EndOfMessage) return Encoding.UTF8.GetString(message.ToArray());
        }
    }

    public async ValueTask DisposeAsync()
    {
        try
        {
            if (_ws.State == WebSocketState.Open)
                await _ws.CloseAsync(WebSocketCloseStatus.NormalClosure, null, CancellationToken.None).ConfigureAwait(false);
        }
        catch (WebSocketException)
        {
        }
        _ws.Dispose();
    }
}

/// <summary>
/// Listens on `ws:&lt;workspace&gt;:inbox`, the channel the web console uses: every
/// message and operator event in the workspace arrives there. While it is
/// connected the app's pollers can relax to a slow safety net. When the
/// server runs without realtime this simply never connects and the pollers
/// carry on alone.
/// </summary>
public sealed class InboxRealtime : IAsyncDisposable
{
    private static readonly TimeSpan[] Backoff = [TimeSpan.FromSeconds(1), TimeSpan.FromSeconds(2), TimeSpan.FromSeconds(4), TimeSpan.FromSeconds(8), TimeSpan.FromSeconds(15), TimeSpan.FromSeconds(30)];
    /// <summary>Renegotiate this long before the tokens expire, as the web console does.</summary>
    private static readonly TimeSpan RefreshLead = TimeSpan.FromMinutes(2);
    /// <summary>How long to wait before asking again when the server says "poll".</summary>
    internal static TimeSpan PolicyRetry = TimeSpan.FromMinutes(5);
    private static readonly TimeSpan CommandTimeout = TimeSpan.FromSeconds(8);

    private readonly WebyarApi _api;
    private readonly string _workspaceId;
    private readonly Func<IRealtimeSocket> _socketFactory;
    private readonly Func<bool> _allowed;
    private readonly HashSet<string> _seen = [];
    private CancellationTokenSource? _cts;
    private Task? _loop;
    private bool _connected;

    public InboxRealtime(WebyarApi api, string workspaceId, Func<IRealtimeSocket>? socketFactory = null, Func<bool>? allowed = null)
    {
        _api = api;
        _workspaceId = workspaceId;
        _socketFactory = socketFactory ?? (() => new ClientRealtimeSocket());
        _allowed = allowed ?? (() => true);
    }

    /// <summary>Raised on a background thread; marshal to the UI thread before touching controls.</summary>
    public event Action<InboxEvent>? EventReceived;
    public event Action<bool>? ConnectionChanged;

    /// <summary>The operator is now a member of the workspace's operators channel.</summary>
    public event Action? PresenceJoined;
    /// <summary>One line per state change, for the app's log file.</summary>
    public event Action<string>? Log;

    public bool IsConnected => _connected;

    public void Start()
    {
        if (_loop is not null) return;
        _cts = new CancellationTokenSource();
        _loop = Task.Run(() => RunAsync(_cts.Token));
    }

    private void SetConnected(bool value)
    {
        if (_connected == value) return;
        _connected = value;
        ConnectionChanged?.Invoke(value);
    }

    private async Task RunAsync(CancellationToken ct)
    {
        var attempt = 0;
        var intent = "initial";
        while (!ct.IsCancellationRequested)
        {
            TimeSpan wait;
            try
            {
                var outcome = await ConnectOnceAsync(intent, ct).ConfigureAwait(false);
                if (outcome.Subscribed) attempt = 0;
                wait = outcome.Retry ?? Backoff[Math.Min(attempt++, Backoff.Length - 1)];
                intent = outcome.Refresh ? "refresh" : "reconnect";
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                break;
            }
            catch (Exception e)
            {
                Log?.Invoke($"[realtime] failed: {e.GetType().Name} {e.Message}");
                wait = Backoff[Math.Min(attempt++, Backoff.Length - 1)];
                intent = "reconnect";
            }
            SetConnected(false);
            var jitter = 0.8 + Random.Shared.NextDouble() * 0.4;
            try
            {
                await Task.Delay(wait * jitter, ct).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                break;
            }
        }
        SetConnected(false);
    }

    private readonly record struct Outcome(bool Subscribed, bool Refresh, TimeSpan? Retry);

    private async Task<Outcome> ConnectOnceAsync(string intent, CancellationToken ct)
    {
        if (!_allowed()) return new Outcome(false, false, PolicyRetry);
        var conn = await _api.RealtimeConnectAsync(_workspaceId, intent, ct).ConfigureAwait(false);
        if (conn.Vendor != "centrifugo" || conn.WsUrl is null || conn.Token is null) return new Outcome(false, false, PolicyRetry);
        var sub = await _api.RealtimeInboxSubscribeAsync(_workspaceId, ct).ConfigureAwait(false);
        if (sub.Vendor != "centrifugo" || sub.Channel is null || sub.Token is null) return new Outcome(false, false, PolicyRetry);

        // Joining the operators channel is what makes this operator "connected"
        // for teammates, as in the web console. Optional: the inbox works without it.
        RealtimeSubscribe? presence = null;
        try
        {
            presence = await _api.RealtimePresenceSubscribeAsync(_workspaceId, ct).ConfigureAwait(false);
            if (presence.Vendor != "centrifugo" || presence.Channel is null || presence.Token is null) presence = null;
        }
        catch (Exception e) when (e is not OperationCanceledException)
        {
            Log?.Invoke($"[realtime] presence token: {e.GetType().Name}");
        }

        var expiresAt = Math.Min(conn.ExpiresAt ?? long.MaxValue, sub.ExpiresAt ?? long.MaxValue);
        if (presence?.ExpiresAt is { } pe) expiresAt = Math.Min(expiresAt, pe);
        var refreshAt = expiresAt == long.MaxValue
            ? DateTimeOffset.MaxValue
            : DateTimeOffset.FromUnixTimeMilliseconds(expiresAt) - RefreshLead;

        await using var socket = _socketFactory();
        using (var connectCts = CancellationTokenSource.CreateLinkedTokenSource(ct))
        {
            connectCts.CancelAfter(CommandTimeout);
            await socket.ConnectAsync(new Uri(conn.WsUrl), connectCts.Token).ConfigureAwait(false);
        }
        await socket.SendAsync(CentrifugoProtocol.Connect(1, conn.Token, "webyar-windows"), ct).ConfigureAwait(false);

        var subscribed = false;
        using var sessionCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        var untilRefresh = refreshAt - DateTimeOffset.UtcNow;
        if (untilRefresh < TimeSpan.FromSeconds(10)) untilRefresh = TimeSpan.FromSeconds(10);
        // CancelAfter takes at most ~24.8 days; a token that lives longer is simply renewed on reconnect.
        if (refreshAt != DateTimeOffset.MaxValue && untilRefresh < TimeSpan.FromDays(1)) sessionCts.CancelAfter(untilRefresh);

        try
        {
            while (true)
            {
                var message = await socket.ReceiveAsync(sessionCts.Token).ConfigureAwait(false);
                if (message is null)
                {
                    Log?.Invoke("[realtime] closed");
                    return new Outcome(subscribed, false, null);
                }
                foreach (var frame in CentrifugoProtocol.Parse(message))
                {
                    switch (frame)
                    {
                        case CentrifugoFrame.Ping:
                            await socket.SendAsync(CentrifugoProtocol.Pong, ct).ConfigureAwait(false);
                            break;
                        case CentrifugoFrame.Reply { Id: 3, Error: { } presenceError }:
                            Log?.Invoke($"[realtime] presence error {presenceError}");
                            break;
                        case CentrifugoFrame.Reply { Id: 3 }:
                            Log?.Invoke($"[realtime] joined {presence?.Channel}");
                            PresenceJoined?.Invoke();
                            break;
                        case CentrifugoFrame.Reply { Error: { } error }:
                            Log?.Invoke($"[realtime] error {error}");
                            return new Outcome(subscribed, false, null);
                        case CentrifugoFrame.Reply { Id: 1 }:
                            await socket.SendAsync(CentrifugoProtocol.Subscribe(2, sub.Channel, sub.Token), ct).ConfigureAwait(false);
                            break;
                        case CentrifugoFrame.Reply { Id: 2 }:
                            subscribed = true;
                            SetConnected(true);
                            Log?.Invoke($"[realtime] subscribed {sub.Channel}");
                            if (presence is { Channel: { } pc, Token: { } pt })
                                await socket.SendAsync(CentrifugoProtocol.Subscribe(3, pc, pt), ct).ConfigureAwait(false);
                            break;
                        case CentrifugoFrame.Disconnect:
                            Log?.Invoke("[realtime] server disconnect");
                            return new Outcome(subscribed, false, null);
                        case CentrifugoFrame.Publication { Event: var ev }:
                            // A resubscribe can replay recent publications.
                            if (ev.IsMessage && ev.MessageId is { } id)
                            {
                                if (!_seen.Add(id)) break;
                                if (_seen.Count > 500) _seen.Clear();
                            }
                            EventReceived?.Invoke(ev);
                            break;
                    }
                }
            }
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            // The tokens are about to expire: reconnect with fresh ones straight away.
            Log?.Invoke("[realtime] refreshing tokens");
            return new Outcome(subscribed, true, TimeSpan.Zero);
        }
    }

    public async ValueTask DisposeAsync()
    {
        if (_cts is null) return;
        await _cts.CancelAsync().ConfigureAwait(false);
        if (_loop is not null)
        {
            try
            {
                await _loop.ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
            }
        }
        _cts.Dispose();
        _cts = null;
        _loop = null;
    }
}
