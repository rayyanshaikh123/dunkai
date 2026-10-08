import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

// The original PCB agent reads the Component Agent's CSV. A hosted snapshot
// contains BOM rows, not a usable file path on the next user's computer.
// Recreate that input locally without changing selection or PCB agent logic.
const COLUMNS = ['reference', 'subsystem', 'category', 'mfr_part', 'lcsc', 'package', 'build_quantity'];
const cell = (value) => '"' + String(value ?? '').replaceAll('"', '""') + '"';
export async function localizeSnapshot(payload, root = path.join(os.tmpdir(), 'dunkai-runtime-boms')) {
  const rows = payload.project?.bom?.rows;
  if (!Array.isArray(rows) || !rows.length || payload.action === 'code-chat') return { payload, cleanup: async () => {} };
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const filename = path.join(root, randomUUID() + '.csv');
  const csv = [COLUMNS.join(','), ...rows.map((row) => COLUMNS.map((column) => cell(row?.[column])).join(','))].join('\n') + '\n';
  await fs.writeFile(filename, csv, { mode: 0o600 });
  return { payload: { ...payload, project: { ...payload.project, bom_csv_path: filename } }, cleanup: () => fs.rm(filename, { force: true }) };
}
