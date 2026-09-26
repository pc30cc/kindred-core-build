using System.Collections.ObjectModel;
using Microsoft.UI.Input;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Controls.Primitives;
using Microsoft.UI.Xaml.Input;
using Webyar.App.Helpers;
using Webyar.App.Services;
using Webyar.App.ViewModels;
using Webyar.Core.Api;
using Webyar.Core.Inbox;
using Webyar.Core.Localization;
using Webyar.Core.Realtime;
using Webyar.Core.Sync;
using Windows.System;
using Windows.UI.Core;

namespace Webyar.App.Views;

/// <summary>
/// One thread: header with the conversation's actions, the messages with
/// their files, the reply box with attachments and saved replies, and the
/// details panel beside it.
/// </summary>
public sealed partial class ChatView : UserControl
{
    private const long MaxUpload = 20 * 1024 * 1024;
    private static bool _detailsOpen = true;

    private readonly ObservableCollection<MessageItem> _messages = [];
    private readonly List<MessageItem> _outbox = [];

    /// <summary>The file each optimistic reply carries, so a retry resends its own file and no other.</summary>
    private readonly Dictionary<MessageItem, (string Name, string Mime, byte[] Data)> _outboxFiles = [];
    private Poller? _poller;

    /// <summary>Numbers each sync as it starts; a reply confirmed by the server is dropped from the outbox by the first sync after it.</summary>
    private int _syncStarted;

    /// <summary>The server's answer is on screen for this thread; the PC's copy (read in parallel) must not replace it.</summary>
    private bool _serverShown;
    private string? _id;
    private Conversation? _conversation;
    private string? _lastSeenMessage;
    private (string Name, string Mime, byte[] Data)? _pendingFile;

    /// <summary>The message the next send answers (the reply bar above the composer).</summary>
    private MessageItem? _replyTo;

    /// <summary>The AI answers this thread; the composer sends through it (say-now).</summary>
    private bool _aiMode;

    /// <summary>"specialist" or "assistant", kept for the session as on iOS.</summary>
    private static string _voice = "specialist";

    public ChatView()
    {
        InitializeComponent();
        Messages.ItemsSource = _messages;
        DetailsToggle.IsChecked = _detailsOpen;
        SizeChanged += (_, _) => ApplyDetailsVisibility();
        Details.Changed += () =>
        {
            _poller?.Kick();
            StatusChanged?.Invoke();
        };
        ApplyLanguage();
    }

    private static AppHost Host => App.Current.Host;

    /// <summary>Raised after an action changes the conversation, so the list can refresh at once.</summary>
    public event Action? StatusChanged;

    public void Show(Conversation c)
    {
        if (c.Id == _id)
        {
            Refresh(c);
            return;
        }
        Start(c.Id);
        Refresh(c);
    }

    /// <summary>A conversation the list has not loaded (e.g. opened from a toast in another filter).</summary>
    public void ShowById(string id)
    {
        if (id == _id) return;
        Start(id);
        _conversation = null;
        NameText.Text = Host.Strings["unknownVisitor"];
        HeaderAvatar.DisplayName = null;
        HeaderAvatar.Os = null;
        SubText.Text = string.Empty;
        AssignButton.Visibility = Visibility.Collapsed;
        StatusButton.Visibility = Visibility.Collapsed;
    }

    /// <summary>New list data for the open conversation: header, actions and details follow it.</summary>
    public void RefreshTheme()
    {
        if (_conversation is not { } c) return;
        Refresh(c);
    }


    /// <summary>A header action: its icon, then its label.</summary>
    private static StackPanel Labeled(string glyph, string text) => new()
    {
        Orientation = Orientation.Horizontal,
        Spacing = 7,
        Children =
        {
            new FontIcon { Glyph = glyph, FontSize = 13 },
            new TextBlock { Text = text, VerticalAlignment = VerticalAlignment.Center },
        },
    };
    public void Refresh(Conversation c)
    {
        if (c.Id != _id) return;
        var first = _conversation is null;
        _conversation = c;
        var s = Host.Strings;
        var name = Display.ConversationName(c, s);
        NameText.Text = name;
        HeaderAvatar.DisplayName = c.Contacts?.Name;
        HeaderAvatar.Email = c.Contacts?.Email;
        HeaderAvatar.Os = c.VisitorOs;
        HeaderAvatar.CountryCode = c.VisitorCountryCode;
        HeaderAvatar.ImageUrl = c.Contacts?.AvatarUrl;
        HeaderAvatar.PresenceState = c.Status;
        // Messages can load before the conversation itself (opened from a toast).
        foreach (var m in _messages.Where(m => m.Side == MessageSide.Incoming))
        {
            m.AvatarName = c.Contacts?.Name ?? string.Empty;
            m.AvatarEmail = c.Contacts?.Email;
            m.AvatarOs = c.VisitorOs;
            m.AvatarUrl = c.Contacts?.AvatarUrl;
        }

        var (fore, back) = Palette.Status(c.Status);
        StatusChip.Background = Palette.Resource(back);
        StatusText.Foreground = Palette.Resource(fore);
        StatusText.Text = StatusLabel(c.Status, s);

        var showPriority = c.Priority is ConversationPriorities.High or ConversationPriorities.Urgent or ConversationPriorities.Low;
        PriorityChip.Visibility = showPriority ? Visibility.Visible : Visibility.Collapsed;
        if (showPriority)
        {
            var (pf, pb) = Palette.Priority(c.Priority);
            PriorityChip.Background = Palette.Resource(pb);
            PriorityText.Foreground = Palette.Resource(pf);
            PriorityText.Text = PriorityLabel(c.Priority, s);
        }

        var assignee = c.AssignedTo is null ? s["unassigned"] : c.AssignedTo == Host.User?.Id ? s["assignedToYou"] : Host.MemberName(c.AssignedTo);
        SubText.Text = string.Join(" · ", new[] { c.Contacts?.Email, assignee }.Where(x => !string.IsNullOrWhiteSpace(x)));

        var resolved = c.Status is ConversationStatuses.Resolved or ConversationStatuses.Closed;
        StatusButton.Content = Labeled(resolved ? "\uE72C" : "\uE73E", resolved ? s["reopen"] : s["markResolved"]);
        StatusButton.Visibility = Visibility.Visible;
        var aiActive = c.IsAiManaged;
        AssignButton.Content = Labeled(aiActive ? "\uE77B" : "\uE8FA", aiActive ? s["takeOver"] : s["assignToMe"]);
        AssignButton.Visibility = !resolved && (aiActive || c.AssignedTo != Host.User?.Id) && Host.User is not null ? Visibility.Visible : Visibility.Collapsed;
        AiChip.Visibility = aiActive ? Visibility.Visible : Visibility.Collapsed;

        // No calls while the AI has the visitor, and only what the plan allows.
        var calls = Host.Config.CallsEnabled && !resolved && !aiActive;
        AudioCallButton.Visibility = calls && Host.Plan.VoiceCalls ? Visibility.Visible : Visibility.Collapsed;
        VideoCallButton.Visibility = calls && Host.Plan.VideoCalls ? Visibility.Visible : Visibility.Collapsed;

        SetComposerMode(aiActive);

        Details.Show(c, first);
        ApplyDetailsVisibility();
    }

