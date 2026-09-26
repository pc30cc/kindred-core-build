using Webyar.Core.Api;

namespace Webyar.App.Services;

/// <summary>
/// A call-center caller's OS and country, by visitor session, for their face
/// on the desk, in the ringing banner and in the call window — drawn as
/// everywhere else, their device's logo on its gradient and their flag. The
/// faces that ask in the same moment go in one batched call, as the web desk
/// does; each session is asked once per workspace.
/// </summary>
public sealed class CallerProfiles
{
    private readonly AppHost _host;
    private readonly Dictionary<string, VisitorProfile> _known = new(StringComparer.OrdinalIgnoreCase);
    private readonly HashSet<string> _asked = new(StringComparer.OrdinalIgnoreCase);
    private readonly HashSet<string> _wanted = new(StringComparer.OrdinalIgnoreCase);
    private bool _loading;

    public CallerProfiles(AppHost host) => _host = host;

    /// <summary>Raised on the UI thread when profiles arrive, so the faces on screen can be drawn again.</summary>
    public event Action? Changed;

    /// <summary>What is known of the session now; asks for it (once) when it is not.</summary>
    public VisitorProfile? For(string? sessionId)
    {
        if (string.IsNullOrEmpty(sessionId)) return null;
        if (_known.TryGetValue(sessionId, out var p)) return p;
        Want(sessionId);
        return null;
    }

    /// <summary>
    /// The session's profile is still on its way: its face is a skeleton until
    /// then, so a caller's device logo does not replace a stand-in after paint.
    /// </summary>
    public bool IsPending(string? sessionId) =>
        !string.IsNullOrEmpty(sessionId) && !_known.ContainsKey(sessionId) && !_asked.Contains(sessionId);

    private void Want(string sessionId)
    {
        if (_asked.Contains(sessionId) || !_wanted.Add(sessionId) || _loading) return;
        _loading = true;
        _ = LoadAsync();
    }

    private async Task LoadAsync()
    {
        List<string> ids = [];
        try
        {
            // A moment for the other faces drawn in the same pass to ask too.
            await Task.Delay(150);
            while (_wanted.Count > 0 && _host.Workspace is { } ws)
            {
                var scope = _host.Scope;
                ids = _wanted.ToList();
                _wanted.Clear();
                var got = await _host.Api.SessionProfilesAsync(ws.Id, ids);
                // Switched workspace meanwhile: these callers belong to the old one.
                if (scope != _host.Scope) continue;
                foreach (var (id, p) in got) _known[id] = p;
                _asked.UnionWith(ids);
                ids = [];
                // Also when nothing came back: those faces stop waiting.
                Changed?.Invoke();
            }
        }
        catch (Exception e)
        {
            Log.Error("caller devices", e);
            // Not asked again, and their faces stop waiting: the device logo is a nicety.
            _asked.UnionWith(ids);
            _asked.UnionWith(_wanted);
            _wanted.Clear();
            Changed?.Invoke();
        }
        finally
        {
            _loading = false;
        }
    }

    /// <summary>Another workspace or operator: nothing of the old one's callers is kept.</summary>
    public void Clear()
    {
        _known.Clear();
        _asked.Clear();
        _wanted.Clear();
    }
}
