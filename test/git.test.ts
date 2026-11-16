import * as assert from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CatFile, CatFileParser, CatFileResult } from '../src/git/catFile';
import { orderBaseCandidates, Repo } from '../src/git/repo';
import { limit } from '../src/util/limit';

const OID = 'a'.repeat(40);

function feed(parser: CatFileParser, data: Buffer, chunkSize: number): CatFileResult[] {
  const out: CatFileResult[] = [];
  for (let i = 0; i < data.length; i += chunkSize) {
    out.push(...parser.push(data.subarray(i, i + chunkSize)));
  }
  return out;
}

describe('CatFileParser', () => {
  const body = Buffer.from('héllo\nwörld\n', 'utf8'); // multi-byte: byte length != char length
  const stream = Buffer.concat([
    Buffer.from(`${OID} blob ${body.length}\n`),
    body,
    Buffer.from('\n'),
    Buffer.from('HEAD:nope.txt missing\n'),
    Buffer.from(`${OID} tree 5\n`),
    Buffer.from([1, 2, 3, 0, 5]),
    Buffer.from('\n'),
    Buffer.from(`${OID} blob 0\n\n`),
  ]);

  for (const chunk of [1, 3, 7, stream.length]) {
    it(`parses responses split into ${chunk}-byte chunks`, () => {
      const r = feed(new CatFileParser(), stream, chunk);
      assert.strictEqual(r.length, 4);
      assert.strictEqual(r[0].kind, 'blob');
      assert.strictEqual(r[0].kind === 'blob' && r[0].content.toString('utf8'), 'héllo\nwörld\n');
      assert.deepStrictEqual(r[1], { kind: 'missing' });
      assert.deepStrictEqual(r[2], { kind: 'skipped', type: 'tree', size: 5 });
      assert.strictEqual(r[3].kind === 'blob' && r[3].content.length, 0);
    });
  }

  it('skips blobs over the size limit without keeping them', () => {
    const big = Buffer.alloc(100, 120);
    const data = Buffer.concat([Buffer.from(`${OID} blob 100\n`), big, Buffer.from('\nx missing\n')]);
    const r = feed(new CatFileParser(10), data, 16);
    assert.deepStrictEqual(r, [{ kind: 'skipped', type: 'blob', size: 100 }, { kind: 'missing' }]);
  });
});

describe('orderBaseCandidates', () => {
  it('puts origin/HEAD first and keeps the preference order', () => {
    const out = [
      'refs/heads/develop\0',
      'refs/heads/main\0',
      'refs/remotes/origin/HEAD\0refs/remotes/origin/main',
      'refs/remotes/origin/main\0',
    ].join('\n');
    assert.deepStrictEqual(orderBaseCandidates(out), ['origin/main', 'main', 'develop']);
  });

  it('returns nothing when no candidate exists', () => {
    assert.deepStrictEqual(orderBaseCandidates(''), []);
  });
});

describe('limit', () => {
  it('never runs more than n jobs at once', async () => {
    const run = limit(2);
    let active = 0;
    let peak = 0;
    const job = async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
    };
    await Promise.all(Array.from({ length: 10 }, () => run(job)));
    assert.strictEqual(peak, 2);
  });
});

// --------------------------------------------------------------- live git

function sh(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

describe('Repo + CatFile against a real repository', function () {
  this.timeout(30_000);
  let dir: string;

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'antivibe-test-'));
    sh(dir, 'init', '-q', '-b', 'main');
    sh(dir, 'config', 'user.email', 'test@example.invalid');
    sh(dir, 'config', 'user.name', 'test');
    sh(dir, 'config', 'core.autocrlf', 'false');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\n');
    fs.writeFileSync(path.join(dir, 'b.txt'), 'bee\n');
    fs.writeFileSync(path.join(dir, 'with space.txt'), 'spaced\n');
    fs.writeFileSync(path.join(dir, '.gitignore'), 'dist/\n');
    sh(dir, 'add', '-A');
    sh(dir, 'commit', '-q', '-m', 'base');
    sh(dir, 'checkout', '-q', '-b', 'feature');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'one\nTWO\n');
    sh(dir, 'commit', '-q', '-am', 'change a');
  });

  after(async () => {
    await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });

  it('reads blobs, missing files and paths with spaces through one process', async () => {
    const cat = new CatFile(dir);
    try {
      const [a, missing, spaced] = await Promise.all([cat.read('main:a.txt'), cat.read('main:nope.txt'), cat.read('main:with space.txt')]);
      assert.strictEqual(a.kind === 'blob' && a.content.toString(), 'one\ntwo\n');
      assert.strictEqual(missing.kind, 'missing');
      assert.strictEqual(spaced.kind === 'blob' && spaced.content.toString(), 'spaced\n');
    } finally {
      cat.dispose();
    }
  });

  it('rejects in-flight reads on dispose and refuses new ones', async () => {
    const cat = new CatFile(dir);
    const p = cat.read('main:a.txt');
    cat.dispose();
    await assert.rejects(p);
    await assert.rejects(cat.read('main:a.txt'));
  });

  it('refresh detects the base and reports added / removed files', async () => {
    const repo = new Repo(dir);
    try {
      let r = await repo.refresh(() => '');
      assert.ok(r.baseChanged);
      assert.strictEqual(repo.baseRef, 'main');
      assert.deepStrictEqual([...repo.changed], ['a.txt']);
      assert.deepStrictEqual(await repo.loadBase('a.txt'), ['one', 'two', '']);

      fs.writeFileSync(path.join(dir, 'new.txt'), 'fresh\n');
      r = await repo.refresh(() => '');
      assert.deepStrictEqual(r, { baseChanged: false, added: ['new.txt'], removed: [] });
      assert.strictEqual(await repo.loadBase('new.txt'), null); // untracked: no base

      fs.rmSync(path.join(dir, 'new.txt'));
      r = await repo.refresh(() => '');
      assert.deepStrictEqual(r, { baseChanged: false, added: [], removed: ['new.txt'] });

      r = await repo.refresh(() => 'feature');
      assert.ok(r.baseChanged, 'switching the base is a base change');
      assert.strictEqual(repo.changed.size, 0);
    } finally {
      repo.dispose();
    }
  });

  it('reports which paths git ignores', async () => {
    const repo = new Repo(dir);
    try {
      assert.deepStrictEqual([...(await repo.ignored(['dist/x.js', 'src/y.ts']))!], ['dist/x.js']);
      assert.deepStrictEqual([...(await repo.ignored(['src/y.ts']))!], []);
    } finally {
      repo.dispose();
    }
  });
});
