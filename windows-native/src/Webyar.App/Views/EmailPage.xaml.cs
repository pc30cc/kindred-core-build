using System.Collections.ObjectModel;
using System.Net;
using System.Text;
using System.Text.RegularExpressions;
using CommunityToolkit.Mvvm.ComponentModel;
using Microsoft.UI.Input;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Navigation;
using Webyar.App.Helpers;
using Webyar.App.Services;
using Webyar.App.ViewModels;
using Webyar.Core.Api;
using Webyar.Core.Inbox;
using Webyar.Core.Localization;
using Windows.System;
using Windows.UI.Core;

namespace Webyar.App.Views;

/// <summary>
/// The workspace mailbox (the web console's email inbox), laid out like a
/// desktop mail client: threads on the start side with search and
/// All / Unread / Starred, the open thread beside them with its action bar,
/// the latest message on a white card and the earlier ones folded under it,
/// and an inline composer for replies, forwards and new mail. Mail HTML is
/// shown in a WebView2 with scripts off, so a message can look like itself
/// but not act.
/// </summary>
public sealed partial class EmailPage : Page
{
    private enum ComposeMode { Reply, ReplyAll, Forward, New }

    private enum ReadState { Placeholder, Thread, Error, New }

    private readonly List<EmailRow> _all = [];
    private readonly ObservableCollection<EmailRow> _items = [];
    private readonly ObservableCollection<EmailAttachmentRow> _attachments = [];
    private readonly HashSet<string> _me = new(StringComparer.OrdinalIgnoreCase);

    private EmailRow? _openRow;
    private EmailThreadDetail? _open;
    private EmailMessageView? _latest;
    private string? _search;
    private string _filter = "all";
    private string? _mailbox;
    private bool _connected;
    private bool _webReady;
    private bool _sending;
    private bool _suppressSelect;
    private bool _listFailed;
    private bool _loading;
    private ComposeMode _mode = ComposeMode.Reply;
    private string? _forwardPrefill;
    private Microsoft.UI.Dispatching.DispatcherQueueTimer? _noticeTimer;

    public EmailPage()
    {
        InitializeComponent();
        List.ItemsSource = _items;
        AttachmentList.ItemsSource = _attachments;
        Notice.Closed += (_, _) => Notice.Visibility = Visibility.Collapsed;
    }

    private static AppHost Host => App.Current.Host;

    protected override async void OnNavigatedTo(NavigationEventArgs e)
    {
        base.OnNavigatedTo(e);
        Palette.ThemeChanged += OnThemeChanged;
        ApplyStrings();
        ShowState(ReadState.Placeholder);
        await LoadAsync();
    }

    protected override void OnNavigatedFrom(NavigationEventArgs e)
    {
        base.OnNavigatedFrom(e);
        Palette.ThemeChanged -= OnThemeChanged;
        _noticeTimer?.Stop();
    }

    private void ApplyStrings()
    {
        var s = Host.Strings;
        HeaderText.Text = s["emailInbox"];
        ComposeText.Text = s["emailCompose"];
        PlaceholderComposeText.Text = s["emailCompose"];
        Search.PlaceholderText = s["emailSearch"];
        FilterAll.Text = s["emailFilterAll"];
        FilterUnread.Text = s["emailFilterUnread"];
        FilterStarred.Text = s["emailFilterStarred"];
        PlaceholderTitle.Text = s["noEmailSelected"];
        PlaceholderBody.Text = s["emailSelectHint"];
        ReadRetryButton.Content = s["retry"];
        EmptyRetryButton.Content = s["retry"];
        NewHeaderText.Text = s["emailNewTitle"];
        ReplyText.Text = s["emailReply"];
        ReplyAllText.Text = s["emailReplyAll"];
        ForwardText.Text = s["emailForward"];
        ToLabel.Text = s["emailTo"];
        SubjectLabel.Text = s["emailSubject"];
        ToBox.PlaceholderText = s["emailToPlaceholder"];
        SubjectBox.PlaceholderText = s["emailSubjectPlaceholder"];
        BodyBox.PlaceholderText = s["emailBodyPlaceholder"];
        ComposerHint.Text = s["emailComposerHint"];
        DiscardText.Text = s["discard"];
        SendText.Text = s["emailSend"];
        ToolTipService.SetToolTip(RefreshButton, $"{s["refresh"]} (F5)");
        ToolTipService.SetToolTip(ComposeButton, $"{s["emailCompose"]} (Ctrl+N)");
        ToolTipService.SetToolTip(StarButton, s["emailStar"]);
        ToolTipService.SetToolTip(UnreadButton, s["emailMarkUnread"]);
        ToolTipService.SetToolTip(CopyButton, s["emailCopyText"]);
        ToolTipService.SetToolTip(CloseComposerButton, s["emailDiscardDraft"]);
        ToolTipService.SetToolTip(SendButton, $"{s["emailSend"]} (Ctrl+Enter)");
    }

    // ── Thread list ──

    private async Task LoadAsync()
    {
        if (_loading || Host.Workspace is not { } ws) return;
        _loading = true;
        var s = Host.Strings;
        Loading.Visibility = Visibility.Visible;
        Loading.IsActive = true;
        RefreshButton.IsEnabled = false;
        try
        {
            try
            {
                var connection = await Host.Api.GmailConnectionAsync(ws.Id);
                _connected = connection?.Connected == true;
                _mailbox = connection?.EmailAddress;
            }
            catch (Exception e)
            {
                // Only the empty-state wording depends on it; the list still loads.
                Log.Error("email connection", e);
            }
            RebuildMe();
            var threads = await Host.Api.EmailThreadsAsync(ws.Id, _search);
            var known = _all.ToDictionary(r => r.Id);
            _all.Clear();
            foreach (var t in threads.OrderByDescending(t => t.LastMessageAt ?? DateTimeOffset.MinValue))
            {
                if (known.TryGetValue(t.Id, out var row)) row.Update(t, _me, s);
                else row = new EmailRow(t, _me, s);
                _all.Add(row);
            }
            _listFailed = false;
            ApplyFilter();
        }
        catch (Exception e)
        {
            Log.Error("email threads", e);
            _listFailed = true;
            _suppressSelect = true;
            _items.Clear();
            _suppressSelect = false;
            EmptyGlyph.Glyph = "";
            EmptyTitle.Text = ErrorText.For(e, s);
            EmptyBody.Text = string.Empty;
            EmptyRetryButton.Visibility = Visibility.Visible;
            Empty.Visibility = Visibility.Visible;
        }
        finally
        {
            Loading.IsActive = false;
            Loading.Visibility = Visibility.Collapsed;
            RefreshButton.IsEnabled = true;
            _loading = false;
            UpdateHeader();
        }
    }