    public void Close()
    {
        _poller?.Dispose();
        _poller = null;
        Host.InboxChanged -= OnInboxChanged;
        Host.PlanChanged -= OnPlanChanged;
        Host.RealtimeChanged -= OnRealtimeChanged;
        _id = null;
        Details.Close();
    }

    private void Start(string id)
    {
        Close();
        _id = id;
        DockSlot.Key = $"conv:{id}";
        _lastSeenMessage = null;
        _serverShown = false;
        _messages.Clear();
        // Replies that failed and are left behind: their picked files need not stay in memory.
        foreach (var o in _outbox.Where(o => o.Failed))
        {
            foreach (var a in o.Attachments) AttachmentItem.Forget(a.Id);
        }
        _outbox.Clear();
        _outboxFiles.Clear();
        if (_recorder is not null) _ = StopRecordingAsync(keep: false);
        ClearPendingFile();
        ClearReply();
        SetComposerMode(false);
        AiChip.Visibility = Visibility.Collapsed;
        Error.IsOpen = false;
        Composer.Text = string.Empty;
        Placeholder.Visibility = Visibility.Collapsed;
        ThreadPanel.Visibility = Visibility.Visible;
        Loading.IsActive = true;
        Loading.Visibility = Visibility.Visible;
        Host.InboxChanged += OnInboxChanged;
        Host.PlanChanged += OnPlanChanged;
        Host.RealtimeChanged += OnRealtimeChanged;
        _poller = new Poller("thread", ct => LoadAsync(id, ct), () => Host.PollInterval(TimeSpan.FromSeconds(Math.Min(5, Host.Config.PollIntervalSeconds))));
        // The thread as this PC last saw it, at once (offline too); the sync then brings only what changed.
        _ = ShowLocalAsync(id);
        _poller.Start();
        Composer.Focus(FocusState.Programmatic);
    }

    private void OnPlanChanged()
    {
        if (_conversation is { } c) Refresh(c);
    }

    private void OnInboxChanged(InboxEvent e)
    {
        // A message or a change in this thread: a delta sync, never the whole history again.
        if (e.ConversationId is null || e.ConversationId == _id) _poller?.Kick();
    }

    /// <summary>Realtime reconnected (events may have been missed) or dropped: sync now.</summary>
    private void OnRealtimeChanged(bool up) => _poller?.Kick();

    private async Task ShowLocalAsync(string id)
    {
        if (Host.Workspace is not { } ws) return;
        var scope = Host.Scope;
        var local = await Host.Threads.LoadLocalAsync(ws.Id, id);
        if (local is null || id != _id || scope != Host.Scope || _serverShown) return;
        Render(local.Messages, sync: 0);
        Log.Write($"[chat] thread shown from the PC: {local.Messages.Count} messages");
        Loading.IsActive = false;
        Loading.Visibility = Visibility.Collapsed;
    }

    private async Task LoadAsync(string id, CancellationToken ct)
    {
        if (Host.Workspace is not { } ws) return;
        var scope = Host.Scope;
        var sync = ++_syncStarted;
        try
        {
            var snapshot = await Host.Threads.SyncAsync(ws.Id, id, ct);
            if (id != _id || scope != Host.Scope) return; // another thread or workspace since
            _serverShown = true;
            Render(snapshot.Messages, sync);

            // Seen once per new message, and only while someone is actually looking.
            var newest = snapshot.Messages.LastOrDefault(m => m.SenderType == SenderTypes.Contact)?.Id;
            if (newest is not null && newest != _lastSeenMessage && App.Current.Window?.IsForeground == true)
            {
                _lastSeenMessage = newest;
                _ = MarkSeenAsync(id);
            }
        }
        catch (ApiException e) when (e.Failure == ApiFailure.Server && e.Status is 403 or 404 && id == _id)
        {
            // Deleted, or no longer this operator's: nothing of it stays on screen (or on the PC).
            _messages.Clear();
            ShowError(ErrorText.For(e, Host.Strings));
            throw;
        }
        finally
        {
            if (id == _id)
            {
                Loading.IsActive = false;
                Loading.Visibility = Visibility.Collapsed;
            }
        }
    }

