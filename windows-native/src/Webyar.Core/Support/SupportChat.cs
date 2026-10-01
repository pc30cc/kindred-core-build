using Webyar.Core.Localization;

namespace Webyar.Core.Support;

public enum SupportPhase { Loading, Failed, Loaded }

/// <summary>What the support chat shows, and so what is at its bottom.</summary>
public enum SupportComposer
{
    /// <summary>No conversation is open: a fresh page whose first message opens one.</summary>
    Fresh,

    /// <summary>A conversation is open: its messages, and the composer writes to it.</summary>
    Active,

    /// <summary>The conversation on screen ended while it was open here: its end, its rating, and "start a new one".</summary>
    Ended,
}

/// <summary>
/// The support chat, as the Android app keeps it (SupportViewModels.kt): the
/// conversation that is open, or — with none open — a fresh page, and the
/// composer that writes to it. The conversations that ended are in
/// <see cref="Closed"/>, read back on their own.
///
/// A message or a file shows at once as "sending" and becomes the server's
/// when it lands; one that fails stays, marked, with a retry. The client id
/// travels with every attempt — and a file's bytes stay with it — so a retry
/// never posts twice. Messages go one at a time, in the order they were
/// written, each to the conversation it was written to. Once a conversation
/// has ended nothing more is written to it: a message the team's close
/// overtook is refused (`conversation_ended`) and handed back to the
/// composer, never moved to another conversation.
///
/// Not thread-safe by design: the app calls it on the UI thread, where every
/// await resumes.
/// </summary>
public sealed class SupportChat
{
    private readonly ISupportApi _api;
    private readonly Func<Strings> _strings;
    private readonly Func<DateTimeOffset> _now;
    private readonly Func<string> _newId;
    private readonly SemaphoreSlim _sending = new(1, 1);
    private readonly HashSet<string> _ratingBusy = [];

    private int _historyGeneration;
    private int _statusGeneration;
    private HashSet<string>? _knownTeamItems;
    private bool _teamNewsUnread;
    private bool _visible;

    public SupportChat(ISupportApi api, Func<Strings> strings, Func<DateTimeOffset>? now = null, Func<string>? newId = null)
    {
        _api = api;
        _strings = strings;
        _now = now ?? (() => DateTimeOffset.Now);
        _newId = newId ?? (() => Guid.NewGuid().ToString());
    }

    /// <summary>Anything shown changed: the history, the status, a notice, the draft or a rating on its way.</summary>
    public event Action? Changed;

    public SupportPhase Phase { get; private set; } = SupportPhase.Loading;

    /// <summary>Why the chat could not be read, while it never has been.</summary>
    public string? FailedMessage { get; private set; }

    public IReadOnlyList<SupportConversation> Conversations { get; private set; } = [];
    public IReadOnlyList<SupportItem> Items { get; private set; } = [];
    public string? ActiveConversationId { get; private set; }
    public IReadOnlyList<PendingSupportItem> Pending { get; private set; } = [];

    /// <summary>
    /// The conversation on screen when none is open: one that ended while it
    /// was open here. Null for a fresh start.
    /// </summary>
    public string? EndedHereId { get; private set; }

    /// <summary>Who answers and whether they are there; null until the first answer, then kept while a later read fails.</summary>
    public SupportStatus? Status { get; private set; }

    /// <summary>Something to tell the operator: a send that failed, a file refused.</summary>
    public string? Notice { get; private set; }

    /// <summary>What is in the composer; the chat hands a refused message back into it.</summary>
    public string Draft { get; private set; } = string.Empty;

    /// <summary>Conversations whose rating is on its way; their button waits.</summary>
    public IReadOnlySet<string> RatingBusy => _ratingBusy;

    public string? WorkspaceId { get; set; }

    /// <summary>On screen: what the team writes is being read, and "unread" is cleared.</summary>
    public bool Visible
    {
        get => _visible;
        set
        {
            if (_visible == value) return;
            _visible = value;
            if (value) MarkReadIfDue();
        }
    }