    private void RebuildMe()
    {
        _me.Clear();
        if (Host.User?.Email is { Length: > 0 } mine) _me.Add(mine.Trim());
        if (_mailbox is { Length: > 0 } box) _me.Add(box.Trim());
    }

    private bool IsMe(string? email) => email is { Length: > 0 } && _me.Contains(email.Trim());

    /// <summary>Shows the rows the chosen filter keeps, holding on to the open thread's row.</summary>
    private void ApplyFilter()
    {
        var openId = _openRow?.Id;
        _suppressSelect = true;
        _items.Clear();
        foreach (var row in _all.Where(Matches)) _items.Add(row);
        var keep = openId is null ? null : _items.FirstOrDefault(r => r.Id == openId);
        if (keep is not null)
        {
            _openRow = keep;
            List.SelectedItem = keep;
        }
        _suppressSelect = false;
        UpdateEmpty();
    }

    private bool Matches(EmailRow row) => _filter switch
    {
        "unread" => row.IsUnread || ReferenceEquals(row, _openRow),
        "starred" => row.IsStarred,
        _ => true,
    };

    private void UpdateEmpty()
    {
        if (_listFailed) return;
        var s = Host.Strings;
        EmptyRetryButton.Visibility = Visibility.Collapsed;
        EmptyGlyph.Glyph = "";
        if (_items.Count > 0)
        {
            Empty.Visibility = Visibility.Collapsed;
            return;
        }
        if (_all.Count > 0)
        {
            EmptyTitle.Text = s["emailEmptyTitle"];
            EmptyBody.Text = s["emailFilterEmptyBody"];
        }
        else
        {
            var connected = _connected || _search is not null;
            EmptyTitle.Text = connected ? s["emailEmptyTitle"] : s["emailNotConnectedTitle"];
            EmptyBody.Text = connected ? s["emailEmptyBody"] : s["emailNotConnectedBody"];
        }
        Empty.Visibility = Visibility.Visible;
    }

    private void UpdateHeader()
    {
        var s = Host.Strings;
        var unread = _all.Count(r => r.IsUnread);
        UnreadChip.Visibility = unread > 0 ? Visibility.Visible : Visibility.Collapsed;
        UnreadChipText.Text = s.Get("emailUnreadCount", "n", unread);
        HeaderSub.Text = _mailbox ?? string.Empty;
        HeaderSub.Visibility = string.IsNullOrWhiteSpace(_mailbox) ? Visibility.Collapsed : Visibility.Visible;
    }

    private async void OnRefresh(object sender, RoutedEventArgs e) => await LoadAsync();

    private async void OnRefreshKey(KeyboardAccelerator sender, KeyboardAcceleratorInvokedEventArgs args)
    {
        args.Handled = true;
        await LoadAsync();
    }

    private async void OnSearch(AutoSuggestBox sender, AutoSuggestBoxQuerySubmittedEventArgs args)
    {
        _search = string.IsNullOrWhiteSpace(sender.Text) ? null : sender.Text.Trim();
        await LoadAsync();
    }

    /// <summary>Clearing the box (its ✕ or by hand) brings the whole mailbox back.</summary>
    private async void OnSearchTextChanged(AutoSuggestBox sender, AutoSuggestBoxTextChangedEventArgs args)
    {
        if (args.Reason != AutoSuggestionBoxTextChangeReason.UserInput || !string.IsNullOrWhiteSpace(sender.Text) || _search is null) return;
        _search = null;
        await LoadAsync();
    }

    private void OnFilterChanged(SelectorBar sender, SelectorBarSelectionChangedEventArgs args)
    {
        if (sender.SelectedItem?.Tag is not string tag || tag == _filter) return;
        _filter = tag;
        ApplyFilter();
    }

    private async void OnSelect(object sender, SelectionChangedEventArgs e)
    {
        if (_suppressSelect || List.SelectedItem is not EmailRow row || ReferenceEquals(row, _openRow) && _open is not null) return;
        await OpenAsync(row);
    }

    // ── Reading pane ──

    private void ShowState(ReadState state)
    {
        Placeholder.Visibility = state == ReadState.Placeholder ? Visibility.Visible : Visibility.Collapsed;
        ThreadView.Visibility = state == ReadState.Thread ? Visibility.Visible : Visibility.Collapsed;
        ReadError.Visibility = state == ReadState.Error ? Visibility.Visible : Visibility.Collapsed;
        NewHeader.Visibility = state == ReadState.New ? Visibility.Visible : Visibility.Collapsed;
        if (state is ReadState.Placeholder or ReadState.Error) ComposerHost.Visibility = Visibility.Collapsed;
    }

    private async Task OpenAsync(EmailRow row)
    {
        if (Host.Workspace is not { } ws) return;
        var s = Host.Strings;
        ExitNewMode();
        _forwardPrefill = null;
        BodyBox.Text = string.Empty;
        SetStatus(null);
        _openRow = row;
        _open = null;
        _latest = null;
        ShowState(ReadState.Thread);
        ComposerHost.Visibility = Visibility.Collapsed;

        // What the list already knows, at once; the rest when the thread arrives.
        SubjectText.Text = row.Subject;
        StarButton.IsChecked = row.IsStarred;
        SenderName.Text = row.Sender;
        SenderAddress.Text = string.Empty;
        SenderAvatar.DisplayName = row.AvatarName;
        SenderAvatar.Email = row.AvatarEmail;
        ToLine.Text = string.Empty;
        CcLine.Visibility = Visibility.Collapsed;
        DateText.Text = row.Stamp;
        CountChip.Visibility = Visibility.Collapsed;
        AttachChip.Visibility = Visibility.Collapsed;
        _attachments.Clear();
        AttachmentsHost.Visibility = Visibility.Collapsed;
        SetActionsEnabled(false);
        BodyLoading.Visibility = Visibility.Visible;
        BodyLoading.IsActive = true;
        if (_webReady) Body.NavigateToString(BlankHtml);

        try
        {
            var detail = await Host.Api.EmailThreadAsync(ws.Id, row.Id);
            if (!ReferenceEquals(_openRow, row)) return;
            _open = detail;
            ShowDetail(detail, row);
            await RenderAsync(detail);
            if (!ReferenceEquals(_openRow, row)) return;
            if (row.IsUnread)
            {
                try
                {
                    await Host.Api.SetEmailReadAsync(ws.Id, row.Id, true);
                    row.Update(row.Thread with { IsRead = true }, _me, s);
                    UpdateHeader();
                }
                catch (Exception ex)
                {
                    Log.Error("email read", ex);
                }
            }
        }
        catch (Exception ex)
        {
            if (!ReferenceEquals(_openRow, row)) return;
            Log.Error("email thread", ex);
            ReadErrorTitle.Text = s["emailLoadFailed"];
            ReadErrorBody.Text = ErrorText.For(ex, s);
            ShowState(ReadState.Error);
        }
        finally
        {
            if (ReferenceEquals(_openRow, row))
            {
                BodyLoading.IsActive = false;
                BodyLoading.Visibility = Visibility.Collapsed;
            }
        }
    }

