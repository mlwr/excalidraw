/**
 * Background jobs (deletion periods, search index, session cleanup). With
 * several pods each job runs on one of them at a time: a PostgreSQL
 * advisory lock decides.
 */
import type { FastifyBaseLogger } from "fastify";
import type pg from "pg";

export interface Job {
  name: string;
  everyMs: number;
  run: () => Promise<unknown>;
}

// first of the two advisory lock keys: "excalidraw jobs"
const LOCK_NAMESPACE = 72_207;

const lockKey = (name: string) => {
  let hash = 0;
  for (const char of name) {
    hash = (hash * 31 + char.charCodeAt(0)) | 0;
  }
  return hash;
};

export const startJobs = (
  pool: pg.Pool,
  log: FastifyBaseLogger,
  jobs: Job[],
  /** each finished run, for the metrics */
  onFinish: (name: string, ok: boolean) => void = () => {},
) => {
  const running = new Set<string>();

  const runOnce = async (job: Job) => {
    if (running.has(job.name)) {
      return;
    }
    running.add(job.name);
    const client = await pool.connect();
    try {
      const { rows } = await client.query(
        "select pg_try_advisory_lock($1, $2) as locked",
        [LOCK_NAMESPACE, lockKey(job.name)],
      );
      if (!rows[0]?.locked) {
        return; // another pod runs it right now
      }
      try {
        await job.run();
        onFinish(job.name, true);
      } catch (error) {
        onFinish(job.name, false);
        throw error;
      } finally {
        await client.query("select pg_advisory_unlock($1, $2)", [
          LOCK_NAMESPACE,
          lockKey(job.name),
        ]);
      }
    } catch (error) {
      log.warn({ err: error, job: job.name }, "background job failed");
    } finally {
      client.release();
      running.delete(job.name);
    }
  };

  const timers = jobs.map((job) => {
    // spread the first runs, so not every job starts with the server
    const first = setTimeout(
      () => void runOnce(job),
      Math.min(job.everyMs, 5000 + Math.random() * 10000),
    );
    first.unref();
    const timer = setInterval(() => void runOnce(job), job.everyMs);
    timer.unref();
    return [first, timer];
  });

  return {
    /** run a job now (tests, admin action) */
    run: (name: string) => {
      const job = jobs.find((candidate) => candidate.name === name);
      return job ? runOnce(job) : Promise.resolve();
    },
    stop: () => timers.flat().forEach((timer) => clearTimeout(timer)),
  };
};
