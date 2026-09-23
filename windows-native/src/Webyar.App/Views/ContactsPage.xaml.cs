using System.Collections.ObjectModel;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Navigation;
using Webyar.App.Helpers;
using Webyar.App.Services;
using Webyar.App.ViewModels;
using Webyar.Core.Inbox;
using Webyar.Core.Localization;

namespace Webyar.App.Views;

/// <summary>Everyone who has talked to the workspace, searchable, with their details.</summary>
public sealed partial class ContactsPage : Page
{
    private readonly ObservableCollection<ContactItem> _items = [];
    private List<ContactItem> _all = [];

    public ContactsPage()
    {
        InitializeComponent();
        List.ItemsSource = _items;
    }

    private static AppHost Host => App.Current.Host;

    protected override async void OnNavigatedTo(NavigationEventArgs e)
    {
        base.OnNavigatedTo(e);
        var s = Host.Strings;
        HeaderText.Text = s["tabContacts"];
        Search.PlaceholderText = s["contactsSearch"];
        EmptyTitle.Text = s["contactsEmptyTitle"];
        EmptyBody.Text = s["contactsEmptyBody"];
        PlaceholderTitle.Text = s["noContactSelected"];
        if (Host.Workspace is not { } ws) return;
        try
        {
            var contacts = await Host.Api.ContactsAsync(ws.Id);
            _all = contacts.Select(c => new ContactItem(c, s)).OrderBy(c => c.Name, StringComparer.CurrentCulture).ToList();
            CountText.Text = Digits.Localize(_all.Count.ToString(System.Globalization.CultureInfo.InvariantCulture), s.Language);
            Filter();
        }
        catch (Exception ex)
        {
            Log.Error("contacts", ex);
            EmptyTitle.Text = ErrorText.For(ex, s);
            EmptyBody.Text = string.Empty;
            Empty.Visibility = Visibility.Visible;
        }
        finally
        {
            Loading.IsActive = false;
            Loading.Visibility = Visibility.Collapsed;
        }
    }

    private void Filter()
    {
        var q = Search.Text.Trim();
        _items.Clear();
        foreach (var c in _all.Where(c => c.Matches(q)).Take(500)) _items.Add(c);
        Empty.Visibility = _items.Count == 0 ? Visibility.Visible : Visibility.Collapsed;
    }

    private void OnSearch(AutoSuggestBox sender, AutoSuggestBoxTextChangedEventArgs args) => Filter();

    private void OnSelect(object sender, SelectionChangedEventArgs e)
    {
        if (List.SelectedItem is not ContactItem c) return;
        var s = Host.Strings;
        Placeholder.Visibility = Visibility.Collapsed;
        Card.Visibility = Visibility.Visible;
        CardAvatar.DisplayName = c.RawName;
        CardAvatar.Email = c.Email;
        CardAvatar.ImageUrl = c.AvatarUrl;
        CardName.Text = c.Name;
        CardRows.Children.Clear();
        Row("", s["emailLabel"], c.Contact.Email);
        Row("", s["phoneLabel"], c.Contact.Phone);
        Row("", s["unknownVisitor"], c.Contact.VisitorCode);
        Row("", s["firstSeen"], c.Contact.CreatedAt is { } at ? Display.ShortDate(at.ToLocalTime().Date, s.Language) : null);
    }

    private void Row(string glyph, string label, string? value)
    {
        if (string.IsNullOrWhiteSpace(value)) return;
        var g = new Grid { ColumnSpacing = 12 };
        g.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        g.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        g.Children.Add(new Border
        {
            Width = 34,
            Height = 34,
            CornerRadius = new CornerRadius(8),
            Background = Palette.Resource("BrandSoftBrush"),
            Child = new FontIcon { Glyph = glyph, FontSize = 14, Foreground = Palette.Resource("BrandBrush") },
        });
        var text = new StackPanel { VerticalAlignment = VerticalAlignment.Center };
        text.Children.Add(new TextBlock { Text = label, FontSize = 11.5, Foreground = Palette.Resource("Text3Brush") });
        text.Children.Add(new TextBlock { Text = value, FontSize = 14, IsTextSelectionEnabled = true, TextWrapping = TextWrapping.Wrap });
        Grid.SetColumn(text, 1);
        g.Children.Add(text);
        CardRows.Children.Add(g);
    }
}
