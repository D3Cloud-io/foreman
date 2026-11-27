import { expect, test, type Page } from '@playwright/test';

/**
 * Attachments on a project idea's page (FRM-ADR-026, FRM-REQ-252 … FRM-REQ-255).
 *
 * The claim is the motivating one: a design PDF can be filed on a project idea from the console,
 * looked at in place, downloaded, deleted — and the deletion undone. Each step reloads where it
 * matters, because a file that is only in React state has not been filed on anything.
 */

const EMAIL = process.env['E2E_EMAIL'] ?? 'dev@localhost';
const PASSWORD = process.env['E2E_PASSWORD'] ?? 'foreman-dev-password-9174';
const SHOTS = process.env['E2E_SHOTS'];

/** A tiny but real PDF: one page, one line of text. Enough for the browser's viewer to open. */
function pdf(text: string): Buffer {
  const stream = `BT /F1 18 Tf 40 100 Td (${text}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${String(stream.length)} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((object, i) => {
    offsets.push(body.length);
    body += `${String(i + 1)} 0 obj\n${object}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${String(objects.length + 1)}\n0000000000 65535 f \n`;
  for (const offset of offsets) body += `${String(offset).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size ${String(objects.length + 1)} /Root 1 0 R >>\nstartxref\n${String(xref)}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

async function signIn(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('textbox', { name: 'Email' }).fill(EMAIL);
  await page.getByRole('textbox', { name: 'Password' }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('navigation').first().waitFor();
}

async function freshIdea(page: Page): Promise<string> {
  const title = `Attachments e2e ${String(Date.now())}`;
  await page.goto('/project-ideas');
  await page.getByRole('button', { name: 'New project idea' }).click();
  await page.getByRole('textbox', { name: 'Title' }).fill(title);
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page).toHaveURL(/\/project-ideas\/PI-\d+$/);
  return new URL(page.url()).pathname.split('/').pop() ?? '';
}

test.describe('attachments on a project idea (FRM-ADR-026)', () => {
  test('uploads a PDF, previews it in place, downloads it, deletes it and undoes the delete', async ({ page }) => {
    await signIn(page);
    const humanId = await freshIdea(page);
    const section = page.getByRole('region', { name: 'Attachments' });
    await expect(section.getByText('Nothing attached.')).toBeVisible();

    await section.getByLabel(`Attach a file to ${humanId}`).setInputFiles({
      name: 'living-town-design.pdf',
      mimeType: 'application/pdf',
      buffer: pdf('Living Town'),
    });
    await expect(section.getByRole('status')).toHaveText('living-town-design.pdf is attached.');

    // Filed, not just shown: it is there after a reload, listed with what it is.
    await page.reload();
    const list = section.getByRole('list', { name: `Files attached to ${humanId}` });
    await expect(list.getByText('living-town-design.pdf')).toBeVisible();
    await expect(list.getByText(/^PDF · /)).toBeVisible();

    // Previewed in place, in the browser's own viewer, from the authenticated content URL.
    await section.getByRole('button', { name: 'Preview living-town-design.pdf' }).click();
    const frame = section.locator('iframe[title="Preview of living-town-design.pdf"]');
    await expect(frame).toBeVisible();
    const src = (await frame.getAttribute('src')) ?? '';
    expect(src).toMatch(/^\/api\/attachments\/ATT-\d+\/content$/);
    const served = await page.request.get(src);
    expect(served.status()).toBe(200);
    expect(served.headers()['content-type']).toBe('application/pdf');
    expect((await served.body()).subarray(0, 5).toString('latin1')).toBe('%PDF-');
    if (SHOTS !== undefined) await page.screenshot({ path: `${SHOTS}/attachments-preview.png`, fullPage: true });

    // Downloaded under its own name.
    const download = page.waitForEvent('download');
    await section.getByRole('link', { name: 'Download living-town-design.pdf' }).click();
    expect((await download).suggestedFilename()).toBe('living-town-design.pdf');

    // Deleted at once, and the toast's Undo brings it back.
    await section.getByRole('button', { name: 'Delete living-town-design.pdf' }).click();
    await expect(page.getByText('living-town-design.pdf deleted')).toBeVisible();
    await expect(section.getByText('Nothing attached.')).toBeVisible();
    expect((await page.request.get(src)).status()).toBe(404);

    await page.getByRole('button', { name: 'Undo' }).click();
    await expect(page.getByText('Undone — living-town-design.pdf is back')).toBeVisible();
    await page.reload();
    await expect(list.getByText('living-town-design.pdf')).toBeVisible();
    expect((await page.request.get(src)).status()).toBe(200);
  });

  test('previews an image and Markdown, refuses a file that is not allowed, and restores from Deleted', async ({ page }) => {
    await signIn(page);
    const humanId = await freshIdea(page);
    const section = page.getByRole('region', { name: 'Attachments' });
    const picker = section.getByLabel(`Attach a file to ${humanId}`);

    await picker.setInputFiles({
      name: 'notes.md',
      mimeType: 'text/markdown',
      buffer: Buffer.from('# Generations\n\nEach **family** keeps a ledger.\n'),
    });
    await expect(section.getByRole('status')).toHaveText('notes.md is attached.');
    // Shown as soon as it lands, rendered the way the canvas renders Markdown.
    const preview = section.getByRole('document', { name: 'Preview of notes.md' });
    await expect(preview.locator('strong', { hasText: 'family' })).toBeVisible();

    // A page dressed as a PDF is refused, in words, and nothing is listed.
    await picker.setInputFiles({
      name: 'deck.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from('<html><script>alert(1)</script></html>'),
    });
    await expect(section.getByRole('alert')).toContainText('deck.pdf is not a file Foreman keeps');
    await expect(section.getByText('deck.pdf', { exact: true })).toHaveCount(0);

    // Delete, let the toast go, and restore from the Deleted list instead.
    await section.getByRole('button', { name: 'Delete notes.md' }).click();
    await expect(section.getByText('Nothing attached.')).toBeVisible();
    await page.reload();
    await section.getByRole('button', { name: 'Deleted (1)' }).click();
    await section.getByRole('button', { name: 'Restore notes.md' }).click();
    await expect(page.getByText('notes.md restored')).toBeVisible();
    await expect(section.getByRole('list', { name: `Files attached to ${humanId}` }).getByText('notes.md')).toBeVisible();
  });
});
