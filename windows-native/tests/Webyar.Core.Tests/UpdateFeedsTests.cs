using Webyar.Core.Config;
using Xunit;

namespace Webyar.Core.Tests;

public class UpdateFeedsTests
{
    private static readonly string[] NoExtras = [];

    [Theory]
    [InlineData("https://github.com/pc30cc/webyar-desktop-releases")]
    [InlineData("https://github.com/pc30cc/webyar-desktop-releases/releases/latest/download")]
    [InlineData("https://github.com/PC30CC/Webyar-Desktop-Releases/")]
    public void The_official_releases_repo_is_trusted(string feed)
    {
        Assert.Equal("https://github.com/pc30cc/webyar-desktop-releases", UpdateFeeds.TrustedGithubRepo(feed));
        Assert.True(UpdateFeeds.IsTrusted(feed, NoExtras));
    }

    [Theory]
    [InlineData("https://github.com/attacker/webyar-desktop-releases")]
    [InlineData("https://github.com/pc30cc/webyar-desktop-releases-evil")]
    [InlineData("https://github.com.evil.example/pc30cc/webyar-desktop-releases")]
    [InlineData("http://github.com/pc30cc/webyar-desktop-releases")]
    [InlineData("https://user@github.com/pc30cc/webyar-desktop-releases")]
    [InlineData("https://github.com:8443/pc30cc/webyar-desktop-releases")]
    [InlineData("https://updates.self-hosted.example/feed")]
    [InlineData("not a url")]
    public void Anything_else_is_not(string feed)
    {
        Assert.Null(UpdateFeeds.TrustedGithubRepo(feed));
        Assert.False(UpdateFeeds.IsTrusted(feed, NoExtras));
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
}
