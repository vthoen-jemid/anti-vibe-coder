import { ChildProcessWithoutNullStreams, spawn } from 'child_process';

/** One response of `git cat-file --batch`. */
export type CatFileResult =
  | { kind: 'blob'; content: Buffer }
  /** The object exists but is not a blob (e.g. a directory), or is larger than the limit. */
  | { kind: 'skipped'; type: string; size: number }
  /** `<rev>:<path>` does not name an object (file absent at that commit) or is ambiguous. */
  | { kind: 'missing' };

const LF = 0x0a;

/**
 * Incremental parser for `git cat-file --batch` output:
 *
 *     <oid> <type> <size>LF<size bytes>LF
 *     <object> missingLF
 *
 * Sizes are in bytes, so the body is handled as a Buffer. Bodies larger than
 * `maxBytes` are skipped without being kept in memory.
 */
export class CatFileParser {
  private header: Buffer[] = [];
  private body: Buffer | undefined;
  private bodyType = '';
  private bodySize = 0;
  private filled = 0;
  /** Bytes still to consume: body (if being kept or skipped) plus the trailing LF. */
  private remaining = -1;

  constructor(private readonly maxBytes = Infinity) {}

  /** Feeds a chunk of stdout and returns the responses it completed, in order. */
  push(chunk: Buffer): CatFileResult[] {
    const out: CatFileResult[] = [];
    let pos = 0;
    while (pos < chunk.length) {
      if (this.remaining < 0) {
        // Reading a header line.
        const nl = chunk.indexOf(LF, pos);
        if (nl < 0) {
          this.header.push(chunk.subarray(pos));
          break;
        }
        this.header.push(chunk.subarray(pos, nl));
        pos = nl + 1;
        const line = Buffer.concat(this.header).toString('utf8');
        this.header = [];
        const result = this.startBody(line);
        if (result) {
          out.push(result);
        }
        continue;
      }
      // Reading (or skipping) a body, then its trailing LF.
      const take = Math.min(this.remaining, chunk.length - pos);
      if (this.body) {
        const bodyLeft = this.bodySize - this.filled;
        const copy = Math.min(take, bodyLeft);
        chunk.copy(this.body, this.filled, pos, pos + copy);
        this.filled += copy;
      }
      pos += take;
      this.remaining -= take;
      if (this.remaining === 0) {
        out.push(
          this.body
            ? { kind: 'blob', content: this.body }
            : { kind: 'skipped', type: this.bodyType, size: this.bodySize },
        );
        this.body = undefined;
        this.remaining = -1;
      }
    }
    return out;
  }

  private startBody(line: string): CatFileResult | undefined {
    const parts = line.split(' ');
    const last = parts[parts.length - 1];
    if (last === 'missing' || last === 'ambiguous' || parts.length < 3) {
      return { kind: 'missing' };
    }
    const size = Number(last);
    const type = parts[parts.length - 2];
    if (!Number.isFinite(size) || size < 0) {
      throw new Error(`unexpected cat-file header: ${line}`);
    }
    this.bodyType = type;
    this.bodySize = size;
    this.filled = 0;
    this.body = type === 'blob' && size <= this.maxBytes ? Buffer.allocUnsafe(size) : undefined;
    this.remaining = size + 1; // + trailing LF
    return undefined;
  }
}

interface Pending {
  resolve: (r: CatFileResult) => void;
  reject: (e: Error) => void;
}

/**
 * A long-lived `git cat-file --batch` process for one repository.
 *
 * Reading N files at a commit with `git show` costs N process spawns (tens of
 * milliseconds each on Windows); this pipes all requests through a single
 * process instead. The process starts on first use, exits after `idleMs`
 * without requests, and is restarted transparently after a crash. Requests
 * that fail (spawn error, crash) are rejected so callers can fall back to
 * `git show`.
 */
export class CatFile {
  private proc: ChildProcessWithoutNullStreams | undefined;
  private queue: Pending[] = [];
  private idleTimer: NodeJS.Timeout | undefined;
  private disposed = false;

  constructor(
    private readonly cwd: string,
    private readonly maxBytes = Infinity,
    private readonly idleMs = 60_000,
  ) {}

  /** Whether `spec` can be sent on one input line. */
  static canRead(spec: string): boolean {
    return !/[\r\n]/.test(spec);
  }

  /** Reads `<rev>:<path>` (or any object name). */
  read(spec: string): Promise<CatFileResult> {
    if (this.disposed) {
      return Promise.reject(new Error('cat-file disposed'));
    }
    if (!CatFile.canRead(spec)) {
      return Promise.reject(new Error('object name contains a line break'));
    }
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
    const proc = this.proc ?? this.start();
    return new Promise((resolve, reject) => {
      this.queue.push({ resolve, reject });
      proc.stdin.write(spec + '\n');
    });
  }

  private start(): ChildProcessWithoutNullStreams {
    const proc = spawn('git', ['cat-file', '--batch'], { cwd: this.cwd, windowsHide: true });
    const parser = new CatFileParser(this.maxBytes);
    this.proc = proc;
    proc.stdout.on('data', (chunk: Buffer) => {
      if (this.proc !== proc) {
        return; // output of a process that was already stopped or failed
      }
      let results: CatFileResult[];
      try {
        results = parser.push(chunk);
      } catch (e) {
        this.fail(proc, e instanceof Error ? e : new Error(String(e)));
        return;
      }
      for (const r of results) {
        this.queue.shift()?.resolve(r);
      }
      if (this.queue.length === 0 && this.proc === proc) {
        this.scheduleIdle();
      }
    });
    proc.stderr.resume(); // never let stderr fill up and block the process
    proc.stdin.on('error', (e) => this.fail(proc, e));
    proc.on('error', (e) => this.fail(proc, e));
    proc.on('exit', (code) => this.fail(proc, new Error(`git cat-file exited with code ${code}`)));
    return proc;
  }

  private scheduleIdle(): void {
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      if (this.queue.length === 0) {
        this.stop();
      }
    }, this.idleMs);
    this.idleTimer.unref?.();
  }

  /** Rejects everything in flight for `proc` and forgets it; the next read starts a new process. */
  private fail(proc: ChildProcessWithoutNullStreams, err: Error): void {
    if (this.proc !== proc) {
      return;
    }
    this.proc = undefined;
    const pending = this.queue;
    this.queue = [];
    pending.forEach((p) => p.reject(err));
    shutdown(proc);
  }

  private stop(): void {
    const proc = this.proc;
    if (!proc) {
      return;
    }
    this.proc = undefined;
    shutdown(proc);
  }

  dispose(): void {
    this.disposed = true;
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
    const proc = this.proc;
    if (proc) {
      this.fail(proc, new Error('cat-file disposed'));
    }
  }
}

/**
 * Ends a cat-file process. Closing stdin lets git exit by itself (EOF), which
 * also works when `git` is a launcher that started the real git as a child
 * (Git for Windows); a kill is only the fallback for a process that hangs.
 */
function shutdown(proc: ChildProcessWithoutNullStreams): void {
  if (proc.exitCode !== null || proc.signalCode !== null) {
    return;
  }
  proc.stdin.end();
  const timer = setTimeout(() => proc.kill(), 2000);
  timer.unref?.();
  proc.once('exit', () => clearTimeout(timer));
}
