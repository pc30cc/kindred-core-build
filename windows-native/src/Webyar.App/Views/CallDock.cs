using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Webyar.App.Controls;
using Webyar.App.Services;
using Windows.Foundation;

namespace Webyar.App.Views;

/// <summary>
/// Where a docked call is drawn. Its media page lives on a layer the shell
/// keeps over its content for as long as the call is in its page — so going to
/// another section never tears the call down — and it is laid over the page's
/// <see cref="CallDockSlot"/> that holds it: under the conversation's header,
/// or over the call on the desk. With no such slot on screen the page waits off
/// to the side, still in the call, and the sidebar's call bar leads back.
/// </summary>
internal static class CallDock
{
    /// <summary>Space around the panel inside its slot, as the Mac pads it: 12 at the sides, 8 above, 4 below.</summary>
    private const double Side = 12, Top = 8, Bottom = 4;

    private static readonly List<CallDockSlot> Slots = [];
    private static Canvas? _layer;
    private static CallSurface? _surface;
    private static bool _onScreen;

    /// <summary>Raised when the docked call comes on screen in its page or leaves it (the call bar follows).</summary>
    public static event Action? Changed;

    /// <summary>The docked call is on screen in its page.</summary>
    public static bool IsOnScreen => _onScreen;

    /// <summary>The shell's layer over its content; null when the shell goes.</summary>
    public static void SetLayer(Canvas? layer)
    {
        if (ReferenceEquals(_layer, layer)) return;
        if (_layer is not null && _surface is not null) _layer.Children.Remove(_surface.View);
        _layer = layer;
        if (_layer is not null)
        {
            // Left to right, so the view's place is measured the same way in either language.
            _layer.FlowDirection = FlowDirection.LeftToRight;
            _layer.SizeChanged += (_, _) => Place();
        }
        AddView();
        Place();
    }

    public static void Show(CallSurface surface)
    {
        if (_surface is not null && !ReferenceEquals(_surface, surface)) _layer?.Children.Remove(_surface.View);
        _surface = surface;
        AddView();
        Place();
    }

    public static void Remove(CallSurface surface)
    {
        _layer?.Children.Remove(surface.View);
        if (ReferenceEquals(_surface, surface)) _surface = null;
        Place();
    }

    private static void AddView()
    {
        if (_layer is null || _surface is null || _layer.Children.Contains(_surface.View)) return;
        // Off to the side until a slot shows it: the page starts, and joins the call, either way.
        _surface.View.Width = 480;
        _surface.View.Height = 300;
        Canvas.SetLeft(_surface.View, -20000);
        _layer.Children.Add(_surface.View);
    }

    internal static void Register(CallDockSlot slot)
    {
        if (!Slots.Contains(slot)) Slots.Add(slot);
        Place();
    }

    internal static void Unregister(CallDockSlot slot)
    {
        Slots.Remove(slot);
        slot.Reserve(0);
        Place();
    }

    /// <summary>
    /// Opens the slot that holds the call (and closes the others), then lays the
    /// call's page over it — or off to the side when no slot on screen holds it.
    /// </summary>
    public static void Place()
    {
        try
        {
            var call = LiveCall.Running;
            var docked = call is { Shown: LiveCall.Presentation.Docked } && _surface is not null && ReferenceEquals(call.DockedSurface, _surface);
            CallDockSlot? holder = null;
            foreach (var slot in Slots)
            {
                var holds = docked && holder is null && slot.Key is { } key && key == call!.DockKey && slot.IsOnScreen;
                if (holds) holder = slot;
                slot.Reserve(holds ? call!.DockHeight + Top + Bottom : 0);
            }
            if (_surface is { } surface && _layer is { } layer)
            {
                var view = surface.View;
                if (holder is not null && holder.ActualWidth > 0 && holder.XamlRoot is not null && ReferenceEquals(holder.XamlRoot, layer.XamlRoot))
                {
                    var box = holder.TransformToVisual(layer).TransformBounds(new Rect(0, 0, holder.ActualWidth, holder.ActualHeight));
                    Set(view, box.X + Side, box.Y + Top, Math.Max(0, box.Width - 2 * Side), call!.DockHeight);
                }
                else if (Canvas.GetLeft(view) > -10000)
                {
                    Canvas.SetLeft(view, -20000);
                }
            }
            var onScreen = holder is not null;
            if (onScreen != _onScreen)
            {
                _onScreen = onScreen;
                Changed?.Invoke();
            }
        }
        catch (Exception e)
        {
            Log.Error("call dock", e);
        }
    }

    /// <summary>Moves and sizes only when something changed: every change lays the page out again, which calls back here.</summary>
    private static void Set(FrameworkElement view, double x, double y, double w, double h)
    {
        if (Math.Abs(Canvas.GetLeft(view) - x) > 0.5) Canvas.SetLeft(view, x);
        if (Math.Abs(Canvas.GetTop(view) - y) > 0.5) Canvas.SetTop(view, y);
        if (double.IsNaN(view.Width) || Math.Abs(view.Width - w) > 0.5) view.Width = w;
        if (double.IsNaN(view.Height) || Math.Abs(view.Height - h) > 0.5) view.Height = h;
    }
}