    /// <summary>
    /// Draws <paramref name="list"/> plus the replies still on their way. A
    /// reply leaves the outbox once its stored copy (same client_message_id) is
    /// in the thread, or — for a copy that cannot be matched — once a sync
    /// that started after the send has come back; never earlier, so it neither
    /// shows twice nor blinks out.
    /// </summary>
    private void Render(IReadOnlyList<Message> list, int sync)
    {
        var s = Host.Strings;
        var contact = _conversation?.Contacts;
        var os = _conversation?.VisitorOs;

        var pending = Outbox.StillPending(_outbox, o => o.ClientId, list)
            .Where(o => !(o.ConfirmedBySync > 0 && sync >= o.ConfirmedBySync))
            .ToHashSet();
        foreach (var done in _outbox.Where(o => !pending.Contains(o)).ToList())
        {
            _outbox.Remove(done);
            _outboxFiles.Remove(done);
        }

        var wanted = new List<MessageItem>();
        DateTime? day = null;
        foreach (var m in list)
        {
            var item = new MessageItem(m, s);
            if (item.Side == MessageSide.Incoming)
            {
                item.AvatarName = contact?.Name ?? string.Empty;
                item.AvatarEmail = contact?.Email;
                item.AvatarUrl = contact?.AvatarUrl;
                item.AvatarOs = os;
            }
            if (item.CreatedAt is { } at && at.ToLocalTime().Date != day)
            {
                day = at.ToLocalTime().Date;
                wanted.Add(MessageItem.DaySeparator(at, s));
            }
            wanted.Add(item);
        }
        // Replies show what they answer, from the thread itself.
        var byId = wanted.Where(w => w.Side is MessageSide.Incoming or MessageSide.Outgoing).GroupBy(w => w.Id).ToDictionary(g => g.Key, g => g.First());
        foreach (var w in wanted)
        {
            if (w.ReplyToId is { } rid && byId.TryGetValue(rid, out var target)) w.SetQuote(target, s);
        }
        wanted.AddRange(_outbox);
        Group(wanted);
        Sync(wanted);
    }

    private static async Task MarkSeenAsync(string id)
    {
        try
        {
            await Host.Api.MarkSeenAsync(id);
        }
        catch (ApiException e)
        {
            Log.Error("mark seen", e);
        }
    }

    /// <summary>
    /// As in the web thread: the avatar and the name · time line sit under the
    /// last bubble of a run from one sender; a new day or a pause of more than
    /// five minutes starts a new run.
    /// </summary>
    private static void Group(IList<MessageItem> items)
    {
        for (var i = 0; i < items.Count; i++)
        {
            var m = items[i];
            if (m.Side is not (MessageSide.Incoming or MessageSide.Outgoing)) continue;
            var next = i + 1 < items.Count ? items[i + 1] : null;
            var continues = next is not null && next.RunKey == m.RunKey &&
                (next.CreatedAt is not { } b || m.CreatedAt is not { } a || b - a <= TimeSpan.FromMinutes(5));
            m.AvatarVisibility = continues ? Visibility.Collapsed : Visibility.Visible;
            m.MetaVisibility = continues && !m.Failed ? Visibility.Collapsed : Visibility.Visible;
        }
    }

    /// <summary>Appends what is new and replaces what changed, leaving the rest where it is.</summary>
    private void Sync(List<MessageItem> wanted)
    {
        var i = 0;
        for (; i < wanted.Count && i < _messages.Count; i++)
        {
            if (!_messages[i].SameAs(wanted[i])) break;
            _messages[i].AvatarVisibility = wanted[i].AvatarVisibility;
            _messages[i].MetaVisibility = wanted[i].MetaVisibility;
        }
        while (_messages.Count > i) _messages.RemoveAt(_messages.Count - 1);
        for (; i < wanted.Count; i++)
        {
            _messages.Add(wanted[i]);
            // Photos only; voice notes wait for Play, documents and videos for Open.
            foreach (var a in wanted[i].Attachments)
            {
                if (a.FetchOnRender) _ = a.LoadPreviewAsync();
            }
        }
    }

    private void ApplyLanguage()
    {
        var s = Host.Strings;
        PlaceholderTitle.Text = s["noConversationSelected"];
        PlaceholderBody.Text = s["noConversationSelectedBody"];
        ToolTipService.SetToolTip(AttachButton, s["attachFile"]);
        ToolTipService.SetToolTip(ShortcutsButton, s["shortcuts"]);
        ToolTipService.SetToolTip(AudioCallButton, s["voiceCall"]);
        ToolTipService.SetToolTip(VideoCallButton, s["videoCall"]);
        ToolTipService.SetToolTip(MoreButton, s["conversationActions"]);
        ToolTipService.SetToolTip(DetailsToggle, s["details"]);
        ShortcutSearch.PlaceholderText = s["searchShortcuts"];
        ToolTipService.SetToolTip(EmojiButton, s["emoji"]);
        ToolTipService.SetToolTip(MicButton, s["voiceRecord"]);
        ToolTipService.SetToolTip(RecordCancelButton, s["voiceDiscard"]);
        ComposerHint.Text = s["composerHint"];
        AiChipText.Text = s["navInboxAi"];
        VoiceSpecialist.Text = s["sayNowVoiceSpecialist"];
        VoiceAssistant.Text = s["sayNowVoiceAssistant"];
        ToolTipService.SetToolTip(VoicePicker, s["sayNowVoice"]);
        VoiceMenu.Placement = s.IsRightToLeft ? FlyoutPlacementMode.TopEdgeAlignedRight : FlyoutPlacementMode.TopEdgeAlignedLeft;
        SetComposerMode(_aiMode);
        EmojiGrid.ItemsSource ??= Emojis;
        // The tool buttons sit at the start edge; the pickers open towards the
        // text (leftwards in Persian) rather than off the side of the window.
        var placement = s.IsRightToLeft ? FlyoutPlacementMode.TopEdgeAlignedRight : FlyoutPlacementMode.TopEdgeAlignedLeft;
        EmojiFlyout.Placement = placement;
        ShortcutsFlyout.Placement = placement;
    }

