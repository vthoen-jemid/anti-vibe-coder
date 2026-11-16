/**
 * Returns a scheduler that runs at most `concurrency` async jobs at a time.
 * Used to keep a refresh of hundreds of changed files from opening hundreds of
 * files at once.
 */
export function limit(concurrency: number): <T>(job: () => Promise<T>) => Promise<T> {
  let active = 0;
  const waiting: (() => void)[] = [];
  const next = () => {
    active--;
    waiting.shift()?.();
  };
  return <T>(job: () => Promise<T>) =>
    new Promise<T>((resolve, reject) => {
      const run = () => {
        active++;
        job().then(resolve, reject).finally(next);
      };
      if (active < concurrency) {
        run();
      } else {
        waiting.push(run);
      }
    });
}
