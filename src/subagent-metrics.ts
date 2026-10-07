import { readFileSync, readdirSync } from "node:fs";

/**
 * CPU ticks per second used by Linux `/proc` fields. The kernel default is 100 on every
 * architecture this service supports; a wrong value only scales the displayed percentage.
 */
export const PROCESS_CLOCK_TICKS_PER_SECOND = 100;

export interface ProcessTreeSample {
  /** Proportional set size in MiB for the service and its descendants. */
  pssMiB: number;
  /** Resident set size in MiB for the service and its descendants. */
  rssMiB: number;
  /** Total user plus system CPU ticks for the service and its descendants. */
  cpuTicks: number;
  /** Number of processes included in the sample. */
  processes: number;
}

function descendantPids(rootPid: number): number[] {
  const seen = new Set<number>([rootPid]);
  const pending = [rootPid];
  while (pending.length > 0) {
    const pid = pending.pop() as number;
    let tasks: string[];
    try {
      tasks = readdirSync(`/proc/${pid}/task`);
    } catch {
      continue;
    }
    for (const task of tasks) {
      let children: string;
      try {
        children = readFileSync(`/proc/${pid}/task/${task}/children`, "utf8");
      } catch {
        continue;
      }
      for (const value of children.split(/\s+/)) {
        const child = Number(value);
        if (child > 0 && !seen.has(child)) {
          seen.add(child);
          pending.push(child);
        }
      }
    }
  }
  return [...seen];
}

function statCpuTicks(pid: number): number {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  const suffix = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  return Number(suffix[11] ?? 0) + Number(suffix[12] ?? 0);
}

/** Reads PSS, RSS, CPU ticks, and process count for the service and its child processes. */
export function sampleProcessTree(rootPid: number = process.pid): ProcessTreeSample {
  let pssKiB = 0;
  let rssKiB = 0;
  let cpuTicks = 0;
  let processes = 0;
  for (const pid of descendantPids(rootPid)) {
    try {
      const smaps = readFileSync(`/proc/${pid}/smaps_rollup`, "utf8");
      pssKiB += Number(smaps.match(/^Pss:\s+(\d+)/m)?.[1] ?? 0);
      rssKiB += Number(smaps.match(/^Rss:\s+(\d+)/m)?.[1] ?? 0);
      cpuTicks += statCpuTicks(pid);
      processes += 1;
    } catch {
      continue;
    }
  }
  return { pssMiB: pssKiB / 1024, rssMiB: rssKiB / 1024, cpuTicks, processes };
}

/** Formats one header segment, for example `pss 236 MiB · cpu 41%`. */
export function formatMetrics(sample: ProcessTreeSample, cpuPercent: number | undefined): string {
  const cpu = cpuPercent === undefined ? "-" : `${cpuPercent.toFixed(0)}%`;
  return `pss ${sample.pssMiB.toFixed(0)} MiB · cpu ${cpu}`;
}

/** Turns two samples into process CPU percent, where 100% is one fully busy core. */
export function cpuPercentBetween(
  previous: ProcessTreeSample,
  current: ProcessTreeSample,
  elapsedMs: number,
): number | undefined {
  if (elapsedMs <= 0 || current.cpuTicks < previous.cpuTicks) return undefined;
  const ticks = current.cpuTicks - previous.cpuTicks;
  return (ticks / PROCESS_CLOCK_TICKS_PER_SECOND / (elapsedMs / 1000)) * 100;
}
