# jest-roblox assassin

jestrbx is a CLI tool for running Jest-style tests against Roblox places, wrapping the Roblox Jest runtime and rewriting results for local source paths. It is designed to integrate with roblox-ts and Rojo workflows, providing a familiar Jest experience for Roblox game development.

## Features
- Runs Jest tests inside Roblox places using the JestCore runtime
- Maps Roblox datamodel paths back to local workspace files for readable output
- Supports custom and built-in Jest reporters
- CLI options are dynamically pulled from Roblox Jest docs
- Integrates with roblox-ts, Rojo, and standard TypeScript workflows
- Handles source mapping for .ts, .tsx, .lua, and .luau files
- Filters tests by name or path
- Supports parallel execution through `--maxWorkers`

## Getting Started

### Prerequisites
- Node.js (v16+ recommended)
- roblox-ts and Rojo (for TypeScript workflows)

### Installation
Clone this repository and install dependencies:

```sh
npm install
```

### Usage
Run tests against a Roblox place file:

```sh
npx jestrbx --place path/to/place.rbxl
```

#### Common CLI Options
- `--place <file>`: Path to the Roblox place file (required)
- `--project <dir>`: Path to the Rojo project file (optional)
- `--config <file>`: Path to a Jest config file. This is usually used to specify reporter options (optional)
- `--testNamePattern <pattern>`: Filter tests by name
- `--reporters <reporter>`: Use custom or built-in reporters
- `--maxWorkers <num>`: Number of worker threads to use for parallel test execution

For a full list of options, run:

```sh
npx jestrbx --help
```

### Example Project
See the `demo/` directory for a sample roblox-ts project with Jest specs:
- `demo/src/jest.config.ts`: Jest config
- `demo/src/setup.luau`: Setup script
- `demo/src/__tests__/`: Test specs

Build and test with:

```sh
cd demo
npm run build   # Builds with roblox-ts and Rojo
npm test        # Runs tests with jest-roblox-assassin
```

## License
MIT
