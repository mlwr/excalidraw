/**
 * Prometheus metrics (B7). Served on a port of their own (METRICS_PORT), so
 * they are reachable inside the cluster but not through the ingress.
 *
 * Kept small on purpose: no client library, only what operators need to see
 * whether the service is healthy (requests, errors, latency, connections,
 * database pool, background jobs, logins) and how it grows (users, scenes,
 * storage).
 */
import { createServer } from "node:http";
import { monitorEventLoopDelay } from "node:perf_hooks";

import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

type Labels = Record<string, string>;

const escapeLabel = (value: string) =>
  value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');

const labelText = (labels: Labels) => {
  const entries = Object.entries(labels);
  return entries.length
    ? `{${entries
        .map(([key, value]) => `${key}="${escapeLabel(value)}"`)
        .join(",")}}`
    : "";
};

const keyOf = (labels: Labels) => JSON.stringify(Object.entries(labels));

interface Family {
  render: () => Promise<string[]> | string[];
}

export const HTTP_BUCKETS = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
];

export const createMetrics = () => {
  const families: Family[] = [];
  const header = (name: string, help: string, type: string) => [
    `# HELP ${name} ${help}`,
    `# TYPE ${name} ${type}`,
  ];

  const counter = (name: string, help: string) => {
    const values = new Map<string, { labels: Labels; value: number }>();
    families.push({
      render: () => [
        ...header(name, help, "counter"),
        ...[...values.values()].map(
          (item) => `${name}${labelText(item.labels)} ${item.value}`,
        ),
      ],
    });
    return {
      inc: (labels: Labels = {}, by = 1) => {
        const key = keyOf(labels);
        const item = values.get(key);
        if (item) {
          item.value += by;
        } else {
          values.set(key, { labels, value: by });
        }
      },
    };
  };

  /** a gauge read when scraped */
  const gauge = (
    name: string,
    help: string,
    collect: () =>
      | Promise<[Labels, number][] | number | null>
      | [Labels, number][]
      | number
      | null,
  ) => {
    families.push({
      render: async () => {
        const value = await collect();
        if (value === null) {
          return [];
        }
        const samples: [Labels, number][] =
          typeof value === "number" ? [[{}, value]] : value;
        return [
          ...header(name, help, "gauge"),
          ...samples.map(
            ([labels, sample]) => `${name}${labelText(labels)} ${sample}`,
          ),
        ];
      },
    });
  };

  const histogram = (name: string, help: string, buckets: number[]) => {
    const values = new Map<
      string,
      { labels: Labels; counts: number[]; sum: number; count: number }
    >();
    families.push({
      render: () => {
        const lines = header(name, help, "histogram");
        for (const item of values.values()) {
          buckets.forEach((bucket, index) =>
            lines.push(
              `${name}_bucket${labelText({
                ...item.labels,
                le: String(bucket),
              })} ${item.counts[index]}`,
            ),
          );
          lines.push(
            `${name}_bucket${labelText({ ...item.labels, le: "+Inf" })} ${
              item.count
            }`,
            `${name}_sum${labelText(item.labels)} ${item.sum}`,
            `${name}_count${labelText(item.labels)} ${item.count}`,
          );
        }
        return lines;
      },
    });
    return {
      observe: (labels: Labels, value: number) => {
        const key = keyOf(labels);
        let item = values.get(key);
        if (!item) {
          item = { labels, counts: buckets.map(() => 0), sum: 0, count: 0 };
          values.set(key, item);
        }
        buckets.forEach((bucket, index) => {
          if (value <= bucket) {
            item!.counts[index]++;
          }
        });
        item.sum += value;
        item.count++;
      },
    };
  };

  // --- process ----------------------------------------------------------------------

  const loopDelay = monitorEventLoopDelay({ resolution: 20 });
  loopDelay.enable();
  const startedAt = Date.now() / 1000;
  gauge(
    "process_start_time_seconds",
    "Start time of the process (unix seconds).",
    () => startedAt,
  );
  gauge(
    "process_resident_memory_bytes",
    "Resident memory of the process.",
    () => process.memoryUsage().rss,
  );
  gauge(
    "nodejs_heap_used_bytes",
    "Used V8 heap.",
    () => process.memoryUsage().heapUsed,
  );
  gauge("process_cpu_seconds_total", "CPU time used by the process.", () => {
    const usage = process.cpuUsage();
    return (usage.user + usage.system) / 1e6;
  });
  gauge(
    "nodejs_eventloop_delay_p99_seconds",
    "99th percentile of the event loop delay since the last scrape.",
    () => {
      const value = loopDelay.percentile(99) / 1e9;
      loopDelay.reset();
      return Number.isFinite(value) ? value : 0;
    },
  );

  // --- application ------------------------------------------------------------------

  const httpDuration = histogram(
    "excalidraw_http_request_duration_seconds",
    "Duration of HTTP requests by route and status class.",
    HTTP_BUCKETS,
  );
  const events = counter(
    "excalidraw_events_total",
    "Recorded events (logins, denied logins, edits, shares, admin actions) by type.",
  );
  const jobRuns = counter(
    "excalidraw_job_runs_total",
    "Runs of background jobs on this pod by task and result.",
  );
  const jobLastSuccess = new Map<string, number>();
  gauge(
    "excalidraw_job_last_success_timestamp_seconds",
    "Last successful run of a background job on this pod (unix seconds).",
    () => [...jobLastSuccess].map(([task, at]) => [{ task }, at]),
  );

  const render = async () => {
    const parts: string[] = [];
    for (const family of families) {
      parts.push(...(await family.render()));
    }
    return `${parts.join("\n")}\n`;
  };

  let server: Server | null = null;

  return {
    counter,
    gauge,
    histogram,
    render,
    httpRequest: (
      method: string,
      route: string,
      status: number,
      seconds: number,
    ) =>
      httpDuration.observe(
        { method, route, status: `${Math.floor(status / 100)}xx` },
        seconds,
      ),
    event: (type: string) => events.inc({ type }),
    job: (name: string, ok: boolean) => {
      jobRuns.inc({ task: name, result: ok ? "ok" : "error" });
      if (ok) {
        jobLastSuccess.set(name, Date.now() / 1000);
      }
    },
    listen: (host: string, port: number) =>
      new Promise<number>((resolve, reject) => {
        server = createServer((request, response) => {
          if (
            request.method !== "GET" ||
            request.url?.split("?")[0] !== "/metrics"
          ) {
            response.writeHead(404).end();
            return;
          }
          render().then(
            (text) =>
              response
                .writeHead(200, {
                  "content-type": "text/plain; version=0.0.4; charset=utf-8",
                  "cache-control": "no-store",
                })
                .end(text),
            () => response.writeHead(500).end(),
          );
        });
        server.once("error", reject);
        server.listen(port, host, () =>
          resolve((server!.address() as AddressInfo).port),
        );
      }),
    close: () =>
      new Promise<void>((resolve) => {
        loopDelay.disable();
        if (!server) {
          resolve();
          return;
        }
        server.close(() => resolve());
      }),
  };
};

export type Metrics = ReturnType<typeof createMetrics>;