    /// <summary>The replies an operator reaches for most, in the order a support desk uses them.</summary>
    internal static readonly string[] Emojis =
    [
        "😊", "🙂", "😀", "😁", "😂", "🤣", "😉", "😍", "🥰", "😘",
        "🤗", "🤔", "😅", "😇", "😎", "🥳", "😢", "😔", "😮", "🙏",
        "👍", "👎", "👌", "👏", "🙌", "💪", "🤝", "✌️", "👋", "✅",
        "❌", "⭐", "🔥", "🎉", "❤️", "💙", "💯", "📦", "📞", "📧",
        "⏰", "📍", "💳", "🛒", "🚚", "🎁", "📌", "📝", "⚠️", "ℹ️",
    ];

    private void OnEmojiPicked(object sender, ItemClickEventArgs e)
    {
        if (e.ClickedItem is not string emoji) return;
        var at = Composer.SelectionStart;
        Composer.Text = Composer.Text.Remove(at, Composer.SelectionLength).Insert(at, emoji);
        Composer.SelectionStart = at + emoji.Length;
        EmojiFlyout.Hide();
        Composer.Focus(FocusState.Programmatic);
    }

    /// <summary>The composer card takes the brand colour while it has focus.</summary>
    private void OnComposerFocus(object sender, RoutedEventArgs e) =>
        ComposerCard.BorderBrush = Palette.Resource(Composer.FocusState != FocusState.Unfocused ? "ComposerFocusBrush" : "ComposerBorderBrush");

    private static string StatusLabel(string status, Strings s) => status switch
    {
        ConversationStatuses.Open => s["filterOpen"],
        ConversationStatuses.Pending => s["filterPending"],
        ConversationStatuses.Resolved => s["filterResolved"],
        ConversationStatuses.Closed => s["statusClosed"],
        _ => status,
    };

    public static string PriorityLabel(string? priority, Strings s) => s[priority switch
    {
        ConversationPriorities.Low => "priorityLow",
        ConversationPriorities.High => "priorityHigh",
        ConversationPriorities.Urgent => "priorityUrgent",
        _ => "priorityNormal",
    }];

    // Composer

    /// <summary>
    /// Normal replies, or — on a thread the AI is answering — one field whose
    /// text the AI tells the visitor, with only the voice picker beside it
    /// (no files, voice notes, emoji or saved replies), exactly as on iOS.
    /// Plan features decide the tools otherwise.
    /// </summary>
    private void SetComposerMode(bool ai)
    {
        var s = Host.Strings;
        if (ai && !_aiMode)
        {
            if (_recorder is not null) _ = StopRecordingAsync(keep: false);
            ClearPendingFile();
        }
        _aiMode = ai;
        // Who is answering decides, as the web: not the plan's widget_* keys,
        // which govern what visitors may do in the chat widget (operator files
        // also go to Telegram, WhatsApp and Instagram chats).
        AttachButton.Visibility = ai ? Visibility.Collapsed : Visibility.Visible;
        MicButton.Visibility = ai ? Visibility.Collapsed : Visibility.Visible;
        EmojiButton.Visibility = ai ? Visibility.Collapsed : Visibility.Visible;
        ShortcutsButton.Visibility = ai ? Visibility.Collapsed : Visibility.Visible;
        VoicePicker.Visibility = ai ? Visibility.Visible : Visibility.Collapsed;
        Composer.PlaceholderText = s[ai ? "sayNowPlaceholder" : "messagePlaceholder"];
        ToolTipService.SetToolTip(SendButton, s[ai ? "sayNowAction" : "send"]);
        ComposerHint.Text = ai ? s["sayNowHint"] : s["composerHint"];
        ShowVoice();
        UpdateSendEnabled();
    }

    private void ShowVoice()
    {
        var s = Host.Strings;
        var assistant = _voice == "assistant";
        VoiceGlyph.Glyph = assistant ? "\uE945" : "\uE77B";
        VoiceText.Text = s[assistant ? "sayNowVoiceAssistant" : "sayNowVoiceSpecialist"];
        VoiceSpecialist.IsChecked = !assistant;
        VoiceAssistant.IsChecked = assistant;
    }

    private void OnVoicePicked(object sender, RoutedEventArgs e)
    {
        if (sender is FrameworkElement { Tag: string voice }) _voice = voice;
        ShowVoice();
        Composer.Focus(FocusState.Programmatic);
    }

