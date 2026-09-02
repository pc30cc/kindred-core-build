/**
 * Legacy /team surface.
 *
 * Team members, departments and invitations all live on the canonical
 * Team & Departments settings page, which renders the single shared
 * InvitationManagement implementation. This module intentionally contains
 * no invitation logic of its own — a third invitation surface is forbidden.
 */
import { Navigate } from 'react-router-dom';

export default function TeamPage() {
  return <Navigate to="../settings/team-departments" replace />;
}
