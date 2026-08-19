Implement the Roast Solver through milestone M6 as a complete, locally hostable first web-app version.

Read `PROJECT_PLAN.md` in this repository first; it is the authoritative product and physics plan. Implement M1 through M6, including:

- the Python NumPy reference physics/property/SDF and 3D solver implementation
- embedded-boundary Robin validation and energy accounting
- radiation, per-surface-cell staged evaporation, rest/carryover, and clearly documented synthetic calibration fixtures
- a Rust/WASM web core kept consistent with the Python reference using practical golden/regression checks
- progressive execution in a worker
- a production-buildable static UI with inputs, temperature curves, slice or isosurface/doneness visualization, pull/carryover output, and pasteurization output
- a Nix flake and clear setup, test, build, local-preview, and static-hosting documentation

Do not implement M7 WebGPU or M8 photo reconstruction. Do not claim empirical calibration: no real probe logs are provided.

Work autonomously and make reasonable documented engineering choices. Do not stop to ask questions. This is an implementation task, not a planning exercise: create the code, run the project's own tests and production builds, fix failures, and leave the repository in a reviewable state. Prioritize a coherent runnable vertical slice over disconnected scaffolding if trade-offs are necessary. Do not commit changes; the experiment harness captures the worktree.
