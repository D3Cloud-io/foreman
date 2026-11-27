import { describe, expect, it } from 'vitest';
import {
  AttachTarget,
  attachableTypeOf,
  cleanAttachmentName,
  DeleteInput,
  parseAnyId,
  ProjectCode,
  sniffAttachment,
  UpdateInput,
} from '../src/index.js';

/**
 * The shared half of attachments (FRM-ADR-026): what may come in, what it may be filed on, and the
 * IDs. Shared because the server decides with these and the stdio shim refuses with the same ones.
 */

const bytes = (text: string) => new TextEncoder().encode(text);

describe('sniffAttachment decides from the bytes (FRM-REQ-253)', () => {
  it('knows a PDF and each image by its signature, whatever the name says', () => {
    expect(sniffAttachment(bytes('%PDF-1.7 …'), 'notes.txt')).toBe('application/pdf');
    expect(sniffAttachment(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]), 'x')).toBe('image/png');
    expect(sniffAttachment(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]), 'x')).toBe('image/jpeg');
    expect(sniffAttachment(bytes('GIF89a…'), 'x')).toBe('image/gif');
    expect(sniffAttachment(bytes('RIFF\u0000\u0000\u0000\u0000WEBPVP8 '), 'x')).toBe('image/webp');
  });

  it('takes text only as valid UTF-8 without NUL, under a .md, .markdown or .txt name', () => {
    expect(sniffAttachment(bytes('# Heading'), 'design.MD')).toBe('text/markdown');
    expect(sniffAttachment(bytes('# Heading'), 'design.markdown')).toBe('text/markdown');
    expect(sniffAttachment(bytes('plain'), 'notes.txt')).toBe('text/plain');
    expect(sniffAttachment(bytes('<script>alert(1)</script>'), 'page.html')).toBeNull();
    expect(sniffAttachment(bytes('-----BEGIN OPENSSH PRIVATE KEY-----'), 'id_ed25519')).toBeNull();
    expect(sniffAttachment(Uint8Array.from([0x41, 0x00]), 'a.txt')).toBeNull();
    expect(sniffAttachment(Uint8Array.from([0xc3, 0x28]), 'a.md')).toBeNull();
  });

  it('refuses SVG, which is an image that runs script', () => {
    expect(sniffAttachment(bytes('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'logo.svg')).toBeNull();
  });
});

describe('names', () => {
  it('keeps the last path segment, without control characters', () => {
    expect(cleanAttachmentName('/Users/someone/Desktop/Living Town.pdf')).toBe('Living Town.pdf');
    expect(cleanAttachmentName('C:\\docs\\spec.pdf')).toBe('spec.pdf');
    expect(cleanAttachmentName('a\u0000b\nc.md')).toBe('abc.md');
    expect(cleanAttachmentName('/tmp/')).toBeNull();
    expect(cleanAttachmentName('..')).toBeNull();
  });

  it('shortens a long name before its extension', () => {
    const name = cleanAttachmentName(`${'x'.repeat(300)}.pdf`) ?? '';
    expect(name.length).toBeLessThanOrEqual(200);
    expect(name.endsWith('….pdf')).toBe(true);
  });
});

describe('what a file can be filed on', () => {
  it('is a project idea, a project, a phase, a task, a requirement or an ADR — nothing else', () => {
    expect(attachableTypeOf('PI-015')).toBe('project_idea');
    expect(attachableTypeOf('FRM')).toBe('project');
    expect(attachableTypeOf('FRM-P-12')).toBe('phase');
    expect(attachableTypeOf('FRM-T-4.2')).toBe('task');
    expect(attachableTypeOf('FRM-REQ-190')).toBe('requirement');
    expect(attachableTypeOf('FRM-ADR-020')).toBe('adr');
    for (const not of ['FRM-IDEA-001', 'FRM-CR-001', 'GL-001', 'GRP-001', 'ATT-001', 'nonsense']) {
      expect(AttachTarget.safeParse(not).success, not).toBe(false);
    }
  });
});

describe('ATT- IDs', () => {
  it('parse as their own codeless kind, and ATT can never be a project code', () => {
    expect(parseAnyId('ATT-012')).toEqual({ code: null, type: 'ATT', seq: '012' });
    expect(ProjectCode.safeParse('ATT').success).toBe(false);
  });

  it('are deletable over MCP, as what nothing cites (ADR-014, ADR-026)', () => {
    expect(DeleteInput.safeParse({ id: 'ATT-012' }).success).toBe(true);
    expect(DeleteInput.safeParse({ id: 'FRM-T-1.1' }).success).toBe(false);
  });
});

describe('foreman_update attach', () => {
  it('is taken by the attachable kinds, on its own', () => {
    expect(UpdateInput.safeParse({ id: 'PI-015', attach: '~/x.pdf' }).success).toBe(true);
    expect(UpdateInput.safeParse({ id: 'FRM', attach: '~/x.pdf' }).success).toBe(true);
    expect(UpdateInput.safeParse({ id: 'FRM-ADR-020', attach: '~/x.pdf' }).success).toBe(true);
    expect(UpdateInput.safeParse({ id: 'PI-015', attach: '~/x.pdf', text: 'also rename' }).success).toBe(false);
    expect(UpdateInput.safeParse({ id: 'FRM-CR-001', attach: '~/x.pdf' }).success).toBe(false);
  });
});