    private async void OnRetryOpen(object sender, RoutedEventArgs e)
    {
        if (_openRow is { } row) await OpenAsync(row);
    }

    private static List<EmailMessageView> Ordered(EmailThreadDetail? detail) =>
        (detail?.Messages ?? []).OrderBy(m => m.SentAt ?? DateTimeOffset.MinValue).ToList();

    /// <summary>The header, recipients, chips and attachments of the thread, from its latest message.</summary>
    private void ShowDetail(EmailThreadDetail detail, EmailRow row)
    {
        var s = Host.Strings;
        var messages = Ordered(detail);
        _latest = messages.LastOrDefault();
        if (detail.Thread is { } t)
        {
            SubjectText.Text = string.IsNullOrWhiteSpace(t.Subject) ? s["emailNoSubject"] : t.Subject!;
            StarButton.IsChecked = t.IsStarred == true;
        }

        if (_latest is { } m)
        {
            var from = MailText.Parse(m.FromAddress);
            SenderName.Text = IsMe(from.Email) && from.Name is null ? s["you"] : from.Display;
            SenderAddress.Text = from.Name is null && !IsMe(from.Email) ? string.Empty : from.Email;
            SenderAvatar.DisplayName = from.Name;
            SenderAvatar.Email = from.Email;
            ToLine.Text = $"{s["emailTo"]}: {MailText.Join(m.ToAddresses)}";
            var cc = MailText.Join(m.CcAddresses);
            CcLine.Text = $"{s["emailCc"]}: {cc}";
            CcLine.Visibility = cc.Length > 0 ? Visibility.Visible : Visibility.Collapsed;
            DateText.Text = m.SentAt is { } at ? FullDate(at) : string.Empty;
        }

        CountChip.Visibility = messages.Count > 1 ? Visibility.Visible : Visibility.Collapsed;
        CountText.Text = s.Get("emailMessageCount", "n", messages.Count);

        _attachments.Clear();
        foreach (var msg in Enumerable.Reverse(messages))
            foreach (var a in msg.Attachments ?? []) _attachments.Add(new EmailAttachmentRow(a, s));
        AttachmentsHost.Visibility = _attachments.Count > 0 ? Visibility.Visible : Visibility.Collapsed;
        AttachChip.Visibility = _attachments.Count > 0 ? Visibility.Visible : Visibility.Collapsed;
        AttachCountText.Text = s.Get("emailAttachmentCount", "n", _attachments.Count);
        row.HasAttachments = _attachments.Count > 0;

        SetActionsEnabled(_latest is not null);
        ReplyAllButton.Visibility = ReplyAllRecipients().Count > 1 ? Visibility.Visible : Visibility.Collapsed;
        StartCompose(ComposeMode.Reply, focus: false);
        ComposerHost.Visibility = Visibility.Visible;
    }

    private void SetActionsEnabled(bool on)
    {
        ReplyButton.IsEnabled = on;
        ReplyAllButton.IsEnabled = on;
        ForwardButton.IsEnabled = on;
        CopyButton.IsEnabled = on;
        StarButton.IsEnabled = on;
        UnreadButton.IsEnabled = on;
    }

    private string FullDate(DateTimeOffset at)
    {
        var s = Host.Strings;
        var local = at.ToLocalTime();
        var clock = Display.ClockTime(at, s.Language);
        if (s.Language == Webyar.Core.Localization.Language.Fa)
            return $"{s.Culture.DateTimeFormat.GetDayName(local.DayOfWeek)} {Display.ShortDate(local.Date, s.Language)} · {clock}";
        return $"{local.ToString("D", s.Culture)} · {clock}";
    }

    private async Task RenderAsync(EmailThreadDetail detail)
    {
        if (!_webReady)
        {
            await Body.EnsureCoreWebView2Async();
            Body.CoreWebView2.Settings.IsScriptEnabled = false;
            Body.CoreWebView2.Settings.AreDefaultContextMenusEnabled = true;
            Body.CoreWebView2.Settings.AreDevToolsEnabled = false;
            // Links open in the browser, never inside the app.
            Body.CoreWebView2.NewWindowRequested += (w, a) =>
            {
                a.Handled = true;
                if (Uri.TryCreate(a.Uri, UriKind.Absolute, out var u) && u.Scheme is "https" or "http" or "mailto") _ = Launcher.LaunchUriAsync(u);
            };
            Body.CoreWebView2.NavigationStarting += (w, a) =>
            {
                if (a.Uri.StartsWith("data:", StringComparison.Ordinal) || a.Uri.StartsWith("about:", StringComparison.Ordinal)) return;
                a.Cancel = true;
                if (Uri.TryCreate(a.Uri, UriKind.Absolute, out var u) && u.Scheme is "https" or "http" or "mailto") _ = Launcher.LaunchUriAsync(u);
            };
            _webReady = true;
        }
        Body.NavigateToString(Html(detail));
    }

    /// <summary>A person on a 24×24 grid, as the call page draws a caller with no photo or device.</summary>
    private const string PersonPath = "M12 12a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9zm0 2c-4.4 0-8 2.5-8 5.5V21h16v-1.5c0-3-3.6-5.5-8-5.5z";

    private const string BlankHtml = "<!doctype html><html><body style=\"margin:0;background:#ffffff\"></body></html>";

