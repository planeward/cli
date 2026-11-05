import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Ignores everything in `.planeward/`, so it is never committed. */
export const STATE_DIR_GITIGNORE = "*\n";

/**
 * Creates `.planeward/` owner-only (0700) with a `.gitignore` of `*`. It
 * holds the signing key and secrets. Safe to call before every write.
 */
export async function ensureStateDir(stateDir: string): Promise<void> {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await chmod(stateDir, 0o700);
  try {
    await writeFile(join(stateDir, ".gitignore"), STATE_DIR_GITIGNORE, {
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}
