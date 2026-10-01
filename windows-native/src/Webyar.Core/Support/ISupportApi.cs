namespace Webyar.Core.Support;

/// <summary>The endpoints the support chat uses; <see cref="Api.WebyarApi"/> answers them over HTTP.</summary>
public interface ISupportApi
{
    Task<SupportStatus> StatusAsync(CancellationToken ct = default);
    Task<SupportHistory> HistoryAsync(CancellationToken ct = default);
    Task<SupportPostResult> SendMessageAsync(string body, string clientMessageId, string? conversationId, string? workspaceId, CancellationToken ct = default);
    Task<SupportPostResult> SendAttachmentAsync(string fileName, string mimeType, byte[] data, string clientMessageId, string? conversationId, string? workspaceId, CancellationToken ct = default);
    Task<SupportConversation> RateAsync(string conversationId, int score, string? comment, CancellationToken ct = default);
    Task MarkReadAsync(CancellationToken ct = default);
}
