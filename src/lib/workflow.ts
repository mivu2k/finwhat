// Thread status machine + role permissions.
// MUST stay in sync with public.transition_thread() in supabase/migrations/0001_init.sql —
// the server is the source of truth; this copy only drives which buttons the UI shows.

export type Role = 'owner' | 'approver' | 'member' | 'viewer';
export type Status =
  | 'draft' | 'submitted' | 'under_review' | 'approved' | 'rejected'
  | 'needs_info' | 'unpaid' | 'paid' | 'closed';

// who: 'author' = thread creator (any non-viewer); 'approver' = approver or owner.
type Who = 'author' | 'approver';
type Rule = { from: Status[]; to: Status; who: Who[]; reasonRequired?: boolean };

export const TRANSITIONS: Rule[] = [
  { from: ['draft', 'needs_info', 'rejected'], to: 'submitted', who: ['author', 'approver'] },
  { from: ['submitted'], to: 'under_review', who: ['approver'] },
  { from: ['submitted', 'under_review'], to: 'approved', who: ['approver'] },
  { from: ['submitted', 'under_review'], to: 'rejected', who: ['approver'] },
  { from: ['submitted', 'under_review'], to: 'needs_info', who: ['approver'] },
  { from: ['approved'], to: 'unpaid', who: ['approver'] },
  { from: ['approved', 'unpaid'], to: 'paid', who: ['approver'] },
  { from: ['approved', 'unpaid', 'paid', 'rejected'], to: 'closed', who: ['approver'] },
  { from: ['closed'], to: 'under_review', who: ['approver'], reasonRequired: true }, // reopen
];

export const LABEL: Record<Status, string> = {
  draft: 'Draft', submitted: 'Submitted', under_review: 'Under review', approved: 'Approved',
  rejected: 'Rejected', needs_info: 'Needs info', unpaid: 'Unpaid', paid: 'Paid', closed: 'Closed',
};

export const isApprover = (r: Role | null) => r === 'owner' || r === 'approver';

/** Statuses the given user may move the thread to. */
export function allowedTransitions(from: Status, role: Role | null, isAuthor: boolean): Rule[] {
  if (!role || role === 'viewer') return [];
  return TRANSITIONS.filter(t =>
    t.from.includes(from) &&
    ((t.who.includes('approver') && isApprover(role)) || (t.who.includes('author') && isAuthor)));
}

export function canTransition(from: Status, to: Status, role: Role | null, isAuthor: boolean, reason?: string) {
  const rule = allowedTransitions(from, role, isAuthor).find(t => t.to === to);
  return !!rule && (!rule.reasonRequired || !!reason?.trim());
}

/** Financial fields are editable by the author before approval, by approvers until closed. */
export function canEditFields(status: Status, role: Role | null, isAuthor: boolean) {
  if (status === 'closed' || !role || role === 'viewer') return false;
  if (isApprover(role)) return true;
  return isAuthor && ['draft', 'submitted', 'needs_info', 'rejected'].includes(status);
}

export const canComment = (role: Role | null) => !!role && role !== 'viewer';
