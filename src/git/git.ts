import { execFile } from 'child_process';

export class GitError extends Error {
  constructor(message: string, readonly stderr: string) {
    super(message);
  }
}

export function git(cwd: string, args: string[], maxBuffer = 64 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      { cwd, maxBuffer, windowsHide: true, encoding: 'utf8' },
      (err, stdout, stderr) => {
        if (err) {
          reject(new GitError(`git ${args.join(' ')} failed: ${err.message}`, String(stderr)));
        } else {
          resolve(String(stdout));
        }
      },
    );
  });
}

export async function tryGit(cwd: string, args: string[]): Promise<string | undefined> {
  try {
    return await git(cwd, args);
  } catch {
    return undefined;
  }
}
