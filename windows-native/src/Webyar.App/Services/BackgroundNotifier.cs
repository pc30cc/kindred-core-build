using Webyar.App.Helpers;
using Webyar.Core.Api;
using Webyar.Core.Inbox;

namespace Webyar.App.Services;

/// <summary>
/// Keeps an eye on the open queue whether or not the window is showing — the
/// window can be minimized or closed to the tray — and raises a Windows toast
/// for each new visitor message the operator's own preferences allow. Runs at
/// once on every realtime event, otherwise on the platform's poll interval.
/// </summary>
public sealed class BackgroundNotifier : IDisposable
{
    private static readonly TimeSpan PrefsTtl = TimeSpan.FromMinutes(5);

    private readonly AppHost _host;
    private readonly string _workspaceId;
    private readonly NotificationRules _rules = new();
    private readonly Poller _poller;
    private NotificationPrefs? _prefs;
    private DateTimeOffset _prefsAt;

    public BackgroundNotifier(AppHost host, string workspaceId)
    {
        _host = host;
        _workspaceId = workspaceId;
        _poller = new Poller("notifier", TickAsync, () => _host.PollInterval(TimeSpan.FromSeconds(_host.Config.PollIntervalSeconds)));
        _host.InboxChanged += OnInboxChanged;
    }

    /// <summary>The conversation on screen right now, which needs no toast while the window has focus.</summary>
    public Func<string?>? VisibleConversation { get; set; }

    /// <summary>Unread visitor messages across the open queue, after every check.</summary>
    public event Action<int>? UnreadChanged;

    public void Start() => _poller.Start();

    public void Kick() => _poller.Kick();

    private void OnInboxChanged(Core.Realtime.InboxEvent e)
    {
        if (e.IsMessage) _poller.Kick();
    }

    private async Task TickAsync(CancellationToken ct)
    {
        var open = await _host.Api.ConversationsAsync(_workspaceId, InboxFilter.Open, ct);
        UnreadChanged?.Invoke(open.Sum(c => Math.Max(0, c.UnreadCount ?? 0)));

        var fresh = _rules.Fresh(open);
        if (fresh.Count == 0 || !_host.Settings.Notifications) return;

        var prefs = await PrefsAsync(ct);
        if (!NotificationRules.Allowed(prefs, DateTimeOffset.Now)) return;

        var s = _host.Strings;
        var visible = VisibleConversation?.Invoke();
        foreach (var c in fresh.Take(3))
        {
            if (!NotificationRules.InScope(prefs, c, _host.User?.Id)) continue;
            if (c.Id == visible && App.Current.Window?.IsForeground == true) continue;
            var name = Display.ContactName(c.Contacts, s);
            var body = prefs.PushPreview ? Display.Preview(c.LastMessage, s) : s["newMessage"];
            _host.Notifier.Show(
                s.Get("newMessageFrom", "name", name),
                body.Length > 0 ? body : s["newMessage"],
                rtl: s.IsRightToLeft,
                silent: !(prefs.PlaySound && _host.Settings.NotificationSound),
                new Dictionary<string, string> { ["conversation"] = c.Id, ["workspace"] = _workspaceId });
        }
    }

    private async Task<NotificationPrefs> PrefsAsync(CancellationToken ct)
    {
        if (_prefs is not null && DateTimeOffset.UtcNow - _prefsAt < PrefsTtl) return _prefs;
        try
        {
            _prefs = await _host.Api.NotificationPrefsAsync(ct);
            _prefsAt = DateTimeOffset.UtcNow;
        }
        catch (ApiException) when (_prefs is not null)
        {
            // Keep the last answer rather than going quiet or noisy on a blip.
        }
        return _prefs ?? new NotificationPrefs();
    }

    public void Dispose()
    {
        _host.InboxChanged -= OnInboxChanged;
        _poller.Dispose();
    }
}
