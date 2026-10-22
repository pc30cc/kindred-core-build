/**
 * Departments in the Inbox list: a conversation's department badge and the
 * list's department filter.
 *
 * A visitor who picked "Sales" in the widget used to land in one shared list
 * with nothing to tell them apart: the conversation carried no department the
 * Inbox showed, and nothing narrowed the list to one. The rows now carry
 * `department_id` / `department_name` (the conversation list's payload); a
 * row from a server that does not send them yet simply has no department.
 */
import type { InboxDepartment } from '@/lib/workspace-departments-api';

/** The filter value for conversations no department was chosen for. */
export const NO_DEPARTMENT = 'none';

export interface DepartmentRowFields {
  department_id?: string | null;
  department_name?: string | null;
}

/** Whether a row belongs in the list under this filter (null: every department). */
export function matchesDepartmentFilter(row: DepartmentRowFields, filter: string | null | undefined): boolean {
  if (!filter) return true;
  const id = row.department_id ?? null;
  return filter === NO_DEPARTMENT ? id === null : id === filter;
}

/** The department a row shows: its own name, else the directory's. */
export function departmentNameOf(
  row: DepartmentRowFields,
  byId: ReadonlyMap<string, string>,
): string | null {
  if (!row.department_id) return null;
  return row.department_name?.trim() || byId.get(row.department_id) || null;
}

export interface DepartmentOption {
  id: string;
  name: string;
}

/**
 * What the filter offers: every department of the workspace (in its order),
 * plus any a listed conversation carries that the directory does not know
 * (a department removed since, or a directory that could not be read).
 */
export function departmentFilterOptions(
  directory: readonly InboxDepartment[] | null | undefined,
  rows: readonly DepartmentRowFields[] | null | undefined,
): DepartmentOption[] {
  const out: DepartmentOption[] = [];
  const seen = new Set<string>();
  for (const d of directory ?? []) {
    if (!d?.id || seen.has(d.id)) continue;
    seen.add(d.id);
    out.push({ id: d.id, name: d.name });
  }
  for (const r of rows ?? []) {
    const id = r?.department_id;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, name: r.department_name?.trim() || id.slice(0, 8) });
  }
  return out;
}