    /// <summary>
    /// The thread as one white page: the latest message's body first (its
    /// header is the XAML above the card), then the earlier ones newest first,
    /// each a folded card that opens on a click — HTML details, no script.
    /// </summary>
    private string Html(EmailThreadDetail detail)
    {
        var s = Host.Strings;
        var dir = s.IsRightToLeft ? "rtl" : "ltr";
        var messages = Ordered(detail);
        var sb = new StringBuilder();
        sb.Append($"<!doctype html><html dir=\"{dir}\"><head><meta charset=\"utf-8\"><style>")
          .Append("html,body{background:#ffffff}")
          .Append("body{margin:0;padding:14px 18px 20px;font-family:'Segoe UI Variable Text','Segoe UI',Tahoma,sans-serif;font-size:14px;line-height:1.55;color:#1f2633;}")
          .Append(".b{overflow-wrap:anywhere}.b img{max-width:100%;height:auto}pre{white-space:pre-wrap;font-family:inherit;margin:0}")
          .Append("a{color:#2f6ae0}")
          .Append(".err{margin-top:12px;padding:8px 12px;border-radius:8px;background:#fdecec;color:#c62f35;font-size:12.5px}")
          .Append(".earlier{margin-top:26px;padding-top:14px;border-top:1px solid #e6e9ef}")
          .Append(".et{font-size:12px;font-weight:600;color:#6b7485;margin:0 2px 10px}")
          .Append("details{border:1px solid #e3e7ee;border-radius:12px;margin-bottom:10px;background:#f8f9fb;overflow:hidden}")
          .Append("details[open]{background:#ffffff}")
          .Append("summary{list-style:none;cursor:pointer;display:flex;align-items:center;gap:12px;padding:10px 14px}")
          .Append("summary::-webkit-details-marker{display:none}")
          .Append("summary:hover{background:#eef2f8}")
          // The sender as the app's avatars draw a faceless person: a grey disc with a person, tinted by their name. Never initials.
          .Append(".av{flex:none;position:relative;width:30px;height:30px;border-radius:50%;background:#eef1f5;display:flex;align-items:center;justify-content:center;overflow:hidden}")
          .Append(".av i{position:absolute;inset:0;border-radius:50%;opacity:.24}")
          .Append(".av svg{position:relative;width:46%;height:46%;opacity:.85}")
          .Append(".who{flex:none;max-width:40%;font-weight:600;font-size:13px;color:#0f1729;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}")
          .Append(".sn{flex:1;min-width:0;font-size:12.5px;color:#6b7485;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}")
          .Append("details[open] .sn{visibility:hidden}")
          .Append(".dt{flex:none;font-size:12px;color:#98a2b3;white-space:nowrap}")
          .Append(".in{padding:4px 16px 16px;border-top:1px solid #eef0f4}")
          .Append(".meta{font-size:12px;color:#6b7485;margin:8px 0 12px;overflow-wrap:anywhere}")
          .Append(".files{margin-top:12px;display:flex;flex-wrap:wrap;gap:6px}")
          .Append(".file{font-size:12px;color:#3b4252;background:#f1f4f9;border-radius:8px;padding:4px 10px}")
          .Append("</style></head><body>");

        if (messages.Count == 0)
        {
            sb.Append("<div class=\"b\" dir=\"auto\"><pre>").Append(WebUtility.HtmlEncode(detail.Thread?.LastMessageSnippet ?? string.Empty)).Append("</pre></div>");
        }
        else
        {
            AppendBody(sb, messages[^1], s);
            if (messages.Count > 1)
            {
                sb.Append("<div class=\"earlier\"><div class=\"et\">")
                  .Append(WebUtility.HtmlEncode(s.Get("emailEarlierMessages", "n", messages.Count - 1)))
                  .Append("</div>");
                for (var i = messages.Count - 2; i >= 0; i--)
                {
                    var m = messages[i];
                    var from = MailText.Parse(m.FromAddress);
                    var who = IsMe(from.Email) && from.Name is null ? s["you"] : from.Display;
                    var (r, g, b) = AvatarArt.Tint(from.Name, from.Email).ToRgb();
                    var tint = $"#{r:x2}{g:x2}{b:x2}";
                    var when = m.SentAt is { } at ? Display.ListStamp(at, DateTimeOffset.Now, s) : string.Empty;
                    var snippet = Display.OneLine(m.Snippet ?? MailText.PlainText(m));
                    sb.Append("<details><summary>")
                      .Append($"<span class=\"av\"><i style=\"background:{tint}\"></i><svg viewBox=\"0 0 24 24\"><path fill=\"{tint}\" d=\"{PersonPath}\"/></svg></span>")
                      .Append("<span class=\"who\" dir=\"auto\">").Append(WebUtility.HtmlEncode(who)).Append("</span>")
                      .Append("<span class=\"sn\" dir=\"auto\">").Append(WebUtility.HtmlEncode(snippet)).Append("</span>")
                      .Append("<span class=\"dt\">").Append(WebUtility.HtmlEncode(when)).Append("</span>")
                      .Append("</summary><div class=\"in\"><div class=\"meta\">");
                    sb.Append(WebUtility.HtmlEncode($"{s["emailFrom"]}: {m.FromAddress}")).Append("<br>")
                      .Append(WebUtility.HtmlEncode($"{s["emailTo"]}: {MailText.Join(m.ToAddresses)}"));
                    if (MailText.Join(m.CcAddresses) is { Length: > 0 } cc) sb.Append("<br>").Append(WebUtility.HtmlEncode($"{s["emailCc"]}: {cc}"));
                    if (m.SentAt is { } sent) sb.Append("<br>").Append(WebUtility.HtmlEncode($"{s["emailDate"]}: {FullDate(sent)}"));
                    sb.Append("</div>");
                    AppendBody(sb, m, s);
                    sb.Append("</div></details>");
                }
                sb.Append("</div>");
            }
        }
        sb.Append("</body></html>");
        return sb.ToString();
    }

    private static void AppendBody(StringBuilder sb, EmailMessageView m, Strings s)
    {
        sb.Append("<div class=\"b\" dir=\"auto\">");
        if (!string.IsNullOrWhiteSpace(m.HtmlBody)) sb.Append(m.HtmlBody);
        else sb.Append("<pre>").Append(WebUtility.HtmlEncode(m.TextBody ?? m.Snippet ?? string.Empty)).Append("</pre>");
        sb.Append("</div>");
        if (m.Attachments is { Count: > 0 } files)
        {
            sb.Append("<div class=\"files\">");
            foreach (var f in files) sb.Append("<span class=\"file\" dir=\"auto\">📎 ").Append(WebUtility.HtmlEncode(f.Filename ?? s["file"])).Append("</span>");
            sb.Append("</div>");
        }
        if (!string.IsNullOrWhiteSpace(m.DeliveryError))
            sb.Append("<div class=\"err\" dir=\"auto\">").Append(WebUtility.HtmlEncode($"{s["emailNotDelivered"]} — {m.DeliveryError}")).Append("</div>");
    }