    public SupportConversation? Shown => Conversations.FirstOrDefault(c => c.Id == (ActiveConversationId ?? EndedHereId));

    public SupportComposer Composer =>
        ActiveConversationId is not null ? SupportComposer.Active
        : Shown?.Ended == true ? SupportComposer.Ended
        : SupportComposer.Fresh;

    public IReadOnlyList<SupportItem> ShownItems => Shown is { } c ? Items.Where(i => i.ConversationId == c.Id).ToList() : [];

    /// <summary>Every conversation that has ended, the newest first.</summary>
    public IReadOnlyList<SupportConversation> Closed => SupportRules.Closed(Conversations);

    public bool IsEmpty => ShownItems.Count == 0 && Pending.Count == 0;

    /// <summary>The chat's rows: the conversation shown, then what is on its way.</summary>
    public IReadOnlyList<SupportRow> Rows(TimeZoneInfo? zone = null) =>
        SupportTimeline.Build(Shown is { } c ? [c] : [], ShownItems, Pending, zone);

    public SupportConversation? Conversation(string id) => Conversations.FirstOrDefault(c => c.Id == id);

    public IReadOnlyList<SupportItem> ItemsOf(string id) => Items.Where(i => i.ConversationId == id).ToList();

    public string? Preview(string id) => SupportRules.Preview(id, Items);

    public void SetDraft(string value)
    {
        if (Draft == value) return;
        Draft = value;
    }

    public void ClearNotice()
    {
        if (Notice is null) return;
        Notice = null;
        Raise();
    }

    /// <summary>Something the page could not do — a file that would not open.</summary>
    public void Report(string message)
    {
        Notice = message;
        Raise();
    }

    public Task RefreshAsync() => Task.WhenAll(LoadStatusAsync(), LoadHistoryAsync());

    public async Task LoadStatusAsync()
    {
        var generation = ++_statusGeneration;
        try
        {
            var status = await _api.StatusAsync();
            if (generation != _statusGeneration) return;
            Status = status;
            MarkReadIfDue();
            Raise();
        }
        catch (Exception e) when (e is not OperationCanceledException)
        {
            // Kept as it was: a status that fails to refresh is not news.
        }
    }

    public async Task LoadHistoryAsync()
    {
        var generation = ++_historyGeneration;
        try
        {
            var history = await _api.HistoryAsync();
            if (generation != _historyGeneration) return;
            ApplyHistory(history);
        }
        catch (Exception e) when (e is not OperationCanceledException)
        {
            if (generation != _historyGeneration) return;
            // A read that fails over a chat on screen keeps it; only a chat that never arrived shows the failure.
            if (Phase == SupportPhase.Loaded) return;
            Phase = SupportPhase.Failed;
            FailedMessage = SupportRules.ErrorText(e, _strings());
            Raise();
        }
    }

    /// <summary>A read is on its way again after a failure: the page shows its skeleton, not the old error.</summary>
    public void Retry()
    {
        if (Phase != SupportPhase.Failed) return;
        Phase = SupportPhase.Loading;
        FailedMessage = null;
        Raise();
        _ = RefreshAsync();
    }

    private void ApplyHistory(SupportHistory history)
    {
        var conversations = history.Conversations ?? [];
        var items = history.Items ?? [];
        var delivered = items.Select(i => i.ClientMessageId).Where(id => id is not null).ToHashSet();
        var arriving = Phase != SupportPhase.Loaded;
        // Arriving, an open conversation is shown, else a fresh page. Already
        // here, the conversation on screen stays when it ends, until the
        // operator starts a new one.
        string? endedHere = null;
        if (history.ActiveConversationId is null && !arriving)
        {
            var onScreen = ActiveConversationId ?? EndedHereId;
            endedHere = onScreen is not null && conversations.Any(c => c.Id == onScreen) ? onScreen : null;
        }
        Conversations = conversations;
        Items = items;
        ActiveConversationId = history.ActiveConversationId;
        Pending = Pending.Where(p => !delivered.Contains(p.ClientMessageId)).ToList();
        EndedHereId = endedHere;
        Phase = SupportPhase.Loaded;
        FailedMessage = null;

        var team = items.Where(i => i.FromTeam && !i.IsJoin).Select(i => i.Id).ToHashSet();
        if (_knownTeamItems is { } known && !team.IsSubsetOf(known)) _teamNewsUnread = true;
        _knownTeamItems = team;
        MarkReadIfDue();
        Raise();
    }

