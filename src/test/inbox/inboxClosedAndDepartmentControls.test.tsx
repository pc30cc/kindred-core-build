/**
 * The composer's notice on a closed conversation, and the list's department
 * filter control.
 *
 * An operator could type into a closed conversation without a word: the
 * visitor's answer then started a new conversation with no context. The
 * notice says so and reopens it; the list could not be narrowed to one
 * department at all.
 *
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ClosedConversationNotice } from '@/components/inbox/ClosedConversationNotice';
import { DepartmentFilter } from '@/components/inbox/DepartmentFilter';
import { NO_DEPARTMENT } from '@/lib/inboxDepartments';
import en from '@/i18n/locales/en';
import fa from '@/i18n/locales/fa';
import tr from '@/i18n/locales/tr';

afterEach(cleanup);
const t = (k: string) => k;

describe('a closed conversation\'s composer', () => {
  it('says the visitor cannot answer it here and offers to reopen it', () => {
    const onReopen = vi.fn();
    render(<ClosedConversationNotice onReopen={onReopen} pending={false} t={t} dir="ltr" />);
    expect(screen.getByText('inbox.closedComposerTitle')).toBeInTheDocument();
    expect(screen.getByText('inbox.closedComposerHint')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /inbox\.reopen/ }));
    expect(onReopen).toHaveBeenCalledTimes(1);
  });

  it('cannot be reopened twice at once', () => {
    render(<ClosedConversationNotice onReopen={() => {}} pending t={t} dir="rtl" />);
    expect((document.querySelector('[data-inbox="closed-reopen"]') as HTMLButtonElement).disabled).toBe(true);
  });

  it('is written in every language, with the action as a verb', () => {
    const inbox = (b: unknown) => (b as { inbox: Record<string, string> }).inbox;
    for (const [name, bundle] of Object.entries({ en, fa, tr })) {
      for (const key of ['closedComposerTitle', 'closedComposerHint', 'reopenAndSend', 'reopenFailed']) {
        expect(inbox(bundle)[key], `${name}.${key}`).toBeTruthy();
      }
    }
    expect(inbox(fa).reopen).toBe('باز کردن دوباره');
    expect(inbox(fa).resolve).toBe('حل کردن');
  });
});

describe('the department filter', () => {
  const options = [{ id: 'd-sales', name: 'Sales' }, { id: 'd-support', name: 'Support' }];

  it('is not drawn for a workspace without departments', () => {
    render(<DepartmentFilter options={[]} value={null} onChange={() => {}} t={t} dir="ltr" />);
    expect(document.querySelector('[data-inbox="department-filter"]')).toBeNull();
  });

  it('names what it narrows to', () => {
    const { rerender } = render(<DepartmentFilter options={options} value={null} onChange={() => {}} t={t} dir="ltr" />);
    const button = () => document.querySelector('[data-inbox="department-filter"]')!;
    expect(button().textContent).toBe('inbox.departmentAll');
    expect(button().getAttribute('data-active')).toBe('false');
    rerender(<DepartmentFilter options={options} value="d-support" onChange={() => {}} t={t} dir="ltr" />);
    expect(button().textContent).toBe('Support');
    expect(button().getAttribute('data-active')).toBe('true');
    rerender(<DepartmentFilter options={options} value={NO_DEPARTMENT} onChange={() => {}} t={t} dir="ltr" />);
    expect(button().textContent).toBe('inbox.departmentNone');
  });
});
