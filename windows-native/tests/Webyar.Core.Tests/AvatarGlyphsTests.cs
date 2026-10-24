using System.Globalization;
using Webyar.Core.Inbox;
using Xunit;

namespace Webyar.Core.Tests;

/// <summary>
/// The platform's two avatar glyphs (AvatarGlyphs): a teammate without a
/// photo is the person and a workspace without a logo the shop front, never
/// letters. The strings themselves are compared with the canonical paths by
/// src/test/native/avatarGlyphs.test.ts; these pin what the app relies on
/// when it draws them.
/// </summary>
public class AvatarGlyphsTests
{
    /// <summary>The end point of every drawing command, in order.</summary>
    private static List<(double X, double Y)> EndPoints(string markup)
    {
        var tokens = markup.Split(' ', StringSplitOptions.RemoveEmptyEntries);
        var points = new List<(double, double)>();
        var i = 0;
        double N() => double.Parse(tokens[i++], CultureInfo.InvariantCulture);
        while (i < tokens.Length)
        {
            var command = tokens[i++];
            switch (command)
            {
                case "F1": break;
                case "M" or "L": points.Add((N(), N())); break;
                case "Q": N(); N(); points.Add((N(), N())); break;
                case "C": N(); N(); N(); N(); points.Add((N(), N())); break;
                case "A": N(); N(); N(); N(); N(); points.Add((N(), N())); break;
                case "Z": break;
                default: throw new FormatException($"'{command}' is not a command the glyphs are written in");
            }
        }
        return points;
    }

    [Theory]
    [InlineData(AvatarGlyphs.PersonPath, 4, 20)]
    [InlineData(AvatarGlyphs.WorkspacePath, 2.5, 21.5)]
    public void A_glyph_stands_from_three_to_twenty_one_and_is_centred(string markup, double left, double right)
    {
        var points = EndPoints(markup);
        Assert.Equal(3, points.Min(p => p.Y));
        Assert.Equal(21, points.Max(p => p.Y));
        Assert.Equal(left, points.Min(p => p.X));
        Assert.Equal(right, points.Max(p => p.X));
        Assert.Equal(24, left + right);
    }

    [Theory]
    [InlineData(AvatarGlyphs.PersonPath)]
    [InlineData(AvatarGlyphs.WorkspacePath)]
    public void A_glyph_is_its_own_mirror_image_so_right_to_left_never_flips_it(string markup)
    {
        var points = EndPoints(markup).Select(p => (Math.Round(p.X, 3), Math.Round(p.Y, 3))).ToHashSet();
        var mirrored = points.Select(p => (Math.Round(24 - p.Item1, 3), p.Item2)).ToHashSet();
        Assert.True(points.SetEquals(mirrored));
    }

    [Theory]
    [InlineData(AvatarGlyphs.PersonPath)]
    [InlineData(AvatarGlyphs.WorkspacePath)]
    public void A_glyph_is_written_for_xaml_with_the_nonzero_rule_and_closed_outlines(string markup)
    {
        Assert.StartsWith("F1 M ", markup);
        Assert.EndsWith(" Z", markup);
        Assert.Equal(2, markup.Split(' ').Count(t => t == "Z"));
        // Two outlines, no letters: nothing but commands and numbers.
        Assert.All(markup.Split(' '), t => Assert.True(t is "F1" or "M" or "L" or "Q" or "C" or "A" or "Z" || double.TryParse(t, NumberStyles.Float, CultureInfo.InvariantCulture, out _), t));
    }

    [Fact]
    public void The_glyphs_take_their_share_of_the_tile()
    {
        Assert.Equal(0.62, AvatarGlyphs.PersonBox(40));
        Assert.Equal(0.68, AvatarGlyphs.PersonBox(20));
        Assert.Equal(0.58, AvatarGlyphs.WorkspaceBox(28));
        Assert.Equal(0.62, AvatarGlyphs.WorkspaceBox(24));
    }
}
