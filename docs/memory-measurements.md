# Memory measurements

Measured on the user's Linux host with Node v26.8.1. These are local measurements, not production memory limits.

## Current desktop processes

Snapshot taken before the mock load:

| Group | RSS | PSS |
| --- | ---: | ---: |
| Four Pi sessions | 1,567 MiB | 1,337 MiB |
| React development processes | 2,962 MiB | 2,839 MiB |
| Browser processes | 3,311 MiB | 1,838 MiB |

The system reported 8.9 GiB used and 6.1 GiB available. The process groups do not include all system processes or kernel memory. Do not add RSS values to estimate physical memory use: shared pages can be counted more than once. PSS divides shared pages between processes.

## Shared MCP worker service

One Node process contained the real service, HTTP MCP server, installed Pi extensions, and a local mock model provider. Batches contained 1, 10, 20, 10, and 10 tasks, with a concurrency limit of 10. Each task used FFF search, hashline read/edit, and codemode, then produced approximately 64 KiB of mock text. Workspaces contained small temporary files. No paid model or search calls were made.

| State | RSS | PSS |
| --- | ---: | ---: |
| Cold service, no workers | 150 MiB | 104 MiB |
| One active worker, sampled peak | 272 MiB | 218 MiB |
| Ten active workers, peaks across three batches | 367–435 MiB | 313–381 MiB |
| Twenty tasks, at most ten active, sampled peak | 417 MiB | 363 MiB |
| End of final batch, ten sessions retained | 385 MiB | 331 MiB |
| All workers released, after test-only GC | 385 MiB | 331 MiB |

Kernel-recorded lifetime peak RSS was 439 MiB. The sampler ran every 100 ms and collected 198 samples; a sampled peak can miss brief allocations.

After the initial plugin load, live JavaScript heap after forced GC was approximately 81–82 MiB across the 10/20/10/10 batches. Array buffers returned to approximately 0.54 MiB. RSS did not return to the cold baseline. Loaded code, runtime caches, and allocator-held memory remain in the process. Stable JavaScript heap in this short test is not proof that no native or long-run memory leak exists.

The memory check exposed a missing extension shutdown event. The runtime now awaits `session_shutdown` before disposing a Pi session. A real SDK acceptance test checks that release waits for an asynchronous extension shutdown handler. The table above is from the run after that change.

Stopping the service process releases its process memory. No benchmark or mock provider processes were left running.

## Reproduce

```sh
bun run build
node --expose-gc scripts/measure-memory.mjs /tmp/pi-subagents-memory.json
```

This Linux-only check uses `/proc/self/smaps_rollup`. It needs the installed FFF, hashline, TinyFish, and codemode tools. TinyFish availability is checked without a search call. Forced GC is used only to distinguish live heap from reclaimable allocations; the service does not force GC during normal use.

Raw samples from the final run: `/tmp/pi-subagents-memory-fixed.json`.

Large repositories, long conversations, large tool results, and additional plugins can increase memory use. These results measure a small-workspace mock workload, not a full-context production run.

## Real DeepSeek and Muse run

Ten real workers (five per model) completed read-only source inspections in about 40 seconds. Each worker read the Ponytail skill through the real `read` tool; this was verified from the saved tool-result events. Supported thinking levels were accepted and unsupported DeepSeek `xhigh` and Muse `max` changes were rejected.

| State | RSS | PSS |
| --- | ---: | ---: |
| Service before real workers | 118 MiB | 72 MiB |
| Peak sampled during real work | 288 MiB | 233 MiB |
| Later observation after release | 223 MiB | 169 MiB |

The sampler included child processes; no additional child-process memory appeared in the sampled peak. No forced GC was used. These are separate observations from the mock run, not a controlled model-to-model comparison.

The automated follow-up stage failed because its inspection request used a limit of 1000; the MCP limit is 500. The script released its workers during error cleanup. All ten model tasks had already finished successfully. The script limit and skill verification were corrected afterward; the follow-up stage was not completed in this run. Raw data and results are in `/tmp/pi-subagents-real-memory.json`.

History checks: the SDK in-memory manager reported `isPersisted() === false` and no session file after appending messages. Pi's session listing contained 28 sessions and zero names beginning with `subagent:`. The runtime explicitly uses this in-memory manager. Service transcript logs remain under the service's separate transcript directory, not Pi's resume history.

## Real twenty-worker software run

The largest measurement was a real implementation workload: 20 concurrent workers (10 DeepSeek and 10 Muse) building a Go UCI chess engine in a separate repository. Each worker owned distinct files and ran real file, search, edit, and shell tools. A Python sampler read `/proc/<pid>/smaps_rollup` for the service and every descendant process every 0.5 seconds for 21 minutes.

| State | RSS | PSS |
| --- | ---: | ---: |
| Peak, service process | 532 MiB | 479 MiB |
| Peak, service plus child processes | 629 MiB | 563 MiB |
| Median during the run | 334 MiB | 281 MiB |
| After releasing 18 of 20 workers | 284 MiB | 230 MiB |

The process tree held at most 11 processes, so most of the peak came from the 20 worker sessions inside the one service process, not from child processes. Subtracting the roughly 118 MiB cold baseline leaves about 21 MiB per active session, including its conversation, tool results, and event buffer. This is an estimate from one workload, not a per-worker limit.

Completed workers were released during the run. React and browser processes on the same desktop used more memory than the service throughout.

The run also measured write volume: one worker produced 10,107 transcript events before the 500-event memory window rolled over. Under the previous default this meant about 10,000 small file appends for that worker alone. Transcripts now default to memory mode, which removes this I/O.

## Current defaults

Transcripts are memory only unless `"transcripts": "disk"` is set. The terminal header shows `pss` and `cpu` for the service and its child processes every five seconds. These are Linux-only measurements from `/proc`; on other platforms the header omits them.
