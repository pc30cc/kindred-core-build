using Webyar.Core.Config;
using Xunit;

namespace Webyar.Core.Tests;

public class UpdateFeedsTests
{
    private static readonly string[] NoExtras = [];

    // Each build trusts its own brand's repository and site only (Brand.cs).
    private const string Repo = "https://github.com/" + Brand.ReleasesRepo;
    private const string RepoName = Brand.ReleasesRepo;

    public static TheoryData<string> OfficialFeeds() => new()
    {
        Repo,
        Repo + "/releases/latest/download",
        "https://github.com/" + RepoName.ToUpperInvariant() + "/",
    };

    [Theory]
    [MemberData(nameof(OfficialFeeds))]
    public void The_official_releases_repo_is_trusted(string feed)
    {
        Assert.Equal(Repo, UpdateFeeds.TrustedGithubRepo(feed));
        Assert.True(UpdateFeeds.IsTrusted(feed, NoExtras));
    }

    public static TheoryData<string> OtherFeeds() => new()
    {
        "https://github.com/attacker/" + RepoName.Split('/')[1],
        Repo + "-evil",
        "https://github.com.evil.example/" + RepoName,
        "http://github.com/" + RepoName,
        "https://user@github.com/" + RepoName,
        "https://github.com:8443/" + RepoName,
        "https://updates.self-hosted.example/feed",
        "not a url",
    };

    [Theory]
    [MemberData(nameof(OtherFeeds))]
    public void Anything_else_is_not(string feed)
    {
        Assert.Null(UpdateFeeds.TrustedGithubRepo(feed));
        Assert.False(UpdateFeeds.IsTrusted(feed, NoExtras));
    }

    [Fact]
    public void The_other_brands_feeds_are_not_trusted()
    {
#if BRAND_RESPOK
        string[] other = ["https://github.com/pc30cc/webyar-desktop-releases", "https://app.webyar.ai/downloads/windows"];
#else
        string[] other = ["https://github.com/pc30cc/respok-releases", "https://app.respok.app/downloads/windows"];
#endif
        foreach (var feed in other) Assert.False(UpdateFeeds.IsTrusted(feed, NoExtras), feed);
    }

    [Fact]
    public void No_feed_is_not_trusted()
    {
        Assert.Null(UpdateFeeds.TrustedGithubRepo(null));
        Assert.False(UpdateFeeds.IsTrusted(null, NoExtras));
    }

    [Fact]
    public void Build_time_web_feeds_are_matched_by_folder()
    {
        string[] extras = ["https://updates.example.com/win"];
        Assert.True(UpdateFeeds.IsTrusted("https://updates.example.com/win/stable", extras));
        Assert.True(UpdateFeeds.IsTrusted("https://updates.example.com/win", extras));
        Assert.False(UpdateFeeds.IsTrusted("https://updates.example.com/winx", extras));
        Assert.False(UpdateFeeds.IsTrusted("https://updates.example.com/other", extras));
        Assert.False(UpdateFeeds.IsTrusted("https://updates.example.com/win/%2e%2e/other", extras));
        Assert.False(UpdateFeeds.IsTrusted("http://updates.example.com/win", extras));
    }

    [Fact]
    public void The_site_mirror_is_trusted_without_build_time_extras()
    {
        Assert.True(UpdateFeeds.IsTrusted(Brand.SiteFeed, NoExtras));
        Assert.True(UpdateFeeds.IsTrusted(Brand.SiteFeed + "/", NoExtras));
        Assert.False(UpdateFeeds.IsTrusted(Brand.SiteFeed.Replace("/windows", "/other"), NoExtras));
        Assert.False(UpdateFeeds.IsTrusted(Brand.SiteFeed.Replace("https://", "http://"), NoExtras));
    }
}