    private async void OnStar(object sender, RoutedEventArgs e)
    {
        if (_openRow is not { } row || Host.Workspace is not { } ws) return;
        var starred = StarButton.IsChecked == true;
        try
        {
            await Host.Api.SetEmailStarredAsync(ws.Id, row.Id, starred);
            row.Update(row.Thread with { IsStarred = starred }, _me, Host.Strings);
        }
        catch (Exception ex)
        {
            Log.Error("email star", ex);
            StarButton.IsChecked = !starred;
            ShowNotice(ErrorText.For(ex, Host.Strings), InfoBarSeverity.Error);
        }
    }

    private async void OnMarkUnread(object sender, RoutedEventArgs e)
    {
        if (_openRow is not { } row || Host.Workspace is not { } ws) return;
        try
        {
            await Host.Api.SetEmailReadAsync(ws.Id, row.Id, false);
            row.Update(row.Thread with { IsRead = false }, _me, Host.Strings);
            _openRow = null;
            _open = null;
            _latest = null;
            _suppressSelect = true;
            List.SelectedItem = null;
            _suppressSelect = false;
            ShowState(ReadState.Placeholder);
            UpdateHeader();
        }
        catch (Exception ex)
        {
            Log.Error("email unread", ex);
            ShowNotice(ErrorText.For(ex, Host.Strings), InfoBarSeverity.Error);
        }
    }

    private void OnCopy(object sender, RoutedEventArgs e)
    {
        if (_latest is not { } m) return;
        var data = new Windows.ApplicationModel.DataTransfer.DataPackage();
        data.SetText(MailText.PlainText(m));
        Windows.ApplicationModel.DataTransfer.Clipboard.SetContent(data);
        ShowNotice(Host.Strings["copied"], InfoBarSeverity.Success);
    }

    private async void OnOpenAttachment(object sender, RoutedEventArgs e)
    {
        if ((sender as FrameworkElement)?.Tag is not EmailAttachmentRow a || a.Url is not { Length: > 0 } url) return;
        var origin = Host.Client.Origin;
        try
        {
            Uri? target = url.StartsWith('/') ? new Uri(origin, url) : Uri.TryCreate(url, UriKind.Absolute, out var abs) ? abs : null;
            if (target is null) return;
            var sameHost = string.Equals(target.Host, origin.Host, StringComparison.OrdinalIgnoreCase);
            if (sameHost && target.AbsolutePath.StartsWith("/api/", StringComparison.Ordinal))
            {
                // Our own API needs the session: fetch it here, then open the file with its app.
                var data = await Host.Client.GetBytesAsync(target.PathAndQuery);
                var dir = Path.Combine(Path.GetTempPath(), "Webyar", "mail", string.Join("_", a.Id.Split(Path.GetInvalidFileNameChars())));
                Directory.CreateDirectory(dir);
                var name = string.Join("_", a.FileName.Split(Path.GetInvalidFileNameChars()));
                if (!Path.HasExtension(name) && a.ContentType is { Length: > 0 } type) name += Mime.Extension(type);
                var path = Path.Combine(dir, name);
                await File.WriteAllBytesAsync(path, data);
                var stored = await Windows.Storage.StorageFile.GetFileFromPathAsync(path);
                await Launcher.LaunchFileAsync(stored);
            }
            else if (target.Scheme is "https" or "http")
            {
                await Launcher.LaunchUriAsync(target);
            }
        }
        catch (Exception ex)
        {
            Log.Error("email attachment", ex);
            ShowNotice(ErrorText.For(ex, Host.Strings), InfoBarSeverity.Error);
        }
    }

    // ── Composer ──

    private void OnReply(object sender, RoutedEventArgs e) => StartCompose(ComposeMode.Reply, focus: true);

    private void OnReplyAll(object sender, RoutedEventArgs e) => StartCompose(ComposeMode.ReplyAll, focus: true);

    private void OnForward(object sender, RoutedEventArgs e) => StartCompose(ComposeMode.Forward, focus: true);

    private void OnCompose(object sender, RoutedEventArgs e) => BeginNewMail();

    private void OnComposeKey(KeyboardAccelerator sender, KeyboardAcceleratorInvokedEventArgs args)
    {
        args.Handled = true;
        BeginNewMail();
    }

    private void BeginNewMail()
    {
        if (Host.Workspace is null) return;
        _openRow = null;
        _open = null;
        _latest = null;
        _suppressSelect = true;
        List.SelectedItem = null;
        _suppressSelect = false;
        EnterNewMode();
        _forwardPrefill = null;
        BodyBox.Text = string.Empty;
        StartCompose(ComposeMode.New, focus: true);
    }

    /// <summary>New mail: the composer takes the whole reading pane.</summary>
    private void EnterNewMode()
    {
        ShowState(ReadState.New);
        ContentRow.Height = GridLength.Auto;
        ComposerRow.Height = new GridLength(1, GridUnitType.Star);
        BodyBox.MaxHeight = double.PositiveInfinity;
        BodyBox.VerticalAlignment = VerticalAlignment.Stretch;
        ComposerHost.Visibility = Visibility.Visible;
    }

    private void ExitNewMode()
    {
        ContentRow.Height = new GridLength(1, GridUnitType.Star);
        ComposerRow.Height = GridLength.Auto;
        BodyBox.MaxHeight = 240;
        BodyBox.VerticalAlignment = VerticalAlignment.Top;
    }

