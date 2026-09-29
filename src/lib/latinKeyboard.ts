/**
 * Browsers cannot switch the OS keyboard, so characters typed on a Persian
 * layout are mapped back to the key they sit on in a US QWERTY layout.
 * Used for email/password fields that must stay Latin.
 */
const MAP: Record<string, string> = {
  'ض': 'q', 'ص': 'w', 'ث': 'e', 'ق': 'r', 'ف': 't', 'غ': 'y', 'ع': 'u', 'ه': 'i', 'خ': 'o', 'ح': 'p', 'ج': '[', 'چ': ']',
  'ش': 'a', 'س': 's', 'ی': 'd', 'ي': 'd', 'ب': 'f', 'ل': 'g', 'ا': 'h', 'ت': 'j', 'ن': 'k', 'م': 'l', 'ک': ';', 'ك': ';', 'گ': "'",
  'ظ': 'z', 'ط': 'x', 'ز': 'c', 'ر': 'v', 'ذ': 'b', 'د': 'n', 'پ': 'm', 'و': ',', '.': '.', '/': '/',
  'ژ': 'C', 'آ': 'H', 'ئ': 'm', '؟': '?', '،': ',', '؛': ';', '«': '<', '»': '>', 'ـ': '_',
  '۰': '0', '۱': '1', '۲': '2', '۳': '3', '۴': '4', '۵': '5', '۶': '6', '۷': '7', '۸': '8', '۹': '9',
  '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4', '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9',
};

export function toLatinKeyboard(value: string): string {
  return value
    .replace(/[\u200B-\u200F\u061C\u202A-\u202E\u2066-\u2069\uFEFF]/g, '')
    // Anything outside ASCII, one UTF-16 unit at a time: the same set as
    // /[^\x00-\x7F]/, written without a control character in the pattern.
    .replace(/[\u0080-\uFFFF]/g, (c) => MAP[c] ?? '');
}
