import { execFile } from 'child_process';

export class GitError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
    /** Process exit code, when git ran and failed (e.g. 1 for "nothing found" in some commands). */
    readonly code: number | undefined,
  ) {
    super(message);
  }
}

/**
 * Runs `git <args>` in `cwd` and resolves with stdout. Rejects with a
 * {@link GitError} on a non-zero exit, a spawn failure or when the output
 * exceeds `maxBuffer` bytes. `input`, if given, is written to stdin.
 */
export function git(cwd: string, args: string[], maxBuffer = 64 * 1024 * 1024, input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      args,
      { cwd, maxBuffer, windowsHide: true, encoding: 'utf8' },
      (err, stdout, stderr) => {
        if (err) {
          const code = typeof err.code === 'number' ? err.code : undefined;
          reject(new GitError(`git ${args.join(' ')} failed: ${err.message}`, String(stderr), code));
        } else {
          resolve(String(stdout));
        }
      },
    );
    if (input !== undefined) {
      child.stdin?.on('error', () => undefined); // reported through the exit callback
      child.stdin?.end(input);
    }
  });
}

/** Like {@link git}, but resolves with undefined instead of rejecting. */
export async function tryGit(cwd: string, args: string[]): Promise<string | undefined> {
  try {
    return await git(cwd, args);
  } catch {
    return undefined;
  }
}
