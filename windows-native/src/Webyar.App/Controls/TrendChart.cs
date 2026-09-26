using Microsoft.UI;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Shapes;
using Webyar.App.Helpers;
using Webyar.Core.Analytics;
using Webyar.Core.Localization;
using Windows.Foundation;
using Windows.UI;

namespace Webyar.App.Controls;

/// <summary>
/// Visits or page views, day by day: a smooth line over a soft gradient, a
/// few numbers up the side and days along the bottom, and the day under the
/// pointer called out with a dashed rule, a dot and its count — the Mac app's
/// trend chart. Time runs left to right in every language, as on the web.
/// </summary>
public sealed partial class TrendChart : Grid
{
    private const double ChartHeight = 240;
    private const double AxisWidth = 44;
    private const double AxisHeight = 22;

    private readonly Strings _s;
    private readonly Color _tint;
    private readonly string _unit;
    private readonly Canvas _plot = new() { Background = new SolidColorBrush(Colors.Transparent) };
    private readonly Canvas _yAxis = new();
    private readonly Canvas _xAxis = new();
    private readonly Line _rule = new() { StrokeThickness = 1, StrokeDashArray = new DoubleCollection { 3, 3 }, Visibility = Visibility.Collapsed };
    private readonly Ellipse _dot = new() { Width = 10, Height = 10, Visibility = Visibility.Collapsed };
    private readonly Border _tip = new() { CornerRadius = new CornerRadius(8), Padding = new Thickness(10, 6, 10, 6), BorderThickness = new Thickness(1), Visibility = Visibility.Collapsed };
    private readonly TextBlock _tipDay = new() { FontSize = 11 };
    private readonly TextBlock _tipValue = new() { FontSize = 13, FontWeight = Microsoft.UI.Text.FontWeights.Bold };
    private List<(DateTime Day, int Value)> _points = [];
    private double _max = 1;

