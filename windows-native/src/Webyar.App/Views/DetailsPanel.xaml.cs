using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using Webyar.App.Controls;
using Webyar.App.Helpers;
using Webyar.App.Services;
using Webyar.Core.Api;
using Webyar.Core.Inbox;
using Webyar.Core.Localization;
using Windows.System;

namespace Webyar.App.Views;

/// <summary>
/// Beside a conversation: who the visitor is and where from, the
/// conversation's state, its tags, and the team's private notes.
/// </summary>
public sealed partial class DetailsPanel : UserControl
{
    private Conversation? _conversation;
    private string? _loadedFor;

    public DetailsPanel()
    {
        InitializeComponent();
        ApplyLanguage();
    }

    private static AppHost Host => App.Current.Host;

    /// <summary>Raised after a tag or note changes, so the thread and the list can refresh.</summary>
    public event Action? Changed;

    public void Show(Conversation c, bool reload)
    {
        _conversation = c;
        var s = Host.Strings;
        var name = Display.ConversationName(c, s);
        ContactAvatar.DisplayName = c.Contacts?.Name;
        ContactAvatar.Email = c.Contacts?.Email;
        ContactAvatar.Os = c.VisitorOs;
        ContactAvatar.CountryCode = c.VisitorCountryCode;
        ContactAvatar.ImageUrl = c.Contacts?.AvatarUrl;
        ContactName.Text = name;
        ContactEmail.Text = c.Contacts?.Email ?? string.Empty;
        ContactEmail.Visibility = string.IsNullOrWhiteSpace(ContactEmail.Text) ? Visibility.Collapsed : Visibility.Visible;
        CodeText.Text = c.Contacts?.VisitorCode ?? string.Empty;
        CodeRow.Visibility = string.IsNullOrWhiteSpace(CodeText.Text) ? Visibility.Collapsed : Visibility.Visible;

        StatusValue.Text = c.Status switch
        {
            ConversationStatuses.Open => s["filterOpen"],
            ConversationStatuses.Pending => s["filterPending"],
            ConversationStatuses.Resolved => s["filterResolved"],
            ConversationStatuses.Closed => s["statusClosed"],
            _ => c.Status,
        };
        StatusValue.Foreground = Palette.Resource(Palette.Status(c.Status).Fore);
        PriorityValue.Text = ChatView.PriorityLabel(c.Priority, s);
        PriorityValue.Foreground = Palette.Resource(Palette.Priority(c.Priority).Fore);
        AssigneeValue.Text = c.AssignedTo is null ? s["unassigned"] : c.AssignedTo == Host.User?.Id ? s["you"] : Host.MemberName(c.AssignedTo);
        StartedValue.Text = c.CreatedAt is { } at ? $"{Display.ShortDate(at.ToLocalTime().Date, s.Language)} {Display.ClockTime(at, s.Language)}" : "—";

        ShowTags(c.Tags ?? []);
        if (reload || _loadedFor != c.Id)
        {
            _loadedFor = c.Id;
            NotesList.Children.Clear();
            LocationRow.Visibility = Visibility.Collapsed;
            DeviceRow.Visibility = Visibility.Collapsed;
            _ = LoadVisitorAsync(c.Id);
            _ = LoadNotesAsync(c.Id);
        }
    }

    public void Close()
    {
        _conversation = null;
        _loadedFor = null;
    }

    private void ApplyLanguage()
    {
        var s = Host.Strings;
        VisitorHeader.Text = s["contactInfo"];
        ConversationHeader.Text = s["conversationInfo"];
        StatusLabel.Text = s["status"];
        PriorityLabel.Text = s["priority"];
        AssigneeLabel.Text = s["assignee"];
        StartedLabel.Text = s["firstSeen"];
        TagsHeader.Text = s["tags"];
        NoTags.Text = s["noTags"];
        TagInput.PlaceholderText = s["tagPlaceholder"];
        NotesHeader.Text = s["internalNotes"];
        NotesPrivacy.Text = s["notesPrivacyNote"];
        NoNotes.Text = s["noNotes"];
        NoteInput.PlaceholderText = s["writeNote"];
        AddNoteButton.Content = s["addNote"];
    }

    // Visitor

    private async Task LoadVisitorAsync(string conversationId)
    {
        if (Host.Workspace is not { } ws) return;
        var p = await Host.Api.VisitorProfileAsync(ws.Id, conversationId);
        if (conversationId != _loadedFor || p is null) return;
        var place = string.Join("، ", new[] { p.Geo?.City, p.Geo?.Country }.Where(x => !string.IsNullOrWhiteSpace(x)));
        LocationText.Text = place;
        LocationRow.Visibility = place.Length > 0 ? Visibility.Visible : Visibility.Collapsed;
        var device = string.Join(" · ", new[] { p.Device?.Os, p.Device?.Browser, p.Device?.Device }.Where(x => !string.IsNullOrWhiteSpace(x)));
        DeviceText.Text = device;
        DeviceRow.Visibility = device.Length > 0 ? Visibility.Visible : Visibility.Collapsed;
    }

    // Tags