    /// <summary>The AI says it; the draft stays until that worked, as on iOS.</summary>
    private async Task SayNowAsync(string conversationId, string body)
    {
        var s = Host.Strings;
        SendButton.IsEnabled = false;
        try
        {
            await Host.Api.AiSayNowAsync(conversationId, body, _voice);
            if (conversationId != _id) return;
            Composer.Text = string.Empty;
            Error.Severity = InfoBarSeverity.Success;
            Error.Message = s["sayNowSent"];
            Error.ActionButton = null;
            Error.IsOpen = true;
            _poller?.Kick();
            StatusChanged?.Invoke();
        }
        catch (Exception ex)
        {
            Log.Error("say now", ex);
            if (conversationId != _id) return;
            Error.Severity = InfoBarSeverity.Error;
            Error.Message = $"{s["sayNowFailed"]} — {ErrorText.For(ex, s)}";
            Error.ActionButton = null;
            Error.IsOpen = true;
        }
        finally
        {
            UpdateSendEnabled();
        }
    }

    private void OnComposerChanged(object sender, TextChangedEventArgs e)
    {
        UpdateSendEnabled();
        // A "/" at the start opens the saved replies, as in the web console.
        if (!_aiMode && Composer.Text.StartsWith('/') && !Composer.Text.Contains(' ') && Composer.Text.Length <= 24)
        {
            ShortcutSearch.Text = Composer.Text[1..];
            OpenShortcuts();
        }
    }

    private void UpdateSendEnabled() => SendButton.IsEnabled = Composer.Text.Trim().Length > 0 || _pendingFile is not null;

    /// <summary>Enter sends; Shift+Enter starts a new line, as in the web console.</summary>
    private void OnComposerKeyDown(object sender, KeyRoutedEventArgs e)
    {
        if (e.Key != VirtualKey.Enter) return;
        var shift = InputKeyboardSource.GetKeyStateForCurrentThread(VirtualKey.Shift).HasFlag(CoreVirtualKeyStates.Down);
        if (shift) return;
        e.Handled = true;
        OnSend(this, new RoutedEventArgs());
    }

    private async void OnSend(object sender, RoutedEventArgs e)
    {
        var body = Composer.Text.Trim();
        var file = _pendingFile;
        if ((body.Length == 0 && file is null) || _id is not { } id || Host.Workspace is not { } ws) return;
        if (_aiMode)
        {
            if (body.Length > 0) await SayNowAsync(id, body);
            return;
        }
        Composer.Text = string.Empty;
        ClearPendingFile();
        var replyTo = _replyTo;
        ClearReply();
        var local = file is { } f ? new AttachmentItem(f.Name, f.Mime, f.Data, Host.Strings) : null;
        var item = new MessageItem(Guid.NewGuid().ToString(), body, Host.Strings, local, replyTo)
        {
            SenderId = Host.User?.Id,
            AvatarName = Host.User?.FullName ?? string.Empty,
            AvatarUrl = Host.Account?.AvatarUrl,
        };
        if (local is not null) _ = local.LoadPreviewAsync();
        _outbox.Add(item);
        if (file is { } picked) _outboxFiles[item] = picked;
        _messages.Add(item);
        Group(_messages);
        await SendAsync(id, ws.Id, item, file);
    }

    private async Task SendAsync(string conversationId, string workspaceId, MessageItem item, (string Name, string Mime, byte[] Data)? file)
    {
        try
        {
            item.Failed = false;
            item.Pending = true;
            string? attachmentId = null;
            if (file is { } f)
            {
                attachmentId = await Host.Api.UploadAttachmentAsync(workspaceId, conversationId, f.Name, f.Mime, f.Data);
                if (attachmentId is not null && item.Attachments.FirstOrDefault() is { } local) AttachmentItem.Alias(local.Id, attachmentId, workspaceId);
            }
            // The same client id on every attempt: the server keeps one copy however often this is retried.
            await Host.Api.SendMessageAsync(conversationId, workspaceId, item.Body, item.ClientId!, attachmentId, item.ReplyToId);
            // Stored. The bubble stays until the thread brings the stored copy (realtime, a delta or
            // the next sync), which then takes its place — one message, never two, never none.
            item.Pending = false;
            item.ConfirmedBySync = _syncStarted + 1;
            _poller?.Kick();
            StatusChanged?.Invoke();
        }
        catch (Exception ex)
        {
            Log.Error("send", ex);
            if (conversationId != _id) return;
            item.Pending = false;
            item.Failed = true;
            item.Meta = $"{Host.Strings["sendFailed"]} · {item.Time}";
            Error.Severity = InfoBarSeverity.Error;
            Error.Message = ErrorText.For(ex, Host.Strings);
            Error.ActionButton = RetryButton(() =>
            {
                Error.IsOpen = false;
                foreach (var failed in _outbox.Where(o => o.Failed).ToList())
                    _ = SendAsync(conversationId, workspaceId, failed, _outboxFiles.TryGetValue(failed, out var own) ? own : null);
            });
            Error.IsOpen = true;
        }
    }

    private Button RetryButton(Action retry)
    {
        var b = new Button { Content = Host.Strings["retry"] };
        b.Click += (_, _) => retry();
        return b;
    }

    // Attachments

