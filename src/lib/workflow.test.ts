import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canTransition, canEditFields, allowedTransitions, canComment } from './workflow.ts';

test('member submits own draft, cannot approve', () => {
  assert.ok(canTransition('draft', 'submitted', 'member', true));
  assert.ok(!canTransition('draft', 'submitted', 'member', false));
  assert.ok(!canTransition('submitted', 'approved', 'member', true));
});

test('approver/owner run the review + payment path', () => {
  for (const r of ['approver', 'owner'] as const) {
    assert.ok(canTransition('submitted', 'approved', r, false));
    assert.ok(canTransition('approved', 'unpaid', r, false));
    assert.ok(canTransition('unpaid', 'paid', r, false));
    assert.ok(canTransition('paid', 'closed', r, false));
  }
});

test('illegal jumps rejected', () => {
  assert.ok(!canTransition('draft', 'paid', 'owner', true));
  assert.ok(!canTransition('closed', 'paid', 'owner', true));
  assert.ok(!canTransition('rejected', 'approved', 'owner', true));
});

test('reopen requires approver and a reason', () => {
  assert.ok(!canTransition('closed', 'under_review', 'owner', false));
  assert.ok(!canTransition('closed', 'under_review', 'owner', false, '  '));
  assert.ok(canTransition('closed', 'under_review', 'owner', false, 'wrong amount'));
  assert.ok(!canTransition('closed', 'under_review', 'member', true, 'x'));
});

test('viewer can do nothing', () => {
  assert.deepEqual(allowedTransitions('draft', 'viewer', true), []);
  assert.ok(!canComment('viewer'));
  assert.ok(!canEditFields('draft', 'viewer', true));
});

test('field locking', () => {
  assert.ok(canEditFields('needs_info', 'member', true));
  assert.ok(!canEditFields('approved', 'member', true));
  assert.ok(!canEditFields('submitted', 'member', false));
  assert.ok(canEditFields('paid', 'approver', false));
  assert.ok(!canEditFields('closed', 'owner', true));
});
