# Contributing

Thanks for your interest in contributing to Project Elrond!

## Getting started

```bash
# Clone the repo
git clone https://github.com/Vibe-rator/Council-of-Elrond.git
cd Council-of-Elrond

# Install dependencies (requires Bun)
bun install

# Run the project
elrond
```

## Development

```bash
# Type check
bun run typecheck

# Lint & format
bun run lint
bun run format

# Run tests
bun test
```

## Submitting changes

1. Fork the repo and create a branch from `main`.
2. Make your changes and add tests if applicable.
3. Ensure `bun test`, `bun run typecheck`, and `bun run lint` all pass.
4. Open a pull request.

## Code style

This project uses [Biome](https://biomejs.dev/) for linting and formatting. Run `bun run format` before committing.

## Reporting bugs

Open an issue using the bug report template. Include your OS, terminal emulator, and Bun version.
