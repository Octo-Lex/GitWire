// tests/unit/commentRouter.test.js
// Unit tests for comment command parsing

import { parseGitwireCommand, resolveCommandAction, buildCommandResponse } from '../../src/lib/commentRouter.js';

describe('parseGitwireCommand', () => {
  const ctx = { repo: 'o/r', issueNumber: 1, commentId: 10, authorAssociation: 'MEMBER', authorLogin: 'alice' };

  test('parses /gitwire status', () => {
    const result = parseGitwireCommand('/gitwire status', ctx);
    expect(result).toBeTruthy();
    expect(result.command).toBe('status');
  });

  test('parses /gitwire with args', () => {
    const result = parseGitwireCommand('/gitwire stale scan', ctx);
    expect(result.command).toBe('stale');
    expect(result.args).toEqual(['scan']);
  });

  test('parses /gitwire fix', () => {
    const result = parseGitwireCommand('/gitwire fix', ctx);
    expect(result.command).toBe('fix');
  });

  test('parses /gitwire settings stale 14', () => {
    const result = parseGitwireCommand('/gitwire settings stale 14', ctx);
    expect(result.command).toBe('settings');
    expect(result.args).toEqual(['stale', '14']);
  });

  test('no /gitwire prefix → null', () => {
    expect(parseGitwireCommand('just a comment', ctx)).toBeNull();
  });

  test('null body → null', () => {
    expect(parseGitwireCommand(null, ctx)).toBeNull();
  });

  // COLLABORATOR is a maintainer role in GitWire
  test('COLLABORATOR → allowed (is maintainer role)', () => {
    const nonCtx = { ...ctx, authorAssociation: 'COLLABORATOR' };
    expect(parseGitwireCommand('/gitwire status', nonCtx)).toBeTruthy();
  });

  test('non-maintainer → null (NONE)', () => {
    const nonCtx = { ...ctx, authorAssociation: 'NONE' };
    expect(parseGitwireCommand('/gitwire status', nonCtx)).toBeNull();
  });

  test('maintainer roles: OWNER, MEMBER', () => {
    expect(parseGitwireCommand('/gitwire status', { ...ctx, authorAssociation: 'OWNER' })).toBeTruthy();
    expect(parseGitwireCommand('/gitwire status', { ...ctx, authorAssociation: 'MEMBER' })).toBeTruthy();
  });

  test('/gitwire embedded in longer comment', () => {
    const result = parseGitwireCommand('Thanks for the PR.\n/gitwire fix\nPlease fix this.', ctx);
    expect(result.command).toBe('fix');
  });

  test('just /gitwire with no command → null result', () => {
    const result = parseGitwireCommand('/gitwire', ctx);
    // Returns null because command is null/undefined
    expect(result).toBeFalsy();
  });

  test('case sensitive — /Gitwire does not match', () => {
    expect(parseGitwireCommand('/Gitwire status', ctx)).toBeNull();
  });
});

describe('resolveCommandAction', () => {
  test('status → status action', () => {
    expect(resolveCommandAction({ command: 'status', args: [] })).toEqual({ action: 'status' });
  });

  test('stale scan → stale_scan', () => {
    expect(resolveCommandAction({ command: 'stale', args: ['scan'] })).toEqual({ action: 'stale_scan' });
  });

  test('stale without scan → null', () => {
    expect(resolveCommandAction({ command: 'stale', args: [] })).toBeNull();
  });

  test('clean branches → branch_cleanup', () => {
    expect(resolveCommandAction({ command: 'clean', args: ['branches'] })).toEqual({ action: 'branch_cleanup' });
  });

  test('fix → fix_issue', () => {
    expect(resolveCommandAction({ command: 'fix', args: [] })).toEqual({ action: 'fix_issue' });
  });

  test('stop → stop', () => {
    expect(resolveCommandAction({ command: 'stop', args: [] })).toEqual({ action: 'stop' });
  });

  test('settings stale 14 → set_stale_issue_days with value', () => {
    expect(resolveCommandAction({ command: 'settings', args: ['stale', '14'] })).toEqual({ action: 'set_stale_issue_days', value: 14 });
  });

  test('settings pr-stale 7 → set_stale_pr_days', () => {
    expect(resolveCommandAction({ command: 'settings', args: ['pr-stale', '7'] })).toEqual({ action: 'set_stale_pr_days', value: 7 });
  });

  test('settings with no args → show_settings', () => {
    expect(resolveCommandAction({ command: 'settings', args: [] })).toEqual({ action: 'show_settings' });
  });

  test('unknown command → null', () => {
    expect(resolveCommandAction({ command: 'explode', args: [] })).toBeNull();
  });

  test('null input → null', () => {
    expect(resolveCommandAction(null)).toBeNull();
  });
});

describe('buildCommandResponse', () => {
  test('status response includes repo count', () => {
    const msg = buildCommandResponse('status', { repoCount: 5, triagedCount: 10, healedCount: 3, staleActions: 1, enabled: true });
    expect(msg).toContain('Repos: 5');
    expect(msg).toContain('Issues triaged: 10');
    expect(msg).toContain('CI healed: 3');
    expect(msg).toContain('enabled');
  });

  test('stale_scan response confirms trigger', () => {
    const msg = buildCommandResponse('stale_scan', {});
    expect(msg).toContain('Stale scan triggered');
  });

  test('fix_issue response acknowledges', () => {
    const msg = buildCommandResponse('fix_issue', {});
    expect(msg).toContain('fix');
  });
});