    private void ShowTags(IReadOnlyList<string> tags)
    {
        TagsPanel.Children.Clear();
        foreach (var tag in tags)
        {
            var remove = new Button
            {
                Padding = new Thickness(2),
                MinWidth = 0,
                MinHeight = 0,
                Background = Palette.Transparent,
                BorderThickness = new Thickness(0),
                Content = new FontIcon { Glyph = "", FontSize = 9 },
            };
            ToolTipService.SetToolTip(remove, Host.Strings["removeTag"]);
            remove.Click += async (_, _) => await SetTagsAsync(tags.Where(t => t != tag).ToList());
            TagsPanel.Children.Add(new Border
            {
                CornerRadius = new CornerRadius(999),
                Padding = new Thickness(10, 3, 4, 3),
                Background = Palette.Resource("BrandSoftBrush"),
                Child = new StackPanel
                {
                    Orientation = Orientation.Horizontal,
                    Spacing = 4,
                    Children =
                    {
                        new TextBlock { Text = tag, FontSize = 12, FontWeight = Microsoft.UI.Text.FontWeights.SemiBold, Foreground = Palette.Resource("BrandBrush"), VerticalAlignment = VerticalAlignment.Center },
                        remove,
                    },
                },
            });
        }
        NoTags.Visibility = tags.Count == 0 ? Visibility.Visible : Visibility.Collapsed;
    }

    private async void OnTagKeyDown(object sender, KeyRoutedEventArgs e)
    {
        if (e.Key != VirtualKey.Enter || _conversation is not { } c) return;
        e.Handled = true;
        var tag = TagInput.Text.Trim();
        if (tag.Length == 0) return;
        var tags = (c.Tags ?? []).ToList();
        if (!tags.Contains(tag, StringComparer.OrdinalIgnoreCase)) tags.Add(tag);
        TagInput.Text = string.Empty;
        await SetTagsAsync(tags);
    }

    private async Task SetTagsAsync(List<string> tags)
    {
        if (_conversation is not { } c || Host.Workspace is not { } ws) return;
        try
        {
            await Host.Api.SetTagsAsync(c.Id, ws.Id, tags);
            _conversation = c with { Tags = tags };
            ShowTags(tags);
            Changed?.Invoke();
        }
        catch (Exception e)
        {
            ShowError(e);
        }
    }

    // Notes

    private async Task LoadNotesAsync(string conversationId)
    {
        if (Host.Workspace is not { } ws) return;
        try
        {
            var notes = await Host.Api.NotesAsync(conversationId, ws.Id);
            if (conversationId != _loadedFor) return;
            ShowNotes(notes);
        }
        catch (Exception e)
        {
            Log.Error("notes", e);
        }
    }

    private void ShowNotes(IReadOnlyList<ConversationNote> notes)
    {
        var s = Host.Strings;
        NotesList.Children.Clear();
        foreach (var n in notes.OrderBy(n => n.CreatedAt ?? DateTimeOffset.MinValue))
        {
            var author = n.Author?.FullName is { Length: > 0 } a ? a : n.Author?.Email ?? s["you"];
            var when = n.CreatedAt is { } at ? Display.ListStamp(at, DateTimeOffset.Now, s) : string.Empty;
            var header = new Grid { ColumnSpacing = 8 };
            header.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            header.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            header.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            header.Children.Add(new Avatar { Size = 22, Kind = "operator", DisplayName = author, ImageUrl = n.Author?.AvatarUrl });
            var title = new TextBlock { Text = $"{author} · {when}", FontSize = 11.5, Foreground = Palette.Resource("Text2Brush"), VerticalAlignment = VerticalAlignment.Center, TextTrimming = TextTrimming.CharacterEllipsis };
            Grid.SetColumn(title, 1);
            header.Children.Add(title);
            if (n.AuthorId is null || n.AuthorId == Host.User?.Id)
            {
                var delete = new Button { Padding = new Thickness(4), MinWidth = 0, MinHeight = 0, Background = Palette.Transparent, BorderThickness = new Thickness(0), Content = new FontIcon { Glyph = "", FontSize = 11 } };
                ToolTipService.SetToolTip(delete, s["deleteNote"]);
                var id = n.Id;
                delete.Click += async (_, _) => await DeleteNoteAsync(id);
                Grid.SetColumn(delete, 2);
                header.Children.Add(delete);
            }
            NotesList.Children.Add(new Border
            {
                Padding = new Thickness(12, 8, 8, 10),
                CornerRadius = new CornerRadius(10),
                Background = Palette.Resource("NoteBubbleBrush"),
                BorderBrush = Palette.Resource("NoteBorderBrush"),
                BorderThickness = new Thickness(1),
                Child = new StackPanel
                {
                    Spacing = 4,
                    Children =
                    {
                        header,
                        new TextBlock { Text = n.Body, FontSize = 13, TextWrapping = TextWrapping.Wrap, IsTextSelectionEnabled = true },
                    },
                },
            });
        }
        NoNotes.Visibility = notes.Count == 0 ? Visibility.Visible : Visibility.Collapsed;
    }

    private async void OnAddNote(object sender, RoutedEventArgs e)
    {
        var body = NoteInput.Text.Trim();
        if (body.Length == 0 || _conversation is not { } c || Host.Workspace is not { } ws) return;
        AddNoteButton.IsEnabled = false;
        try
        {
            await Host.Api.AddNoteAsync(c.Id, ws.Id, body);
            NoteInput.Text = string.Empty;
            await LoadNotesAsync(c.Id);
        }
        catch (Exception ex)
        {
            ShowError(ex);
        }
        finally
        {
            AddNoteButton.IsEnabled = true;
        }
    }

    private async Task DeleteNoteAsync(string noteId)
    {
        if (_conversation is not { } c || Host.Workspace is not { } ws) return;
        try
        {
            await Host.Api.DeleteNoteAsync(c.Id, ws.Id, noteId);
            await LoadNotesAsync(c.Id);
        }
        catch (Exception e)
        {
            ShowError(e);
        }
    }

    private void ShowError(Exception e)
    {
        Log.Error("details", e);
        Error.Message = ErrorText.For(e, Host.Strings);
        Error.IsOpen = true;
    }
}