    private async void OnAttach(object sender, RoutedEventArgs e)
    {
        try
        {
            var picker = new Windows.Storage.Pickers.FileOpenPicker();
            picker.FileTypeFilter.Add("*");
            WinRT.Interop.InitializeWithWindow.Initialize(picker, WinRT.Interop.WindowNative.GetWindowHandle(App.Current.Window!));
            var file = await picker.PickSingleFileAsync();
            if (file is null) return;
            var props = await file.GetBasicPropertiesAsync();
            if ((long)props.Size > MaxUpload)
            {
                ShowError(Host.Strings["fileTooLarge"]);
                return;
            }
            var buffer = await Windows.Storage.FileIO.ReadBufferAsync(file);
            var data = new byte[buffer.Length];
            using (var reader = Windows.Storage.Streams.DataReader.FromBuffer(buffer)) reader.ReadBytes(data);
            await SetPendingAsync(file.Name, string.IsNullOrEmpty(file.ContentType) ? Mime.Of(file.Name) : file.ContentType, data);
            Composer.Focus(FocusState.Programmatic);
        }
        catch (Exception ex)
        {
            Log.Error("pick file", ex);
            ShowError(Host.Strings["attachmentFailed"]);
        }
    }

    private void OnClearPendingFile(object sender, RoutedEventArgs e) => ClearPendingFile();

    // Reply and copy, under every bubble

    private void OnReplyClick(object sender, RoutedEventArgs e)
    {
        if ((sender as FrameworkElement)?.Tag is not MessageItem item || item.Pending || _aiMode) return;
        var s = Host.Strings;
        _replyTo = item;
        ReplyBarTitle.Text = s.Get("replyingTo", "name", item.AuthorLabel(s));
        ReplyBarText.Text = item.Snippet(s);
        ToolTipService.SetToolTip(ReplyBarClose, s["cancelReply"]);
        ReplyBar.Visibility = Visibility.Visible;
        Composer.Focus(FocusState.Programmatic);
    }

    private void OnCancelReply(object sender, RoutedEventArgs e) => ClearReply();

    private void ClearReply()
    {
        _replyTo = null;
        ReplyBar.Visibility = Visibility.Collapsed;
    }

    private void OnCopyClick(object sender, RoutedEventArgs e)
    {
        if ((sender as FrameworkElement)?.Tag is not MessageItem item) return;
        TextClipboard.Copy(item.Body);
        Error.Severity = InfoBarSeverity.Success;
        Error.Message = Host.Strings["copied"];
        Error.ActionButton = null;
        Error.IsOpen = true;
        _ = CloseCopiedSoonAsync();
    }

    private async Task CloseCopiedSoonAsync()
    {
        await Task.Delay(1600);
        if (Error.Severity == InfoBarSeverity.Success) Error.IsOpen = false;
    }

    /// <summary>Tapping a quote brings the original message into view.</summary>
    private void OnQuoteClick(object sender, RoutedEventArgs e)
    {
        if ((sender as FrameworkElement)?.Tag is not MessageItem item || item.ReplyToId is not { } id) return;
        var target = _messages.FirstOrDefault(m => m.Id == id);
        if (target is not null) Messages.ScrollIntoView(target, ScrollIntoViewAlignment.Leading);
    }

    private void ClearPendingFile()
    {
        _pendingFile = null;
        PendingFile.Visibility = Visibility.Collapsed;
        PendingThumb.Source = null;
        PendingThumb.Visibility = Visibility.Collapsed;
        UpdateSendEnabled();
    }

    /// <summary>Puts a file in the composer card — a photo shows its thumbnail — to go out with the next Send.</summary>
    private async Task SetPendingAsync(string name, string mime, byte[] data)
    {
        _pendingFile = (name, mime, data);
        PendingFileName.Text = name;
        PendingFileSize.Text = AttachmentItem.FormatSize(data.LongLength, Host.Strings);
        PendingGlyph.Glyph = mime.StartsWith("audio/", StringComparison.Ordinal) ? "\uE8D6"
            : mime.StartsWith("video/", StringComparison.Ordinal) ? "\uE714" : "\uE8A5";
        PendingThumb.Visibility = Visibility.Collapsed;
        PendingFile.Visibility = Visibility.Visible;
        UpdateSendEnabled();
        if (!mime.StartsWith("image/", StringComparison.Ordinal)) return;
        try
        {
            using var stream = new Windows.Storage.Streams.InMemoryRandomAccessStream();
            await stream.WriteAsync(System.Runtime.InteropServices.WindowsRuntime.WindowsRuntimeBufferExtensions.AsBuffer(data));
            stream.Seek(0);
            var thumb = new Microsoft.UI.Xaml.Media.Imaging.BitmapImage { DecodePixelWidth = 96 };
            await thumb.SetSourceAsync(stream);
            if (_pendingFile?.Data != data) return;
            PendingThumb.Source = thumb;
            PendingThumb.Visibility = Visibility.Visible;
        }
        catch (Exception e)
        {
            Log.Error("pending thumbnail", e);
        }
    }

    // ── Voice notes ──

    private VoiceRecorder? _recorder;
    private Microsoft.UI.Dispatching.DispatcherQueueTimer? _recordTimer;

    private async void OnMic(object sender, RoutedEventArgs e)
    {
        if (_recorder is { IsRecording: true }) await StopRecordingAsync(keep: true);
        else await StartRecordingAsync();
    }

    private async void OnRecordCancel(object sender, RoutedEventArgs e) => await StopRecordingAsync(keep: false);

