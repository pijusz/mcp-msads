import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:net";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const FILE_MODE = 0o600;
const LOCK_WAIT_MS = 5_000;
const LOCK_POLL_MS = 50;
const LOCK_HOST = "127.0.0.1";
const FIRST_DYNAMIC_PORT = 49_152;
const DYNAMIC_PORT_COUNT = 16_384;

export interface FileLockOptions {
  waitMs?: number;
  pollMs?: number;
}

export function recoveryPathFor(path: string): string {
  return `${path}.recovery`;
}

function syncDirectory(path: string): void {
  if (process.platform === "win32") return;
  const fd = openSync(path, constants.O_RDONLY);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function writeSynced(path: string, contents: string | Buffer): void {
  const fd = openSync(
    path,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
    FILE_MODE,
  );
  try {
    writeFileSync(fd, contents);
    fsyncSync(fd);
    closeSync(fd);
    chmodSync(path, FILE_MODE);
  } catch (error) {
    try {
      closeSync(fd);
    } catch {
      // Already closed.
    }
    try {
      unlinkSync(path);
    } catch {
      // Preserve the original write error.
    }
    throw error;
  }
}

/**
 * Replace a credential file atomically while keeping the previous bytes in a
 * permissioned recovery file until the rename is durable.
 */
export function writeSecureFile(path: string, contents: string | Buffer): void {
  const parent = dirname(path);
  const temp = join(parent, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  const recovery = recoveryPathFor(path);
  let tempExists = false;

  try {
    writeSynced(temp, contents);
    tempExists = true;

    if (existsSync(path)) {
      if (existsSync(recovery)) unlinkSync(recovery);
      writeSynced(recovery, readFileSync(path));
      syncDirectory(parent);
    }

    renameSync(temp, path);
    tempExists = false;
    chmodSync(path, FILE_MODE);

    // The temporary file data was synced before rename. Sync the renamed file
    // after chmod, then the directory entry, before discarding recovery bytes.
    const fd = openSync(path, constants.O_RDONLY);
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    syncDirectory(parent);

    if (existsSync(recovery)) {
      unlinkSync(recovery);
      syncDirectory(parent);
    }
  } catch (error) {
    if (tempExists && existsSync(temp)) unlinkSync(temp);
    throw error;
  }
}

/** Read the primary file, falling back to a durable interrupted-write copy. */
export function readSecureFile(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (primaryError) {
    try {
      return readFileSync(recoveryPathFor(path), "utf8");
    } catch {
      throw primaryError;
    }
  }
}

function canonicalCredentialPath(path: string): string {
  const absolutePath = resolve(path);
  try {
    return realpathSync.native(absolutePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return join(realpathSync.native(dirname(absolutePath)), basename(absolutePath));
  }
}

function lockPortFor(credentialPath: string): number {
  const hash = createHash("sha256")
    .update(canonicalCredentialPath(credentialPath))
    .digest();
  return FIRST_DYNAMIC_PORT + (hash.readUInt16BE(0) % DYNAMIC_PORT_COUNT);
}

function bindLockServer(port: number): Promise<Server> {
  return new Promise((resolveBinding, rejectBinding) => {
    const server = createServer((socket) => socket.destroy());
    server.once("error", rejectBinding);
    server.listen({ host: LOCK_HOST, port, exclusive: true }, () => {
      server.removeListener("error", rejectBinding);
      resolveBinding(server);
    });
  });
}

async function acquireLockServer(port: number, waitMs: number, pollMs: number) {
  const deadline = Date.now() + waitMs;
  while (true) {
    try {
      return await bindLockServer(port);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        throw new Error(
          `Timed out waiting for credential lock on ${LOCK_HOST}:${port}. ` +
            "Another credential refresh process or an unrelated local service may " +
            "own this credential path's deterministic lock port; acquisition fails closed.",
        );
      }
      await delay(Math.min(pollMs, remainingMs));
    }
  }
}

function closeLockServer(server: Server): Promise<void> {
  return new Promise((resolveClose, rejectClose) => {
    server.close((error) => {
      if (error) rejectClose(error);
      else resolveClose();
    });
  });
}

/** Serialize a token refresh by exclusively binding its deterministic loopback port. */
export async function withFileLock<T>(
  credentialPath: string,
  callback: () => Promise<T>,
  options: FileLockOptions = {},
): Promise<T> {
  const waitMs = Math.max(0, options.waitMs ?? LOCK_WAIT_MS);
  const pollMs = Math.max(1, options.pollMs ?? LOCK_POLL_MS);
  const server = await acquireLockServer(lockPortFor(credentialPath), waitMs, pollMs);

  try {
    return await callback();
  } finally {
    await closeLockServer(server);
  }
}
