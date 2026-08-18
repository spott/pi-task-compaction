# pi-task-compaction

A hierarchical task framework and task-aware context compaction extension for [pi](https://github.com/badlogic/pi-mono).

This `main` branch is the greenfield v2 implementation. The previous implementation is preserved on `archive/v1`; the tested v1 baseline is tagged `v0.1.0`.

The v2 architecture separates semantic task events, transcript provenance, context projection, inspection artifacts, worker routing, and global compaction. Public behavior follows **API v2** when it differs from the implementation plan.

## Development

Requires Node.js 22.19 or newer.

```sh
npm install
npm run check
```

The package entrypoint is `extensions/task-framework.ts`.