    private async Task StartRecordingAsync()
    {
        var s = Host.Strings;
        _recorder = new VoiceRecorder();
        try
        {
            await _recorder.StartAsync();
        }
        catch (Exception ex)
        {
            Log.Error("voice record", ex);
            await _recorder.DisposeAsync();
            _recorder = null;
            // Windows keeps desktop apps off the microphone until allowed in Privacy settings.
            Error.Severity = InfoBarSeverity.Error;
            Error.Message = ex is UnauthorizedAccessException || (uint)ex.HResult == 0x80070005 ? s["micBlocked"] : s["micFailed"];
            var open = new Button { Content = s["openWindowsSettings"] };
            open.Click += async (_, _) => await Windows.System.Launcher.LaunchUriAsync(new Uri("ms-settings:privacy-microphone"));
            Error.ActionButton = open;
            Error.IsOpen = true;
            return;
        }
        ShowRecording(true);
        _recordTimer ??= CreateRecordTimer();
        _recordTimer.Start();
    }

    private async Task StopRecordingAsync(bool keep)
    {
        if (_recorder is not { } recorder) return;
        _recorder = null;
        _recordTimer?.Stop();
        ShowRecording(false);
        try
        {
            if (!keep)
            {
                await recorder.CancelAsync();
                return;
            }
            var length = DateTimeOffset.Now - recorder.StartedAt;
            var data = await recorder.StopAsync();
            // A tap on the mic by mistake is not a message.
            if (length < TimeSpan.FromSeconds(1) || data.Length < 1024) return;
            await SetPendingAsync($"voice-note-{DateTime.Now:yyyyMMdd-HHmmss}.m4a", "audio/mp4", data);
        }
        catch (Exception ex)
        {
            Log.Error("voice stop", ex);
            ShowError(Host.Strings["micFailed"]);
        }
    }

    private void ShowRecording(bool on)
    {
        var s = Host.Strings;
        RecordBar.Visibility = on ? Visibility.Visible : Visibility.Collapsed;
        Composer.Visibility = on ? Visibility.Collapsed : Visibility.Visible;
        RecordCancelButton.Visibility = on ? Visibility.Visible : Visibility.Collapsed;
        AttachButton.IsEnabled = EmojiButton.IsEnabled = ShortcutsButton.IsEnabled = !on;
        ComposerHint.Visibility = on ? Visibility.Collapsed : Visibility.Visible;
        MicGlyph.Glyph = on ? "\uE71A" : "\uE720";
        MicButton.Background = on ? Palette.Resource("DangerSoftBrush") : Palette.Transparent;
        ToolTipService.SetToolTip(MicButton, s[on ? "voiceStop" : "voiceRecord"]);
        RecordTime.Text = "0:00";
        RecordHint.Text = s["voiceRecording"];
        RecordDot.Opacity = 1;
        if (!on) Composer.Focus(FocusState.Programmatic);
    }

    private Microsoft.UI.Dispatching.DispatcherQueueTimer CreateRecordTimer()
    {
        var t = DispatcherQueue.CreateTimer();
        t.Interval = TimeSpan.FromMilliseconds(500);
        t.Tick += (_, _) =>
        {
            if (_recorder is not { IsRecording: true } r) return;
            var e = DateTimeOffset.Now - r.StartedAt;
            RecordTime.Text = $"{(int)e.TotalMinutes}:{e.Seconds:00}";
            RecordDot.Opacity = RecordDot.Opacity > 0.5 ? 0.25 : 1;
            // Voice notes are short; the web caps uploads, so stop well before that.
            if (e >= TimeSpan.FromMinutes(5)) _ = StopRecordingAsync(keep: true);
        };
        return t;
    }

    /// <summary>
    /// Opens a viewable file (image, PDF, text, audio, video, Office without macros) with whatever
    /// Windows opens it with; anything that could run code is offered through "Save as" instead.
    /// </summary>
    private async void OnOpenAttachment(object sender, RoutedEventArgs e)
    {
        if ((sender as FrameworkElement)?.Tag is not AttachmentItem a) return;
        try
        {
            if (await OpenedFiles.OpenAsync(a) == OpenedFiles.Outcome.Saved)
            {
                Error.Severity = InfoBarSeverity.Informational;
                Error.Message = OpenedFiles.SavedInsteadMessage(Host.Strings);
                Error.ActionButton = null;
                Error.IsOpen = true;
            }
        }
        catch (Exception ex)
        {
            Log.Error("open attachment", ex);
            ShowError(ErrorText.For(ex, Host.Strings));
        }
    }

    private void ShowError(string message)
    {
        Error.Severity = InfoBarSeverity.Error;
        Error.Message = message;
        Error.ActionButton = null;
        Error.IsOpen = true;
    }

    // Saved replies

    private void OnShortcuts(object sender, RoutedEventArgs e)
    {
        ShortcutSearch.Text = string.Empty;
        OpenShortcuts();
    }

    private void OpenShortcuts()
    {
        FlyoutBase.ShowAttachedFlyout(ShortcutsButton);
        _ = LoadShortcutsAsync(ShortcutSearch.Text);
    }

    private void OnShortcutSearch(AutoSuggestBox sender, AutoSuggestBoxTextChangedEventArgs args)
    {
        if (args.Reason == AutoSuggestionBoxTextChangeReason.UserInput) _ = LoadShortcutsAsync(sender.Text);
    }

    private async Task LoadShortcutsAsync(string query)
    {
        if (Host.Workspace is not { } ws) return;
        var s = Host.Strings;
        try
        {
            var items = await Host.Api.CannedResponsesAsync(ws.Id, Strings.Code(s.Language), query);
            ShortcutList.ItemsSource = items.Select(i => new ShortcutItem(i)).ToList();
            ShortcutEmpty.Text = s["shortcutsEmptyTitle"];
            ShortcutEmpty.Visibility = items.Count == 0 ? Visibility.Visible : Visibility.Collapsed;
        }
        catch (Exception ex)
        {
            Log.Error("saved replies", ex);
            ShortcutList.ItemsSource = null;
            ShortcutEmpty.Text = s["shortcutsUnavailableTitle"];
            ShortcutEmpty.Visibility = Visibility.Visible;
        }
    }

