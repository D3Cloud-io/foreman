import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ToastRegion } from '@d3cloud/ui';
import { channelOf, HistoryDrawer, verdictLine, whoOf } from './HistoryDrawer';
import { StatusControl, statusMessage } from '../screens/StatusControl';
import { savedMessage } from '../screens/EditForms';
import { revokeConsequence } from '../screens/Tokens';
import { patchLabels } from '../screens/ProjectIdeaDetail';

/** FRM-T-18.4: the History drawer, the status control, and the words the undo flow uses. */

describe('the History drawer', () => {
  it('is a History button until it is opened', () => {
    const html = renderToStaticMarkup(
      <ToastRegion>
        <HistoryDrawer entity="BND-T-9.4" />
      </ToastRegion>,
    );
    expect(html).toContain('>History<');
    // Closed, it fetches nothing and renders no dialog.
    expect(html).not.toContain('role="dialog"');
  });

  it('sorts actors into the filter’s three kinds, and says where each change came from', () => {
    expect(whoOf('user')).toBe('people');
    expect(whoOf('mcp')).toBe('agents');
    expect(whoOf('system')).toBe('system');
    expect(whoOf('importer')).toBe('system');
    expect(channelOf('mcp')).toBe('MCP');
    expect(channelOf('user')).toBe('console');
    expect(channelOf('system')).toBe('server');
  });

  it('says why an event cannot be undone before anyone presses anything', () => {
    expect(verdictLine({ undoable: true, action: 'update' })).toBeNull();
    expect(
      verdictLine({ undoable: false, action: 'update', reason: 'that change cannot be undone: title has changed since' }),
    ).toBe('Cannot be undone here: that change cannot be undone: title has changed since');
    expect(verdictLine({ undoable: null, action: 'update', reason: 'not checked — open the event to check' })).toBe(
      'not checked — open the event to check',
    );
    expect(verdictLine({ undoable: false, action: 'undo', reason: 'x' })).toMatch(/Undo the change it reversed/);
  });
});

describe('the status control', () => {
  it('is a labelled select, with nothing pending', () => {
    const html = renderToStaticMarkup(
      <ToastRegion>
        <StatusControl
          task={{ humanId: 'BND-T-9.4', status: 'in_progress', blockedReason: null }}
          code="BND"
          onChanged={() => undefined}
        />
      </ToastRegion>,
    );
    expect(html).toContain('aria-label="Status of BND-T-9.4"');
    // Not waiting on anything, so no spinner and not busy. (Radix fills the value in on the client.)
    expect(html).toContain('aria-busy="false"');
    expect(html).not.toContain('Saving the status');
  });

  it('names the change the way the toast reads', () => {
    expect(statusMessage('BND-T-9.4', 'done')).toBe('BND-T-9.4 marked done');
    expect(statusMessage('BND-T-9.4', 'in_progress')).toBe('BND-T-9.4 marked in progress');
  });
});

describe('the words around a write', () => {
  it('names what a form saved', () => {
    expect(savedMessage('BND-T-9.4', ['Title', 'Size'])).toBe('Saved BND-T-9.4 — title and size');
    expect(savedMessage('BND-REQ-012', [])).toBe('Saved BND-REQ-012');
  });

  it('says what a revoke stops, and that it cannot be undone', () => {
    expect(revokeConsequence('frm_ab12')).toBe(
      'Agents using frm_ab12… stop working at once. This cannot be undone.',
    );
  });

  it('names a project idea’s patch in the canvas’s words', () => {
    expect(patchLabels({ pitch: 'x', tags: [] })).toEqual(['the pitch', 'tags']);
    expect(patchLabels({ problem: 'x' })).toEqual(['the problem']);
  });
});