    private void StartCompose(ComposeMode mode, bool focus)
    {
        var s = Host.Strings;
        var typed = MailText.Normalize(BodyBox.Text);
        if (_forwardPrefill is not null)
        {
            // Leaving a forward: drop the quoted message unless it was written into.
            if (typed == _forwardPrefill) typed = string.Empty;
            else if (typed.EndsWith(_forwardPrefill, StringComparison.Ordinal)) typed = typed[..^_forwardPrefill.Length].TrimEnd();
            _forwardPrefill = null;
        }
        _mode = mode;
        switch (mode)
        {
            case ComposeMode.Reply:
                ModeGlyph.Glyph = "";
                ModeText.Text = s["emailReply"];
                ToBox.Text = string.Join(", ", ReplyRecipients());
                SubjectRow.Visibility = Visibility.Collapsed;
                BodyBox.Text = typed;
                break;
            case ComposeMode.ReplyAll:
                ModeGlyph.Glyph = "";
                ModeText.Text = s["emailReplyAll"];
                ToBox.Text = string.Join(", ", ReplyAllRecipients());
                SubjectRow.Visibility = Visibility.Collapsed;
                BodyBox.Text = typed;
                break;
            case ComposeMode.Forward:
                ModeGlyph.Glyph = "";
                ModeText.Text = s["emailForward"];
                ToBox.Text = string.Empty;
                SubjectBox.Text = PrefixedSubject("Fwd:");
                SubjectRow.Visibility = Visibility.Visible;
                _forwardPrefill = ForwardBlock();
                BodyBox.Text = (typed.Length > 0 ? typed : string.Empty) + _forwardPrefill;
                break;
            case ComposeMode.New:
                ModeGlyph.Glyph = "";
                ModeText.Text = s["emailNewTitle"];
                ToBox.Text = string.Empty;
                SubjectBox.Text = string.Empty;
                SubjectRow.Visibility = Visibility.Visible;
                BodyBox.Text = typed;
                break;
        }
        SetStatus(null);
        UpdateSendEnabled();
        if (!focus) return;
        if (mode is ComposeMode.Forward or ComposeMode.New) ToBox.Focus(FocusState.Programmatic);
        else
        {
            BodyBox.Focus(FocusState.Programmatic);
            BodyBox.SelectionStart = BodyBox.Text.Length;
        }
    }

    /// <summary>Reply goes to whoever last wrote from outside; if only we wrote, to whom we wrote.</summary>
    private List<string> ReplyRecipients()
    {
        var messages = Ordered(_open);
        var inbound = messages.LastOrDefault(m => m.Direction != "outbound" && !IsMe(MailText.Parse(m.FromAddress).Email));
        var list = new List<string>();
        if (inbound is not null) list.Add(MailText.Parse(inbound.FromAddress).Email);
        else if (messages.LastOrDefault() is { } last) list.AddRange((last.ToAddresses ?? []).Select(a => MailText.Parse(a.Email).Email));
        if (list.Count == 0) list.AddRange((_open?.Thread?.Participants ?? _openRow?.Thread.Participants ?? []).Select(p => MailText.Parse(p.Email).Email));
        return Others(list);
    }

    /// <summary>Everyone on the latest message and the thread, less ourselves.</summary>
    private List<string> ReplyAllRecipients()
    {
        var list = ReplyRecipients();
        if (_latest is { } m)
        {
            list.Add(MailText.Parse(m.FromAddress).Email);
            list.AddRange((m.ToAddresses ?? []).Select(a => MailText.Parse(a.Email).Email));
            list.AddRange((m.CcAddresses ?? []).Select(a => MailText.Parse(a.Email).Email));
        }
        list.AddRange((_open?.Thread?.Participants ?? []).Select(p => MailText.Parse(p.Email).Email));
        return Others(list);
    }

    private List<string> Others(IEnumerable<string> list) =>
        list.Where(a => a.Length > 0 && !IsMe(a)).Distinct(StringComparer.OrdinalIgnoreCase).ToList();

    private string PrefixedSubject(string prefix)
    {
        var subject = (_open?.Thread?.Subject ?? _openRow?.Thread.Subject ?? string.Empty).Trim();
        if (subject.Length == 0) return prefix;
        return subject.StartsWith(prefix, StringComparison.OrdinalIgnoreCase) ? subject : $"{prefix} {subject}";
    }

    /// <summary>The forwarded message as plain text under the new one, the way mail clients quote it.</summary>
    private string ForwardBlock()
    {
        if (_latest is not { } m) return string.Empty;
        var s = Host.Strings;
        var sb = new StringBuilder("\r\r");
        sb.Append(s["emailForwardedHeader"]).Append('\r')
          .Append(s["emailFrom"]).Append(": ").Append(m.FromAddress).Append('\r');
        if (m.SentAt is { } at) sb.Append(s["emailDate"]).Append(": ").Append(FullDate(at)).Append('\r');
        sb.Append(s["emailSubject"]).Append(": ").Append(_open?.Thread?.Subject ?? string.Empty).Append('\r')
          .Append(s["emailTo"]).Append(": ").Append(MailText.Join(m.ToAddresses)).Append('\r');
        if (MailText.Join(m.CcAddresses) is { Length: > 0 } cc) sb.Append(s["emailCc"]).Append(": ").Append(cc).Append('\r');
        sb.Append('\r').Append(MailText.PlainText(m).Replace("\n", "\r"));
        return MailText.Normalize(sb.ToString());
    }

    private void OnComposerChanged(object sender, TextChangedEventArgs e)
    {
        UpdateSendEnabled();
        if (ComposerStatus.Visibility == Visibility.Visible && !_sending) SetStatus(null);
    }

    private void UpdateSendEnabled() =>
        SendButton.IsEnabled = !_sending && ToBox.Text.Trim().Length > 0 && BodyBox.Text.Trim().Length > 0;

    private void OnComposerFocus(object sender, RoutedEventArgs e) =>
        ComposerCard.BorderBrush = Palette.Resource("ComposerFocusBrush");

    private void OnComposerBlur(object sender, RoutedEventArgs e) =>
        ComposerCard.BorderBrush = Palette.Resource("ComposerBorderBrush");

    /// <summary>Ctrl+Enter sends from anywhere in the card; Enter alone is a new line.</summary>
    private async void OnComposerKeyDown(object sender, KeyRoutedEventArgs e)
    {
        if (e.Key != VirtualKey.Enter) return;
        var ctrl = InputKeyboardSource.GetKeyStateForCurrentThread(VirtualKey.Control).HasFlag(CoreVirtualKeyStates.Down);
        if (!ctrl) return;
        e.Handled = true;
        await SendAsync();
    }

    private async void OnSend(object sender, RoutedEventArgs e) => await SendAsync();

