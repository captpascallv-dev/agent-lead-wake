import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

function syncDirectory(directory) {
  // Windows may not allow directory fsync. File contents are fsynced before rename.
  let descriptor;
  try {
    descriptor = fs.openSync(directory, 'r');
    fs.fsyncSync(descriptor);
  } catch (error) {
    if (!['EINVAL', 'EPERM', 'EISDIR', 'EACCES'].includes(error.code)) throw error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

export function writeJsonAtomic(filename, value) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${randomUUID()}.tmp`;
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, filename);
    syncDirectory(path.dirname(filename));
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

export function createJsonOnce(filename, value) {
  return createFileOnce(filename, `${JSON.stringify(value, null, 2)}\n`);
}

export function createFileOnce(filename, content) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${randomUUID()}.tmp`;
  let descriptor;
  try {
    // Publish a COMPLETE fsynced file exclusively. A crash before link leaves only
    // an unreferenced temporary file; the final event can be rescanned safely.
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, content, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.linkSync(temporary, filename);
    fs.unlinkSync(temporary);
    syncDirectory(path.dirname(filename));
    return true;
  } catch (error) {
    if (error.code === 'EEXIST') return false;
    throw error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

export function readJson(filename) {
  try { return JSON.parse(fs.readFileSync(filename, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    // Malformed or unreadable published state is visible and fails closed.
    return { _unreadable: true, error: error.message };
  }
}
