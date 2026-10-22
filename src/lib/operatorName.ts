/**
 * What the Inbox calls an operator (finding I-10).
 *
 * An operator without a profile name used to be «پشتیبانی» ("Support") on
 * their bubbles, the part of their email before the @ in the conversation
 * list, and «شما» ("You") in a colleague's list preview when the server sent
 * no name. One rule now, for colleagues reading the Inbox: their profile
 * name; else the part of their email before the @ (how the list already
 * named them, and how teammates tell two unnamed operators apart); else the
 * word «اپراتور» / "Operator". "You" only for the reader's own messages.
 *
 * What the VISITOR reads is the server's (shared/systemMessages.ts
 * visitorDisplayName): never an email, the widget's own word otherwise.
 */
import { emailLocalPart } from '../../shared/contactName';
import { isPlaceholderName } from '../../shared/systemMessages';

type Translate = (key: string) => string;

/** A colleague as the Inbox knows them (the team directory). */
export interface KnownOperator {
  full_name?: string | null;
  email?: string | null;
}

function word(t: Translate, key: string, fallback: string): string {
  const text = t(key);
  return text && text !== key ? text : fallback;
}

/** A profile name that names someone: not blank, not an English stand-in ('An operator'). */
function realName(name: string | null | undefined): string | null {
  const trimmed = (name ?? '').trim();
  return trimmed && !isPlaceholderName(trimmed) ? trimmed : null;
}

/**
 * The operator who wrote a message, as their colleagues read it. `name` is
 * what the server sent with the row (a profile name, or for the list preview
 * already the email's local part); `known` is the team directory's entry.
 */
export function operatorDisplayName(
  sender: { name?: string | null; known?: KnownOperator | null },
  t: Translate,
): string {
  return realName(sender.name)
    ?? realName(sender.known?.full_name)
    ?? emailLocalPart(sender.known?.email)
    ?? word(t, 'inbox.operator', 'Operator');
}

/**
 * The "<who>: " of a list preview whose last message is an operator's: "You"
 * for the reader's own, the colleague otherwise — never "You" for someone
 * else whose name did not come.
 */
export function previewOperatorLabel(
  sender: { id?: string | null; name?: string | null; known?: KnownOperator | null },
  meId: string | null | undefined,
  t: Translate,
): string {
  if (sender.id && meId && sender.id === meId) return word(t, 'inbox.previewYou', 'You');
  return operatorDisplayName(sender, t);
}