    private void OnShortcutPicked(object sender, ItemClickEventArgs e)
    {
        if (e.ClickedItem is not ShortcutItem item) return;
        ShortcutsFlyout.Hide();
        Composer.Text = item.Response.Body;
        Composer.SelectionStart = Composer.Text.Length;
        Composer.Focus(FocusState.Programmatic);
        if (Host.Workspace is { } ws) _ = TrackAsync(item.Response.Id, ws.Id);
    }

    private static async Task TrackAsync(string id, string workspaceId)
    {
        try
        {
            await Host.Api.TrackCannedUseAsync(id, workspaceId);
        }
        catch (ApiException)
        {
        }
    }

    // Header actions

    private async void OnToggleStatus(object sender, RoutedEventArgs e)
    {
        if (_conversation is not { } c || Host.Workspace is not { } ws) return;
        var resolved = c.Status is ConversationStatuses.Resolved or ConversationStatuses.Closed;
        var next = resolved ? ConversationStatuses.Open : ConversationStatuses.Resolved;
        await RunAsync(() => Host.Api.UpdateConversationAsync(c.Id, ws.Id, status: next), () => c with { Status = next });
    }

    private async void OnAssignToMe(object sender, RoutedEventArgs e)
    {
        if (_conversation is not { } c || Host.Workspace is not { } ws || Host.User is not { } me) return;
        if (c.IsAiManaged)
            await RunAsync(() => Host.Api.TakeOverAsync(c.Id, ws.Id), () => c with { AssignedTo = me.Id, AiState = "human_active", Metadata = null });
        else
            await RunAsync(() => Host.Api.ClaimAsync(c.Id, ws.Id), () => c with { AssignedTo = me.Id });
    }

    private async void OnMoreOpening(object? sender, object e)
    {
        var s = Host.Strings;
        MoreMenu.Items.Clear();
        if (_conversation is not { } c || Host.Workspace is not { } ws) return;

        var priority = new MenuFlyoutSubItem { Text = s["changePriority"], Icon = new FontIcon { Glyph = "" } };
        foreach (var p in ConversationPriorities.All)
        {
            var item = new RadioMenuFlyoutItem { Text = PriorityLabel(p, s), GroupName = "priority", IsChecked = (c.Priority ?? ConversationPriorities.Normal) == p };
            item.Click += async (_, _) => await RunAsync(() => Host.Api.UpdateConversationAsync(c.Id, ws.Id, priority: p), () => c with { Priority = p });
            priority.Items.Add(item);
        }
        MoreMenu.Items.Add(priority);

        var transfer = new MenuFlyoutSubItem { Text = s["transferConversation"], Icon = new FontIcon { Glyph = "" } };
        MoreMenu.Items.Add(transfer);
        if (c.AssignedTo is not null)
        {
            var unassign = new MenuFlyoutItem { Text = s["unassigned"], Icon = new FontIcon { Glyph = "" } };
            unassign.Click += async (_, _) => await RunAsync(() => Host.Api.UpdateConversationAsync(c.Id, ws.Id, unassign: true), () => c with { AssignedTo = null });
            MoreMenu.Items.Add(unassign);
        }

        try
        {
            foreach (var m in (await Host.MembersAsync()).Where(m => m.SuspendedAt is null))
            {
                var item = new ToggleMenuFlyoutItem { Text = m.DisplayName, IsChecked = m.UserId == c.AssignedTo };
                item.Click += async (_, _) => await RunAsync(() => Host.Api.UpdateConversationAsync(c.Id, ws.Id, assignTo: m.UserId), () => c with { AssignedTo = m.UserId });
                transfer.Items.Add(item);
            }
        }
        catch (Exception ex)
        {
            Log.Error("members", ex);
        }
        if (transfer.Items.Count == 0) transfer.Items.Add(new MenuFlyoutItem { Text = s["noResults"], IsEnabled = false });
    }

    private async Task RunAsync(Func<Task> action, Func<Conversation> after)
    {
        StatusButton.IsEnabled = false;
        AssignButton.IsEnabled = false;
        try
        {
            await action();
            Refresh(after());
            StatusChanged?.Invoke();
        }
        catch (Exception ex)
        {
            Log.Error("conversation action", ex);
            ShowError(ErrorText.For(ex, Host.Strings));
        }
        finally
        {
            StatusButton.IsEnabled = true;
            AssignButton.IsEnabled = true;
        }
    }

    private void OnToggleDetails(object sender, RoutedEventArgs e)
    {
        _detailsOpen = DetailsToggle.IsChecked == true;
        ApplyDetailsVisibility();
    }

    private void ApplyDetailsVisibility() =>
        Details.Visibility = _detailsOpen && _conversation is not null && ActualWidth > 820 ? Visibility.Visible : Visibility.Collapsed;

    // Calls

    private void OnAudioCall(object sender, RoutedEventArgs e) => StartCall("audio");

    private void OnVideoCall(object sender, RoutedEventArgs e) => StartCall("video");

    private void StartCall(string channel)
    {
        if (_conversation is not { } c || Host.Workspace is not { } ws) return;
        LiveCall.Start(c, ws.Id, channel, Display.ConversationName(c, Host.Strings));
    }
}
