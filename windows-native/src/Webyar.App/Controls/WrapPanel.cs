using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Windows.Foundation;

namespace Webyar.App.Controls;

/// <summary>Lays children out in rows, starting a new row when one is full — for tag chips.</summary>
public sealed partial class WrapPanel : Panel
{
    public double Spacing { get; set; } = 6;

    protected override Size MeasureOverride(Size available)
    {
        double x = 0, y = 0, row = 0, width = 0;
        foreach (var child in Children)
        {
            child.Measure(new Size(available.Width, double.PositiveInfinity));
            var d = child.DesiredSize;
            if (x > 0 && x + d.Width > available.Width)
            {
                y += row + Spacing;
                x = 0;
                row = 0;
            }
            x += d.Width + Spacing;
            row = Math.Max(row, d.Height);
            width = Math.Max(width, x - Spacing);
        }
        return new Size(double.IsInfinity(available.Width) ? width : Math.Min(width, available.Width), y + row);
    }

    protected override Size ArrangeOverride(Size final)
    {
        double x = 0, y = 0, row = 0;
        foreach (var child in Children)
        {
            var d = child.DesiredSize;
            if (x > 0 && x + d.Width > final.Width)
            {
                y += row + Spacing;
                x = 0;
                row = 0;
            }
            child.Arrange(new Rect(x, y, d.Width, d.Height));
            x += d.Width + Spacing;
            row = Math.Max(row, d.Height);
        }
        return final;
    }
}
