/** Test stub standing in for the embedding provider; mocked in the suite. */
export async function embedTexts(
  _texts: string[],
  _opts?: { runCtx?: unknown },
): Promise<{ vectors: number[][] }> {
  return { vectors: [] };
}