    private async Task SendAsync()
    {
        if (_sending || Host.Workspace is not { } ws) return;
        var s = Host.Strings;
        var recipients = MailText.Recipients(ToBox.Text);
        if (recipients.Count == 0 || recipients.Any(r => !MailText.LooksLikeAddress(r)))
        {
            SetStatus(s["emailInvalidRecipient"], error: true);
            ToBox.Focus(FocusState.Programmatic);
            return;
        }
        var body = MailText.Normalize(BodyBox.Text).Trim().Replace("\r", "\n");
        if (body.Length == 0)
        {
            SetStatus(s["emailWriteFirst"], error: true);
            BodyBox.Focus(FocusState.Programmatic);
            return;
        }

        var mode = _mode;
        string? threadId = null;
        string subject;
        if (mode is ComposeMode.Reply or ComposeMode.ReplyAll)
        {
            threadId = _open?.Thread?.Id ?? _openRow?.Id;
            if (threadId is null) return;
            subject = PrefixedSubject("Re:");
        }
        else
        {
            subject = SubjectBox.Text.Trim();
        }

        _sending = true;
        UpdateSendEnabled();
        SetStatus(s["sending"]);
        try
        {
            await Host.Api.SendEmailAsync(ws.Id, threadId, recipients, subject, body);
            _forwardPrefill = null;
            BodyBox.Text = string.Empty;
            SubjectBox.Text = string.Empty;
            SetStatus(null);
            ShowNotice(s["emailSent"], InfoBarSeverity.Success);
            if (mode == ComposeMode.New)
            {
                ExitNewMode();
                ShowState(ReadState.Placeholder);
            }
            else if (threadId is not null && _openRow is { } row && row.Id == threadId)
            {
                var detail = await Host.Api.EmailThreadAsync(ws.Id, threadId);
                if (ReferenceEquals(_openRow, row))
                {
                    _open = detail;
                    ShowDetail(detail, row);
                    await RenderAsync(detail);
                }
            }
            else
            {
                StartCompose(ComposeMode.Reply, focus: false);
            }
            _sending = false;
            await LoadAsync();
        }
        catch (Exception ex)
        {
            Log.Error("email send", ex);
            SetStatus($"{s["emailSendFailed"]} — {ErrorText.For(ex, s)}", error: true);
        }
        finally
        {
            _sending = false;
            UpdateSendEnabled();
        }
    }

    private void OnDiscard(object sender, RoutedEventArgs e)
    {
        _forwardPrefill = null;
        BodyBox.Text = string.Empty;
        SubjectBox.Text = string.Empty;
        SetStatus(null);
        if (_mode == ComposeMode.New || _open is null)
        {
            ExitNewMode();
            ShowState(ReadState.Placeholder);
            return;
        }
        StartCompose(ComposeMode.Reply, focus: false);
    }

    private void SetStatus(string? text, bool error = false)
    {
        ComposerStatus.Text = text ?? string.Empty;
        ComposerStatus.Foreground = Palette.Resource(error ? "DangerBrush" : "Text2Brush");
        ComposerStatus.Visibility = string.IsNullOrEmpty(text) ? Visibility.Collapsed : Visibility.Visible;
        ComposerHint.Visibility = string.IsNullOrEmpty(text) ? Visibility.Visible : Visibility.Collapsed;
    }

    private void ShowNotice(string text, InfoBarSeverity severity)
    {
        _noticeTimer?.Stop();
        Notice.Message = text;
        Notice.Severity = severity;
        Notice.Visibility = Visibility.Visible;
        Notice.IsOpen = true;
        if (severity != InfoBarSeverity.Success) return;
        _noticeTimer ??= CreateNoticeTimer();
        _noticeTimer.Start();
    }

    private Microsoft.UI.Dispatching.DispatcherQueueTimer CreateNoticeTimer()
    {
        var timer = DispatcherQueue.CreateTimer();
        timer.Interval = TimeSpan.FromSeconds(3.5);
        timer.IsRepeating = false;
        timer.Tick += (t, _) =>
        {
            t.Stop();
            Notice.IsOpen = false;
            Notice.Visibility = Visibility.Collapsed;
        };
        return timer;
    }

    /// <summary>Brushes chosen in code follow a theme switch.</summary>
    private void OnThemeChanged()
    {
        var focused = XamlRoot is { } root && FocusManager.GetFocusedElement(root) is DependencyObject d && IsInside(d, ComposerCard);
        ComposerCard.BorderBrush = Palette.Resource(focused ? "ComposerFocusBrush" : "ComposerBorderBrush");
        var error = ComposerStatus.Visibility == Visibility.Visible && !_sending && ComposerStatus.Text != Host.Strings["sending"];
        ComposerStatus.Foreground = Palette.Resource(error ? "DangerBrush" : "Text2Brush");
    }

    private static bool IsInside(DependencyObject? d, DependencyObject ancestor)
    {
        while (d is not null)
        {
            if (ReferenceEquals(d, ancestor)) return true;
            d = Microsoft.UI.Xaml.Media.VisualTreeHelper.GetParent(d);
        }
        return false;
    }
}

/// <summary>One thread on the list: who it is with, the subject, a line of the latest message, when, and its flags.</summary>
public sealed partial class EmailRow : ObservableObject
{
    private string _sender = string.Empty;
    private string? _avatarName;
    private string? _avatarEmail;
    private string _subject = string.Empty;
    private string _snippet = string.Empty;
    private string _stamp = string.Empty;
    private Windows.UI.Text.FontWeight _senderWeight = Microsoft.UI.Text.FontWeights.SemiBold;
    private Windows.UI.Text.FontWeight _subjectWeight = Microsoft.UI.Text.FontWeights.Normal;
    private Visibility _unreadVisibility = Visibility.Collapsed;
    private Visibility _starVisibility = Visibility.Collapsed;
    private Visibility _attachmentVisibility = Visibility.Collapsed;
    private bool _hasAttachments;

    public EmailRow(EmailThreadSummary t, IReadOnlySet<string> me, Strings s)
    {
        Thread = t;
        Update(t, me, s);
    }

    public EmailThreadSummary Thread { get; private set; }
    public string Id => Thread.Id;
    public bool IsUnread => Thread.IsRead == false;
    public bool IsStarred => Thread.IsStarred == true;

    public string Sender { get => _sender; private set => SetProperty(ref _sender, value); }
    public string? AvatarName { get => _avatarName; private set => SetProperty(ref _avatarName, value); }
    public string? AvatarEmail { get => _avatarEmail; private set => SetProperty(ref _avatarEmail, value); }
    public string Subject { get => _subject; private set => SetProperty(ref _subject, value); }
    public string Snippet { get => _snippet; private set => SetProperty(ref _snippet, value); }
    public string Stamp { get => _stamp; private set => SetProperty(ref _stamp, value); }
    public Windows.UI.Text.FontWeight SenderWeight { get => _senderWeight; private set => SetProperty(ref _senderWeight, value); }
    public Windows.UI.Text.FontWeight SubjectWeight { get => _subjectWeight; private set => SetProperty(ref _subjectWeight, value); }
    public Visibility UnreadVisibility { get => _unreadVisibility; private set => SetProperty(ref _unreadVisibility, value); }
    public Visibility StarVisibility { get => _starVisibility; private set => SetProperty(ref _starVisibility, value); }
    public Visibility AttachmentVisibility { get => _attachmentVisibility; private set => SetProperty(ref _attachmentVisibility, value); }

