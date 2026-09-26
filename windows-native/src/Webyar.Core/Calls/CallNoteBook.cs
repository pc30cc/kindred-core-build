namespace Webyar.Core.Calls;

public enum NoteSending
{
    /// <summary>On the server.</summary>
    No,
    /// <summary>This operator's note on its way.</summary>
    Going,
    /// <summary>It did not get there: shown, marked, to send again or discard.</summary>
    Failed,
}

/// <summary>A note beside a call: the call's own on the desk, the conversation's internal notes on a conversation call.</summary>
public sealed record CallNoteItem(string Id, string Text, string? Author, DateTimeOffset? At, NoteSending Sending = NoteSending.No);

/// <summary>
/// The notes beside a running call (the Mac's LiveCall notes): the saved ones
/// as last read, then this operator's own still on their way. A note shows the
/// moment it is written and the box empties; if it does not reach the server it
/// stays, marked, to send again or discard.
/// </summary>
public sealed class CallNoteBook
{
    /// <summary>As the notes box allows, and the server.</summary>
    public const int MaxLength = 2000;

    private readonly List<CallNoteItem> _outbox = [];

    /// <summary>The newest read of the saved notes, oldest first; null until the first read arrives.</summary>
    public IReadOnlyList<CallNoteItem>? Saved { get; private set; }

    public IReadOnlyList<CallNoteItem> Outbox => _outbox;

    /// <summary>What the panel shows: the saved notes, then those still on their way; null while nothing is known yet.</summary>
    public IReadOnlyList<CallNoteItem>? Shown =>
        Saved is null ? (_outbox.Count == 0 ? null : _outbox.ToList()) : [.. Saved, .. _outbox];

    public bool HasFailed => _outbox.Any(n => n.Sending == NoteSending.Failed);

    public void SetSaved(IEnumerable<CallNoteItem> notes) =>
        Saved = notes.OrderBy(n => n.At ?? DateTimeOffset.MinValue).ToList();

    /// <summary>A read failed before any succeeded: show "no notes" rather than wait forever.</summary>
    public void SavedUnavailable() => Saved ??= [];

    /// <summary>A new note on its way; null for an empty one. Longer than the limit is cut to it.</summary>
    public CallNoteItem? Add(string text, string? author, DateTimeOffset now)
    {
        var body = (text ?? string.Empty).Trim();
        if (body.Length == 0) return null;
        if (body.Length > MaxLength) body = body[..MaxLength];
        var note = new CallNoteItem("local-" + Guid.NewGuid().ToString("N"), body, author, now, NoteSending.Going);
        _outbox.Add(note);
        return note;
    }

    /// <summary>On the server (and in the saved notes read just after): off the outbox.</summary>
    public void Delivered(string id) => _outbox.RemoveAll(n => n.Id == id);

    public void Failed(string id) => Set(id, NoteSending.Failed);

    /// <summary>Sends a failed note again: marked as going and handed back to be sent; null if there is none.</summary>
    public CallNoteItem? Retry(string id)
    {
        var i = _outbox.FindIndex(n => n.Id == id && n.Sending == NoteSending.Failed);
        if (i < 0) return null;
        _outbox[i] = _outbox[i] with { Sending = NoteSending.Going };
        return _outbox[i];
    }

    /// <summary>Drops a note that did not get through.</summary>
    public bool Discard(string id) => _outbox.RemoveAll(n => n.Id == id && n.Sending == NoteSending.Failed) > 0;

    private void Set(string id, NoteSending sending)
    {
        var i = _outbox.FindIndex(n => n.Id == id);
        if (i >= 0) _outbox[i] = _outbox[i] with { Sending = sending };
    }
}