    /// <summary>
    /// Tells the server the chat has been read — while it is on screen, and
    /// only when there is something to read: an unread count, or a reply
    /// that arrived since the last look.
    /// </summary>
    private void MarkReadIfDue()
    {
        if (!_visible) return;
        var unread = (Status?.Unread ?? 0) > 0;
        if (!unread && !_teamNewsUnread) return;
        _teamNewsUnread = false;
        if (Status is { } s) Status = s with { Unread = 0 };
        _ = MarkReadAsync();
    }

    private async Task MarkReadAsync()
    {
        try
        {
            await _api.MarkReadAsync();
        }
        catch (Exception e) when (e is not OperationCanceledException)
        {
            // The next look marks it again.
        }
    }

    /// <summary>After the conversation on screen ended: a fresh page whose first message opens a new conversation.</summary>
    public void StartNewConversation()
    {
        if (Phase != SupportPhase.Loaded || Composer != SupportComposer.Ended) return;
        EndedHereId = null;
        Raise();
    }

    /// <summary>
    /// Sends <see cref="Draft"/> (or <paramref name="text"/>). False when
    /// nothing was taken — empty, too long, or nowhere to write — and the
    /// draft stays.
    /// </summary>
    public async Task<bool> SendAsync(string? text = null)
    {
        var body = (text ?? Draft).Trim();
        if (body.Length == 0) return false;
        if (body.Length > SupportRules.MaxBody)
        {
            Report(_strings().Get("supportMessageTooLong", "n", SupportRules.MaxBody));
            return false;
        }
        var entry = Enqueue(target => new PendingSupportItem(_newId(), body, _now(), ConversationId: target));
        if (entry is null) return false;
        Draft = string.Empty;
        Raise();
        await DeliverAsync(entry);
        return true;
    }

    /// <summary>
    /// A picked file. Refused here, before a byte is sent, when the server
    /// would refuse it: over 2 MB, or not one of the six types.
    /// </summary>
    public async Task<bool> SendFileAsync(byte[] data, string fileName, string? mimeType)
    {
        var s = _strings();
        switch (SupportRules.CheckFile(mimeType, data.LongLength))
        {
            case SupportRules.FileVerdict.TypeNotAllowed:
                Report(s["supportFileTypeNotAllowed"]);
                return false;
            case SupportRules.FileVerdict.TooLarge:
                Report(s["supportFileTooLarge"]);
                return false;
            case SupportRules.FileVerdict.Empty:
                Report(s["attachmentFailed"]);
                return false;
        }
        var entry = Enqueue(target => new PendingSupportItem(_newId(), string.Empty, _now(), new SupportUpload(data, fileName, mimeType!), ConversationId: target));
        if (entry is null) return false;
        Raise();
        await DeliverAsync(entry);
        return true;
    }

    /// <summary>Tries a message or file that did not go through again, with the same id.</summary>
    public Task RetryAsync(string clientMessageId)
    {
        var entry = Pending.FirstOrDefault(p => p.ClientMessageId == clientMessageId && p.Failed);
        if (entry is null) return Task.CompletedTask;
        var again = entry with { Failed = false };
        Pending = Pending.Select(p => p.ClientMessageId == clientMessageId ? again : p).ToList();
        Raise();
        return DeliverAsync(again);
    }

    /// <summary>Adds what <paramref name="make"/> writes — to the open conversation, or on a fresh page to a new one.</summary>
    private PendingSupportItem? Enqueue(Func<string?, PendingSupportItem> make)
    {
        if (Phase != SupportPhase.Loaded || Composer == SupportComposer.Ended) return null;
        var entry = make(ActiveConversationId);
        Pending = [.. Pending, entry];
        return entry;
    }

