# Moss Hot Retrieval Layer

Moss is Callan's in-call hot index. Supermemory remains the durable per-lead memory file; Moss holds the low-latency snippets the caller needs while a transcript is moving.

Source docs used:

- Moss overview: https://docs.moss.dev/docs/start/what-is-moss
- Moss CLI: https://docs.moss.dev/docs/integrations/moss-cli
- JavaScript SDK reference: https://docs.moss.dev/docs/reference/js/classes/MossClient
- Storage and local query behavior: https://docs.moss.dev/docs/integrate/storage-persistence

Runtime contract:

- One deterministic index per lead: `cmm_hot_<containerTag>`.
- Mock mode uses the same create/query/delete functions through an in-memory synthetic provider.
- Live mode only uses Moss credentials already present in env; index smoke is gated by `SMOKE_MOSS_INDEX=true`.
- Query events persist `query`, `topK`, `alpha`, latency, mode, and snippet IDs.
- This layer never performs web search or lead research.
