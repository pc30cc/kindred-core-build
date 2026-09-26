using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Windows.Foundation;

namespace Webyar.App.Controls;

/// <summary>
/// Equal-width columns, as many as fit (up to <see cref="MaxColumns"/>) with
/// each at least <see cref="MinColumnWidth"/> wide; a row is as tall as its
/// tallest child. The analytics dashboard's tiles and cards: three across on
/// a wide window, fewer as it narrows, one under the other at the end.
/// </summary>
public sealed partial class AdaptiveGrid : Panel
{
    public int MaxColumns { get; set; } = 3;
    public double MinColumnWidth { get; set; } = 150;
    public double Spacing { get; set; } = 12;

    private int Columns(double width)
    {
        if (double.IsInfinity(width) || width <= 0) return Math.Max(1, MaxColumns);
        var fit = (int)Math.Floor((width + Spacing) / (MinColumnWidth + Spacing));
        return Math.Clamp(fit, 1, Math.Max(1, Math.Min(MaxColumns, Children.Count)));
    }

    private double ColumnWidth(double width, int columns) =>
        double.IsInfinity(width) ? MinColumnWidth : Math.Max(0, (width - Spacing * (columns - 1)) / columns);

    protected override Size MeasureOverride(Size available)
    {
        var columns = Columns(available.Width);
        var cell = ColumnWidth(available.Width, columns);
        double height = 0, row = 0;
        for (var i = 0; i < Children.Count; i++)
        {
            var child = Children[i];
            child.Measure(new Size(cell, double.PositiveInfinity));
            row = Math.Max(row, child.DesiredSize.Height);
            if (i % columns == columns - 1 || i == Children.Count - 1)
            {
                height += row + (height > 0 ? Spacing : 0);
                row = 0;
            }
        }
        var width = double.IsInfinity(available.Width) ? cell * columns + Spacing * (columns - 1) : available.Width;
        return new Size(width, height);
    }

    protected override Size ArrangeOverride(Size final)
    {
        var columns = Columns(final.Width);
        var cell = ColumnWidth(final.Width, columns);
        double y = 0;
        for (var start = 0; start < Children.Count; start += columns)
        {
            var end = Math.Min(start + columns, Children.Count);
            double row = 0;
            for (var i = start; i < end; i++) row = Math.Max(row, Children[i].DesiredSize.Height);
            for (var i = start; i < end; i++)
            {
                // Right to left, the first column is the right-hand one; the layout system mirrors it for us.
                Children[i].Arrange(new Rect((i - start) * (cell + Spacing), y, cell, row));
            }
            y += row + Spacing;
        }
        return final;
    }
}