    private async Task DeliverAsync(PendingSupportItem entry)
    {
        SupportPostResult result;
        Exception? failure = null;
        await _sending.WaitAsync();
        try
        {
            result = entry.File is { } file
                ? await _api.SendAttachmentAsync(file.FileName, file.MimeType, file.Data, entry.ClientMessageId, entry.ConversationId, WorkspaceId)
                : await _api.SendMessageAsync(entry.Body, entry.ClientMessageId, entry.ConversationId, WorkspaceId);
        }
        catch (Exception e)
        {
            failure = e;
            result = null!;
        }
        finally
        {
            _sending.Release();
        }
        if (failure is not null)
        {
            if (SupportRules.IsConversationEnded(failure))
            {
                HandBack(entry);
                return;
            }
            Pending = Pending.Select(p => p.ClientMessageId == entry.ClientMessageId ? p with { Failed = true } : p).ToList();
            Notice = SupportRules.ErrorText(failure, _strings());
            Raise();
            return;
        }
        Merge(result, entry.ClientMessageId);
        Delivered?.Invoke(entry, result.Item);
        Raise();
        // The team may have answered already, or joined: read the chat as the server has it.
        await LoadHistoryAsync();
    }

    /// <summary>A pending entry landed as the server's <see cref="SupportItem"/> (so the page can carry a picked file's bytes over).</summary>
    public event Action<PendingSupportItem, SupportItem>? Delivered;

    /// <summary>
    /// The team ended the conversation while <paramref name="entry"/> was on
    /// its way to it: it leaves the transcript, its words go back to the
    /// composer for a new conversation, and the chat is read again.
    /// </summary>
    private void HandBack(PendingSupportItem entry)
    {
        var ended = ActiveConversationId is { } active && active == entry.ConversationId ? active : null;
        Pending = Pending.Where(p => p.ClientMessageId != entry.ClientMessageId).ToList();
        if (ActiveConversationId is not null && ActiveConversationId == entry.ConversationId) ActiveConversationId = null;
        EndedHereId = ended ?? EndedHereId;
        if (entry.File is null) Draft = string.IsNullOrWhiteSpace(Draft) ? entry.Body : Draft + "\n" + entry.Body;
        Notice = _strings()["supportConversationEnded"];
        Raise();
        _ = LoadHistoryAsync();
    }

    private void Merge(SupportPostResult result, string clientMessageId)
    {
        var c = result.Conversation;
        Conversations = Conversations.Any(x => x.Id == c.Id) ? Conversations.Select(x => x.Id == c.Id ? c : x).ToList() : [.. Conversations, c];
        if (!Items.Any(i => i.Id == result.Item.Id)) Items = [.. Items, result.Item];
        if (!c.Ended) ActiveConversationId = c.Id;
        Pending = Pending.Where(p => p.ClientMessageId != clientMessageId).ToList();
    }

    /// <summary>
    /// Rates a conversation once. A second tap while the first is on its way,
    /// or after it landed, does nothing; one the server says is rated
    /// already, or cannot be, is simply read again.
    /// </summary>
    public async Task RateAsync(string conversationId, int score, string? comment)
    {
        var c = Conversation(conversationId);
        if (c is null || score is < 1 or > 5 || _ratingBusy.Contains(c.Id) || !c.CanRate) return;
        _ratingBusy.Add(c.Id);
        Raise();
        var text = comment?.Trim();
        if (text is { Length: > SupportRules.MaxComment }) text = text[..SupportRules.MaxComment];
        try
        {
            var rated = await _api.RateAsync(c.Id, score, string.IsNullOrEmpty(text) ? null : text);
            Conversations = Conversations.Select(x => x.Id == rated.Id ? rated : x).ToList();
        }
        catch (Exception e) when (e is not OperationCanceledException)
        {
            if (SupportRules.IsStaleRating(e)) _ = LoadHistoryAsync();
            else Notice = SupportRules.ErrorText(e, _strings());
        }
        finally
        {
            _ratingBusy.Remove(c.Id);
        }
        Raise();
    }

    private void Raise() => Changed?.Invoke();
}
