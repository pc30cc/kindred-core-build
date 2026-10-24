namespace Webyar.Core.Inbox;

/// <summary>
/// The two glyphs the whole product draws where there is no picture, on a
/// 24 × 24 grid: the person, for an operator or a teammate without a photo
/// (never initials), and the workspace's shop front, for a workspace whose
/// owner set no logo (never its first letter).
///
/// One design for the web panel, both website widgets and every native app,
/// so these are not a redrawing: they are the canonical SVG paths in their
/// expanded form (absolute commands, every number on its own), as XAML path
/// markup, which <c>src/test/native/avatarGlyphs.test.ts</c> compares with the
/// canonical ones point for point. <c>F1</c> is the nonzero rule SVG uses;
/// no outline overlaps another, so either rule gives the same pixels. Both
/// are left–right symmetric, so they never mirror under right to left.
/// </summary>
public static class AvatarGlyphs
{
    /// <summary>The person: a head and a pair of shoulders.</summary>
    public const string PersonPath =
        "F1 M 12 3 A 4.5 4.5 0 1 1 12 12 A 4.5 4.5 0 0 1 12 3 Z " +
        "M 12 13.75 C 7.4 13.75 4 16.05 4 19 C 4 20.1 4.9 21 6 21 L 18 21 " +
        "C 19.1 21 20 20.1 20 19 C 20 16.05 16.6 13.75 12 13.75 Z";

    /// <summary>The workspace: a shop front with a scalloped awning and an arched door.</summary>
    public const string WorkspacePath =
        "F1 M 6.6 3 L 17.4 3 Q 18.3 3 18.78 3.83 L 21.5 8.5 A 2.375 2.375 0 0 1 20.25 10.59 " +
        "L 20.25 18.75 A 2.25 2.25 0 0 1 18 21 L 6 21 A 2.25 2.25 0 0 1 3.75 18.75 " +
        "L 3.75 10.59 A 2.375 2.375 0 0 1 2.5 8.5 L 5.22 3.83 Q 5.7 3 6.6 3 Z " +
        "M 5.75 10.71 L 5.75 18.75 Q 5.75 19 6 19 L 10 19 L 10 16.25 A 2 2 0 0 1 14 16.25 " +
        "L 14 19 L 18 19 Q 18.25 19 18.25 18.75 L 18.25 10.71 A 2.375 2.375 0 0 1 16.75 8.5 " +
        "A 2.375 2.375 0 0 1 12 8.5 A 2.375 2.375 0 0 1 7.25 8.5 A 2.375 2.375 0 0 1 5.75 10.71 Z";

    /// <summary>
    /// How much of an avatar <paramref name="size"/> pixels across the person
    /// glyph's 24-unit box takes, centred: a little more on a small chip so
    /// the figure stays legible.
    /// </summary>
    public static double PersonBox(double size) => size <= 24 ? 0.68 : 0.62;

    /// <summary>How much of its tile the workspace glyph's 24-unit box takes.</summary>
    public static double WorkspaceBox(double size) => size <= 24 ? 0.62 : 0.58;
}
