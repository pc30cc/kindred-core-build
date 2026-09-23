using Webyar.Core.Inbox;
using Xunit;

namespace Webyar.Core.Tests;

public class AvatarArtTests
{
    // Reference values from the web console's own djb2 in node.
    [Theory]
    [InlineData("?", 177562u)]
    [InlineData("مجتبی", 3836580610u)]
    [InlineData("test@test.com", 4038836234u)]
    [InlineData("تستم", 2066653683u)]
    [InlineData("sara", 2088338468u)]
    public void Hash_matches_the_web(string seed, uint expected) => Assert.Equal(expected, AvatarArt.Djb2(seed));

    [Fact]
    public void Picks_os_logo_then_gradient_like_the_web()
    {
        var mac = AvatarArt.For(null, null, "macOS");
        Assert.Equal(AvatarOs.Apple, mac.Os);
        Assert.Equal(AvatarOs.Windows, AvatarArt.For("x", null, "Windows 10").Os);
        Assert.Equal(AvatarOs.Android, AvatarArt.For(null, null, "Android").Os);
        Assert.Equal(AvatarOs.Apple, AvatarArt.For(null, null, "iOS").Os);

        var test = AvatarArt.For(null, "test@test.com", null); // palette index 2: (192, 78)
        Assert.Equal(new Hsl(192, 78, 56), test.From);
        Assert.Equal(new Hsl(220, 78, 44), test.To);
        Assert.Equal("TE", test.Initials);
    }

    [Theory]
    [InlineData("مجتبی داودی", null, "مد")]
    [InlineData("مجتبی", null, "مج")]
    [InlineData(null, null, "?")]
    [InlineData("a", null, "A")]
    public void Initials_follow_the_web(string? name, string? email, string expected) => Assert.Equal(expected, AvatarArt.InitialsOf(name, email));

    [Fact]
    public void Hsl_converts_to_rgb() => Assert.Equal(((byte)60, (byte)131, (byte)246), new Hsl(217, 91, 60).ToRgb());
}
