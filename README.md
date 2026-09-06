# Sonata

**[▶ Live demo](https://shioyadan.github.io/sonata/)**

**Processor traces in motion.**

Sonata is a WebGL visualizer for processor execution traces. Follow instructions through the frontend, dependency matrix, register renaming, physical registers, execution pipes, reorder buffer, and commit. Watch cache misses stall work and branch mispredictions unwind the pipeline.

![Sonata pipeline view](docs/images/overview.png)

## Run

Use **Node.js 22.12 or later**. Building and serving the app use only Node's standard library; no dependency installation is required.

```sh
git clone https://github.com/shioyadan/sonata.git
cd sonata
npm run build
```

Open **`dist/sonata.html`** in a browser with WebGL 2 support. This single HTML file contains the application, styles, and all five demos. You can copy it elsewhere and use it offline.

For a local HTTP server, run `npm start` and open `http://127.0.0.1:4173`. Restart the server after editing the source.

## Controls

| Input | Action |
| --- | --- |
| Drag / one finger | Orbit the camera |
| Mouse wheel / pinch | Zoom |
| Move two fingers together | Pan |
| Fit / double-click | Reset the camera |
| Space / left and right arrows | Play or pause / step one cycle |
| F / C | Jump to the next flush / toggle Cinema |
| Click an instruction particle | Follow that instruction |

On phones, playback and seeking stay on screen. Open **Demo & settings** to change demos or display settings. Portrait and landscape layouts are supported. The app respects the OS reduced-motion preference and offers an explicit control to enable animation.

## Demos

| Demo | Simulator / processor | Workload and highlights |
| --- | --- | --- |
| Branch storm | gem5 ARM64 O3 | CoreMark; repeated branch mispredictions |
| Wide open | gem5 ARM64 O3 | CoreMark; sustained instruction throughput |
| Miss & recover | RSD / RISC-V | `mshr.log`; cache misses and branch mispredictions; workload not yet identified |
| Rename rush | gem5 ARM64 O3 | CoreMark; recorded renaming and physical-register reads and writes |
| x86 recovery | gem5 x86 O3 | CoreMark; micro-ops and register-map recovery |

Each demo's **Run details** and the [trace documentation](data/README.md) describe the execution conditions. Recorded timing and dependencies are distinguished from inferred structure and visual effects. Top-down estimates use a trailing eight-cycle window ending at the current playback time. See the [visualization specification](docs/visualization.md) (Japanese) for details.

## Development and verification

```sh
npm ci
npm test
npm run test:render
```

Electron is used for browser verification and is not included in the standalone HTML. On Linux without a display, use Xvfb:

```sh
xvfb-run -a -s '-screen 0 1600x1100x24' npm run test:render
# Check only mobile layouts and touch interaction.
xvfb-run -a -s '-screen 0 1600x1100x24' npm run test:mobile
```

Screenshots are written to `artifacts/screenshots/`. Browser checks copy only the built HTML into a temporary directory and block external requests. CI verifies the replay model, standalone build, desktop view, and mobile interaction. See the [development guide](docs/development.md) (Japanese) for details.

README files are written in English; explanatory source-code comments are written in Japanese.

## Layout

```text
src/                    HTML, CSS, WebGL rendering, and replay model
data/                   Five embedded trace excerpts and their provenance
scripts/                Build, verification, and trace-extraction tools
vendor/konata-core/      Pinned analysis modules used for trace extraction
docs/                   Visualization specification and development guide
dist/sonata.html         Standalone build output (ignored by Git)
artifacts/              Verification images and reports (ignored by Git)
inputs/                 Source logs for regeneration (ignored by Git)
work/                   Local working notes and handoff material (ignored by Git)
```

Normal builds and verification use the embedded data and require no source logs or external project checkout. To change the demo excerpts, follow the [regeneration instructions](data/README.md#regeneration).

## License

[BSD-3-Clause](LICENSE.md). Attribution and the pinned revision of the bundled analysis modules are documented in [vendor/konata-core](vendor/konata-core/README.md).
