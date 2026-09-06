# Embedded demo traces

`traces.js` and `demo-manifest.json` are tracked in Git. The former contains the browser-ready trace excerpts; the latter records provenance, cycle ranges, event counts, and other extraction results. The original large logs are not included.

| Key | Source log, relative to the input root | Cycles | Execution |
| --- | --- | --- | --- |
| `branch-storm` | `gem5-traces/full-2iter/arm64/trace.log` | 73208–73335 | gem5 v25.1.0.1 / ARM64 O3; CoreMark, 2 iterations |
| `wide-open` | Same as above | 73388–73515 | Another excerpt from the same run |
| `memory-tide` | `rsd/mshr.log` | 3964–4091 | RSD / RISC-V; workload and simulator version not yet identified |
| `rename-rush` | `gem5-traces/detailed/arm64/trace.log` | 404–531 | gem5 v25.1.0.1 / ARM64 O3; CoreMark, 1 iteration |
| `x86-recovery` | `gem5-traces/detailed/x86/trace.log` | 1596–1723 | gem5 v25.1.0.1 / x86 O3; CoreMark, 1 iteration |

The detailed gem5 logs contain O3PipeView and O3CPUAll output, including recorded integer-register rename, read, write, and restore events. The first two demos primarily use O3PipeView; mappings and values absent from the log are displayed as unobserved.

The RSD trace was obtained from the RSD processor. `D$-miss`, MSHR, and `Br-pred-miss-ex` annotations identify cache misses and branch mispredictions. The original workload remains unidentified.

Each demo's `demo.provenance.evidence` retains relative paths to the source README and configuration files used to establish its execution conditions. Those original files are not embedded in the HTML. [generate-demos.ts](../scripts/generate-demos.ts) defines the excerpts, and [provenance.ts](../scripts/provenance.ts) provides the displayed provenance.

## Regeneration

This step is unnecessary for normal builds. Use it when the original logs are available and you want to change or regenerate the excerpts.

```sh
npm ci
# Place the four source logs under inputs/, using the relative paths above.
npm run demos:generate
npm test
npm run build
```

To use logs stored elsewhere, set their root explicitly:

```sh
SONATA_TRACE_ROOT=/path/to/trace-inputs npm run demos:generate
```

Large ARM64 and x86 logs are read up to the first 24 MiB. Run `npm run demos:select` to rank candidate excerpts; the report is written to `artifacts/trace-selection.json`. Missing candidate logs are recorded as errors in that report, while other candidates continue to be examined.

Top-down data is checked against slot counts from the pinned analysis modules. Observation times are included so playback does not anticipate a commit or squash before it occurs. Extraction also checks known events and consistency constraints.