    /// <summary>The thread list does not say; known once the thread has been opened.</summary>
    public bool HasAttachments
    {
        get => _hasAttachments;
        set
        {
            if (SetProperty(ref _hasAttachments, value)) AttachmentVisibility = value ? Visibility.Visible : Visibility.Collapsed;
        }
    }

    public void Update(EmailThreadSummary t, IReadOnlySet<string> me, Strings s)
    {
        Thread = t;
        var all = (t.Participants ?? []).Select(p => MailText.Parse(p.Email)).Where(a => a.Email.Length > 0).ToList();
        var others = all.Where(a => !me.Contains(a.Email)).ToList();
        if (others.Count == 0) others = all;
        var first = others.FirstOrDefault();
        var names = others.Take(2).Select(a => a.Display).ToList();
        Sender = others.Count == 0 ? string.Empty : string.Join(", ", names) + (others.Count > 2 ? $" +{Digits.Localize((others.Count - 2).ToString(System.Globalization.CultureInfo.InvariantCulture), s.Language)}" : string.Empty);
        AvatarName = others.Count == 0 ? null : first.Name;
        AvatarEmail = others.Count == 0 ? null : first.Email;
        Subject = string.IsNullOrWhiteSpace(t.Subject) ? s["emailNoSubject"] : t.Subject!.Trim();
        Snippet = Display.OneLine(t.LastMessageSnippet);
        Stamp = t.LastMessageAt is { } at ? Display.ListStamp(at, DateTimeOffset.Now, s) : string.Empty;
        var unread = t.IsRead == false;
        SenderWeight = unread ? Microsoft.UI.Text.FontWeights.Bold : Microsoft.UI.Text.FontWeights.Normal;
        SubjectWeight = unread ? Microsoft.UI.Text.FontWeights.SemiBold : Microsoft.UI.Text.FontWeights.Normal;
        UnreadVisibility = unread ? Visibility.Visible : Visibility.Collapsed;
        StarVisibility = t.IsStarred == true ? Visibility.Visible : Visibility.Collapsed;
    }
}

/// <summary>A file on a message, as a chip under the header.</summary>
public sealed partial class EmailAttachmentRow
{
    public EmailAttachmentRow(EmailAttachmentView a, Strings s)
    {
        Id = a.Id;
        Url = a.Url;
        ContentType = a.ContentType;
        FileName = string.IsNullOrWhiteSpace(a.Filename) ? s["file"] : a.Filename.Trim();
        SizeText = a.SizeBytes is { } b ? AttachmentItem.FormatSize(b, s) : string.Empty;
        var type = a.ContentType ?? string.Empty;
        Glyph = type.StartsWith("image/", StringComparison.Ordinal) ? ""
            : type.StartsWith("audio/", StringComparison.Ordinal) ? ""
            : type.StartsWith("video/", StringComparison.Ordinal) ? ""
            : "";
        CanOpen = !string.IsNullOrWhiteSpace(a.Url);
    }

    public string Id { get; }
    public string? Url { get; }
    public string? ContentType { get; }
    public string FileName { get; }
    public string SizeText { get; }
    public string Glyph { get; }
    public bool CanOpen { get; }
}

/// <summary>An address as mail writes it: "Name &lt;a@b&gt;" or a bare address.</summary>
internal readonly record struct MailAddress(string? Name, string Email)
{
    public string Display => Name ?? Email;
}

/// <summary>Small text helpers for addresses and bodies.</summary>
internal static partial class MailText
{
    [GeneratedRegex("^\\s*\"?(?<n>[^\"<]*?)\"?\\s*<(?<e>[^>]+)>\\s*$")]
    private static partial Regex NamedAddress();

    [GeneratedRegex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$")]
    private static partial Regex AddressShape();

    [GeneratedRegex("<(script|style|head)[^>]*>.*?</\\1\\s*>", RegexOptions.IgnoreCase | RegexOptions.Singleline)]
    private static partial Regex HiddenBlocks();

    [GeneratedRegex("<br\\s*/?>|</(p|div|tr|li|h[1-6]|blockquote)\\s*>", RegexOptions.IgnoreCase)]
    private static partial Regex LineBreaks();

    [GeneratedRegex("<[^>]+>")]
    private static partial Regex Tags();

    [GeneratedRegex("\\n{3,}")]
    private static partial Regex BlankRuns();

    public static MailAddress Parse(string? raw)
    {
        var text = (raw ?? string.Empty).Trim();
        var m = NamedAddress().Match(text);
        if (m.Success)
        {
            var name = m.Groups["n"].Value.Trim();
            return new MailAddress(name.Length > 0 ? name : null, m.Groups["e"].Value.Trim());
        }
        return new MailAddress(null, text);
    }

    public static string Join(IReadOnlyList<EmailAddress>? list) =>
        string.Join(", ", (list ?? []).Select(a => a.Email).Where(a => !string.IsNullOrWhiteSpace(a)));

    public static List<string> Recipients(string text) =>
        text.Split(new[] { ',', ';', ' ', '\r', '\n', '\t' }, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Select(a => a.Trim('<', '>'))
            .Where(a => a.Length > 0)
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToList();

    public static bool LooksLikeAddress(string address) => AddressShape().IsMatch(address);

    /// <summary>A TextBox writes line breaks as \r; one form everywhere keeps comparisons honest.</summary>
    public static string Normalize(string text) => text.Replace("\r\n", "\r").Replace("\n", "\r");

    /// <summary>The message as text: its text part, else its HTML with the tags taken out.</summary>
    public static string PlainText(EmailMessageView m)
    {
        if (!string.IsNullOrWhiteSpace(m.TextBody)) return m.TextBody.Trim();
        if (!string.IsNullOrWhiteSpace(m.HtmlBody))
        {
            var html = HiddenBlocks().Replace(m.HtmlBody, string.Empty);
            html = LineBreaks().Replace(html, "\n");
            var text = WebUtility.HtmlDecode(Tags().Replace(html, string.Empty)).Replace(" ", " ");
            text = string.Join('\n', text.Replace("\r", string.Empty).Split('\n').Select(l => l.TrimEnd()));
            return BlankRuns().Replace(text, "\n\n").Trim();
        }
        return (m.Snippet ?? string.Empty).Trim();
    }
}