    public TrendChart(Strings s, Color tint, string unit)
    {
        _s = s;
        _tint = tint;
        _unit = unit;
        FlowDirection = FlowDirection.LeftToRight;
        Height = ChartHeight;
        ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(AxisWidth) });
        ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
        RowDefinitions.Add(new RowDefinition { Height = new GridLength(AxisHeight) });

        Children.Add(_yAxis);
        SetColumn(_plot, 1);
        Children.Add(_plot);
        SetColumn(_xAxis, 1);
        SetRow(_xAxis, 1);
        Children.Add(_xAxis);

        var tip = new StackPanel { Spacing = 2 };
        tip.Children.Add(_tipDay);
        tip.Children.Add(_tipValue);
        _tip.Child = tip;
        _tip.FlowDirection = s.IsRightToLeft ? FlowDirection.RightToLeft : FlowDirection.LeftToRight;

        _plot.SizeChanged += (_, _) => Draw();
        _plot.PointerMoved += OnPointer;
        _plot.PointerExited += (_, _) => HideSelection();
        _plot.PointerCanceled += (_, _) => HideSelection();
    }

    public void SetPoints(IReadOnlyList<(DateTime Day, int Value)> points)
    {
        _points = [.. points.OrderBy(p => p.Day)];
        _max = NiceMax(_points.Count == 0 ? 1 : _points.Max(p => p.Value));
        Draw();
    }

    /// <summary>A round top for the scale: 1, 2 or 5 times a power of ten, at least the largest value.</summary>
    private static double NiceMax(int max)
    {
        if (max <= 4) return 4;
        var magnitude = Math.Pow(10, Math.Floor(Math.Log10(max)));
        foreach (var step in new[] { 1, 2, 2.5, 5, 10 })
            if (step * magnitude >= max) return step * magnitude;
        return 10 * magnitude;
    }

    private double X(int i, double width) => _points.Count <= 1 ? width / 2 : i * width / (_points.Count - 1);

    private double Y(double value, double height) => height - value / _max * (height - 8);

    private void Draw()
    {
        var width = _plot.ActualWidth;
        var height = _plot.ActualHeight;
        _plot.Children.Clear();
        _yAxis.Children.Clear();
        _xAxis.Children.Clear();
        if (width <= 0 || height <= 0 || _points.Count == 0) return;

        var line = Palette.Resource("LineBrush");
        var muted = Palette.Resource("Text3Brush");

        // Four grid lines with their values, up the leading side.
        for (var i = 0; i <= 4; i++)
        {
            var value = _max * i / 4;
            var y = Y(value, height);
            _plot.Children.Add(new Line { X1 = 0, X2 = width, Y1 = y, Y2 = y, Stroke = line, StrokeThickness = 1 });
            var label = new TextBlock { Text = AnalyticsFormat.Count((int)Math.Round(value), _s), FontSize = 10.5, Foreground = muted, Width = AxisWidth - 8, TextAlignment = TextAlignment.Right };
            Canvas.SetTop(label, y - 8);
            _yAxis.Children.Add(label);
        }

        // The area and the line, through monotone-ish midpoints so it reads smooth without overshooting.
        var pts = _points.Select((p, i) => new Point(X(i, width), Y(p.Value, height))).ToList();
        var stroke = new PathFigure { StartPoint = pts[0], IsClosed = false, Segments = new PathSegmentCollection() };
        var area = new PathFigure { StartPoint = new Point(pts[0].X, height), IsClosed = true, Segments = new PathSegmentCollection() };
        area.Segments.Add(new LineSegment { Point = pts[0] });
        for (var i = 1; i < pts.Count; i++)
        {
            var a = pts[i - 1];
            var b = pts[i];
            var mid = (a.X + b.X) / 2;
            var curve = new BezierSegment { Point1 = new Point(mid, a.Y), Point2 = new Point(mid, b.Y), Point3 = b };
            stroke.Segments.Add(curve);
            area.Segments.Add(new BezierSegment { Point1 = curve.Point1, Point2 = curve.Point2, Point3 = curve.Point3 });
        }
        area.Segments.Add(new LineSegment { Point = new Point(pts[^1].X, height) });

        _plot.Children.Add(new Microsoft.UI.Xaml.Shapes.Path
        {
            Data = new PathGeometry { Figures = new PathFigureCollection { area } },
            Fill = new LinearGradientBrush
            {
                StartPoint = new Point(0, 0),
                EndPoint = new Point(0, 1),
                GradientStops =
                {
                    new GradientStop { Color = Color.FromArgb(0x42, _tint.R, _tint.G, _tint.B), Offset = 0 },
                    new GradientStop { Color = Color.FromArgb(0x05, _tint.R, _tint.G, _tint.B), Offset = 1 },
                },
            },
        });
        _plot.Children.Add(new Microsoft.UI.Xaml.Shapes.Path
        {
            Data = new PathGeometry { Figures = new PathFigureCollection { stroke } },
            Stroke = new SolidColorBrush(_tint),
            StrokeThickness = 2,
            StrokeLineJoin = PenLineJoin.Round,
            StrokeStartLineCap = PenLineCap.Round,
            StrokeEndLineCap = PenLineCap.Round,
        });

        // About six days along the bottom.
        var every = Math.Max(1, (int)Math.Ceiling(_points.Count / 6.0));
        for (var i = 0; i < _points.Count; i += every)
        {
            var label = new TextBlock { Text = AnalyticsFormat.DayLabel(_points[i].Day, _s), FontSize = 10.5, Foreground = muted };
            label.Measure(new Size(double.PositiveInfinity, double.PositiveInfinity));
            Canvas.SetLeft(label, Math.Clamp(X(i, width) - label.DesiredSize.Width / 2, 0, Math.Max(0, width - label.DesiredSize.Width)));
            Canvas.SetTop(label, 4);
            _xAxis.Children.Add(label);
        }

        _rule.Stroke = Palette.Resource("Text3Brush");
        _rule.Opacity = 0.6;
        _dot.Fill = new SolidColorBrush(_tint);
        _dot.Stroke = Palette.Resource("SurfaceBrush");
        _dot.StrokeThickness = 2;
        _tip.Background = Palette.Resource("SurfaceBrush");
        _tip.BorderBrush = Palette.Resource("LineBrush");
        _tipDay.Foreground = Palette.Resource("Text2Brush");
        _tipValue.Foreground = Palette.Resource("TextBrush");
        _plot.Children.Add(_rule);
        _plot.Children.Add(_dot);
        _plot.Children.Add(_tip);
        HideSelection();
    }

    private void OnPointer(object sender, PointerRoutedEventArgs e)
    {
        if (_points.Count == 0) return;
        var width = _plot.ActualWidth;
        var height = _plot.ActualHeight;
        var x = e.GetCurrentPoint(_plot).Position.X;
        var i = _points.Count <= 1 ? 0 : (int)Math.Round(Math.Clamp(x / width, 0, 1) * (_points.Count - 1));
        var px = X(i, width);
        var py = Y(_points[i].Value, height);
        _rule.X1 = _rule.X2 = px;
        _rule.Y1 = 0;
        _rule.Y2 = height;
        Canvas.SetLeft(_dot, px - _dot.Width / 2);
        Canvas.SetTop(_dot, py - _dot.Height / 2);
        _tipDay.Text = AnalyticsFormat.DayLabel(_points[i].Day, _s, longForm: true);
        _tipValue.Text = $"{AnalyticsFormat.Count(_points[i].Value, _s)} {_unit}";
        _tip.Measure(new Size(double.PositiveInfinity, double.PositiveInfinity));
        var tw = _tip.DesiredSize.Width;
        var th = _tip.DesiredSize.Height;
        Canvas.SetLeft(_tip, Math.Clamp(px - tw / 2, 0, Math.Max(0, width - tw)));
        Canvas.SetTop(_tip, Math.Max(0, py - th - 12));
        _rule.Visibility = _dot.Visibility = _tip.Visibility = Visibility.Visible;
    }

    private void HideSelection() => _rule.Visibility = _dot.Visibility = _tip.Visibility = Visibility.Collapsed;
}
