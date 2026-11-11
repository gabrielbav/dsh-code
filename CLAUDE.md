# dsh-code

Code mode plugin bundle for DeepSeek Harness. Read [README.md](README.md), then [docs/plan.md](docs/plan.md) for status and open work, [docs/validation.md](docs/validation.md) for architecture decisions, and [docs/spec.md](docs/spec.md) for the product spec.

- Plugin code lives here only. Generic Harness changes go to gabrielbav/deepseek-harness as separate upstream PRs; never put Code-specific code there.
- Never weaken an isolation invariant to make something work: gVisor only, no Docker socket, no host Git inside a sandbox-writable checkout, no credentials into containers, egress only through the proxy.
- Before pushing, run `pnpm run typecheck` and `pnpm test`; for changes under `src/core`, `src/egress` or `src/host`, also run `pnpm run test:docker`.
- Update README.md and docs/plan.md with every behavior change.
