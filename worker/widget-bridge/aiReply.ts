/** Only explicit responder labels count; never guess from speed or message prose. */
export function explicitAiResponder(label: unknown): string | undefined {
  if (typeof label !== 'string') return undefined;
  const normalized = label.replace(/[\u200c\u200e\u200f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
  return /^(?:هوش\s+مصنوعی(?:\s|$)|دستیار\s+هوش\s+مصنوعی(?:\s|$)|AI(?:\s+(?:assistant|agent|bot))?(?:\s|$)|artificial intelligence(?:\s|$)|yapay zek[aâ](?:\s|$))/i.test(normalized) ? normalized : undefined;
}
