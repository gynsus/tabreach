import { writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { z } from 'zod';
import { MAX_SAVE_FILE_CHARS, type Logger, type SaveFileResult } from '@tabreach/protocol';

const requestSchema = z.object({
  suggestedName: z.string().min(1).max(200),
  content: z.string().max(MAX_SAVE_FILE_CHARS),
});

/** Keeps a plain file name: no directories, no control or path characters. */
export function safeFileName(name: string): string {
  const cleaned = basename(name)
    .replace(/[^\p{L}\p{N}._ -]/gu, '_')
    .replace(/^\.+/, '')
    .trim();
  return cleaned || 'export.csv';
}

/**
 * `tabreach:save-text-file`: the renderer cannot touch the filesystem, so exports go through
 * main, which shows the native save dialog and writes only where the user chose.
 */
export function registerSaveFile(isAllowedSender: (url: string) => boolean, logger: Logger): void {
  ipcMain.handle('tabreach:save-text-file', async (event, raw: unknown): Promise<SaveFileResult> => {
    const url = event.senderFrame?.url ?? '';
    if (!isAllowedSender(url)) {
      logger.warn({ event: 'ipc.rejected_sender', channel: 'save-text-file' }, 'rejected save request');
      throw new Error('Rejected');
    }
    const request = requestSchema.safeParse(raw);
    if (!request.success) throw new Error('Invalid save request');

    const name = safeFileName(request.data.suggestedName);
    const ext = extname(name).slice(1).toLowerCase();
    const options = {
      defaultPath: join(app.getPath('downloads'), name),
      filters: ext ? [{ name: ext.toUpperCase(), extensions: [ext] }] : [],
    };
    const window = BrowserWindow.fromWebContents(event.sender);
    const result = window
      ? await dialog.showSaveDialog(window, options)
      : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return { saved: false };

    await writeFile(result.filePath, request.data.content, 'utf8');
    logger.info({ event: 'file.saved', bytes: Buffer.byteLength(request.data.content) }, 'file saved');
    return { saved: true, path: result.filePath };
  });
}
