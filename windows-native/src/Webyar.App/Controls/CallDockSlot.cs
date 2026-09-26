using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Webyar.App.Views;

namespace Webyar.App.Controls;

/// <summary>
/// The place a page keeps for the call that belongs to it: under a
/// conversation's header ("conv:{id}"), or over the call on the call-center
/// desk ("desk:{call id}"). Empty and flat unless that call is docked here;
/// then it opens to the panel's height and <see cref="CallDock"/> lays the
/// call's page over it.
/// </summary>
public sealed partial class CallDockSlot : Grid
{
    private string? _key;
    private bool _loaded;

    public CallDockSlot()
    {
        Height = 0;
        Loaded += (_, _) =>
        {
            _loaded = true;
            CallDock.Register(this);
        };
        Unloaded += (_, _) =>
        {
            _loaded = false;
            CallDock.Unregister(this);
        };
        // The page moved, resized or showed the slot: the call's page follows it.
        LayoutUpdated += (_, _) =>
        {
            if (Height > 0 || (_key is not null && _key == LiveCall.Running?.DockKey)) CallDock.Place();
        };
    }

    /// <summary>Which call this place is for: "conv:{conversation id}" or "desk:{call id}".</summary>
    public string? Key
    {
        get => _key;
        set
        {
            if (_key == value) return;
            _key = value;
            CallDock.Place();
        }
    }

    /// <summary>In the window and not inside anything collapsed (a conversation not open yet, a page's placeholder).</summary>
    internal bool IsOnScreen
    {
        get
        {
            if (!_loaded || XamlRoot is null) return false;
            for (DependencyObject? d = this; d is not null; d = VisualTreeHelper.GetParent(d))
            {
                if (d is UIElement { Visibility: Visibility.Collapsed }) return false;
            }
            return true;
        }
    }

    /// <summary>Opens to the given height, or closes flat.</summary>
    internal void Reserve(double height)
    {
        if (Math.Abs(Height - height) > 0.5) Height = height;
    }
}
