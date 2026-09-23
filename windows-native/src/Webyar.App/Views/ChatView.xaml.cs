using System.Collections.ObjectModel;
using Microsoft.UI.Input;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using Webyar.App.Helpers;
using Webyar.App.Services;
using Webyar.App.ViewModels;
using Webyar.Core.Api;
using Webyar.Core.Inbox;
using Webyar.Core.Realtime;
using Windows.System;
using Windows.UI.Core;

namespace Webyar.App.Views;

/// <summary>One thread: the messages, the reply box, and resolve / reopen.</summary>
public sealed partial class ChatView : UserControl
{
    private readonly ObservableCollection<MessageItem> _messages = [];
    private readonly List<MessageItem> _outbox = [];
    private Poller? _poller;
    private string? _id;
    private Conversation? _conversation;
    private string? _lastSeenMessage;

    public ChatView()
    {
        InitializeComponent();
        Messages.ItemsSource = _messages;
        ApplyLanguage();
    }

    private static AppHost Host => App.Current.Host;

    /// <summary>Raised after resolve / reopen / assign so the list can refresh at once.</summary>
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
        AvatarText.Text = "?";
        SubText.Text = string.Empty;
        AssignButton.Visibility = Visibility.Collapsed;
        StatusButton.Visibility = Visibility.Collapsed;
    }

    /// <summary>New list data for the open conversation: header and actions follow it.</summary>
    public void Refresh(Conversation c)
    {
        if (c.Id != _id) return;
        _conversation = c;
        var s = Host.Strings;
        var name = Display.ContactName(c.Contacts, s);
        NameText.Text = name;
        AvatarText.Text = Display.Initials(name);
        var status = c.Status switch
        {
            ConversationStatuses.Open => s["filterOpen"],
            ConversationStatuses.Pending => s["filterPending"],
            ConversationStatuses.Resolved => s["filterResolved"],
            ConversationStatuses.Closed => s["statusClosed"],
            _ => c.Status,
        };
        var assignee = c.AssignedTo is null ? s["unassigned"] : c.AssignedTo == Host.User?.Id ? s["assignedToYou"] : null;
        SubText.Text = string.Join(" · ", new[] { status, c.Contacts?.Email, assignee }.Where(x => !string.IsNullOrWhiteSpace(x)));

        var resolved = c.Status is ConversationStatuses.Resolved or ConversationStatuses.Closed;
        StatusButton.Content = resolved ? s["reopen"] : s["markResolved"];
        StatusButton.Visibility = Visibility.Visible;
        AssignButton.Content = s["assignToMe"];
        AssignButton.Visibility = !resolved && c.AssignedTo != Host.User?.Id && Host.User is not null ? Visibility.Visible : Visibility.Collapsed;
    }

    public void Close()
    {
        _poller?.Dispose();
        _poller = null;
        Host.InboxChanged -= OnInboxChanged;
        _id = null;
    }

    private void Start(string id)
    {
        Close();
        _id = id;
        _lastSeenMessage = null;
        _messages.Clear();
        _outbox.Clear();
        Error.IsOpen = false;
        Composer.Text = string.Empty;
        Placeholder.Visibility = Visibility.Collapsed;
        ThreadPanel.Visibility = Visibility.Visible;
        Loading.IsActive = true;
        Loading.Visibility = Visibility.Visible;
        Host.InboxChanged += OnInboxChanged;
        _poller = new Poller("thread", ct => LoadAsync(id, ct), () => Host.PollInterval(TimeSpan.FromSeconds(Math.Min(5, Host.Config.PollIntervalSeconds))));
        _poller.Start();
        Composer.Focus(FocusState.Programmatic);
    }

    private void OnInboxChanged(InboxEvent e)
    {
        if (e.ConversationId is null || e.ConversationId == _id) _poller?.Kick();
    }

    private async Task LoadAsync(string id, CancellationToken ct)
    {
        try
        {
            var list = await Host.Api.MessagesAsync(id, ct);
            if (id != _id) return;
            var s = Host.Strings;
            var wanted = list.OrderBy(m => m.CreatedAt ?? DateTimeOffset.MinValue).Select(m => new MessageItem(m, s)).ToList();
            wanted.AddRange(_outbox);
            Sync(wanted);

            // Seen once per new message, and only while someone is actually looking.
            var newest = list.LastOrDefault(m => m.SenderType == SenderTypes.Contact)?.Id;
            if (newest is not null && newest != _lastSeenMessage && App.Current.Window?.IsForeground == true)
            {
                _lastSeenMessage = newest;
                _ = MarkSeenAsync(id);
            }
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

    /// <summary>Appends what is new and replaces what changed, leaving the rest where it is.</summary>
    private void Sync(List<MessageItem> wanted)
    {
        var i = 0;
        for (; i < wanted.Count && i < _messages.Count; i++)
        {
            if (_messages[i].Id != wanted[i].Id || _messages[i].Body != wanted[i].Body) break;
        }
        while (_messages.Count > i) _messages.RemoveAt(_messages.Count - 1);
        for (; i < wanted.Count; i++) _messages.Add(wanted[i]);
    }

    private void ApplyLanguage()
    {
        var s = Host.Strings;
        PlaceholderTitle.Text = s["noConversationSelected"];
        PlaceholderBody.Text = s["noConversationSelectedBody"];
        Composer.PlaceholderText = s["messagePlaceholder"];
        ToolTipService.SetToolTip(SendButton, s["send"]);
    }

    private void OnComposerChanged(object sender, TextChangedEventArgs e) =>
        SendButton.IsEnabled = Composer.Text.Trim().Length > 0;

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
        if (body.Length == 0 || _id is not { } id || Host.Workspace is not { } ws) return;
        Composer.Text = string.Empty;
        var item = new MessageItem(Guid.NewGuid().ToString(), body, Host.Strings);
        _outbox.Add(item);
        _messages.Add(item);
        await SendAsync(id, ws.Id, item);
    }

    private async Task SendAsync(string conversationId, string workspaceId, MessageItem item)
    {
        try
        {
            item.Failed = false;
            item.Pending = true;
            await Host.Api.SendMessageAsync(conversationId, workspaceId, item.Body, item.ClientId!);
            _outbox.Remove(item);
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
            Error.Message = ErrorText.For(ex, Host.Strings);
            Error.ActionButton = RetryButton(() =>
            {
                Error.IsOpen = false;
                foreach (var failed in _outbox.Where(o => o.Failed).ToList()) _ = SendAsync(conversationId, workspaceId, failed);
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

    private async void OnToggleStatus(object sender, RoutedEventArgs e)
    {
        if (_conversation is not { } c || Host.Workspace is not { } ws) return;
        var resolved = c.Status is ConversationStatuses.Resolved or ConversationStatuses.Closed;
        await RunAsync(() => Host.Api.UpdateConversationAsync(c.Id, ws.Id, status: resolved ? ConversationStatuses.Open : ConversationStatuses.Resolved),
            () => c with { Status = resolved ? ConversationStatuses.Open : ConversationStatuses.Resolved });
    }

    private async void OnAssignToMe(object sender, RoutedEventArgs e)
    {
        if (_conversation is not { } c || Host.Workspace is not { } ws || Host.User is not { } me) return;
        await RunAsync(() => Host.Api.ClaimAsync(c.Id, ws.Id), () => c with { AssignedTo = me.Id });
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
            Error.Message = ErrorText.For(ex, Host.Strings);
            Error.ActionButton = null;
            Error.IsOpen = true;
        }
        finally
        {
            StatusButton.IsEnabled = true;
            AssignButton.IsEnabled = true;
        }
    }
}
