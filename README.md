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
- Supports coverage reporting through `--coverage` (see below for setup)
- Supports parallel execution through `--maxWorkers`

## Getting Started

### Prerequisites
- Node.js v22+ (recommended v24+)
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

For a full list of options, run:

```sh
npx jestrbx --help
```

### Cloud Execution
It's recommended to run tests through Roblox Open Cloud. Create a `.env` file with a `ROBLOSECURITY` field:
```
ROBLOSECURITY=your_roblosecurity_cookie_here
# or if you want to load balance across multiple accounts:
ROBLOSECURITY=cookie1,cookie2,cookie3
```
More information about setting up the `ROBLOSECURITY` variable can be found here: https://github.com/Unreal-Works/roblox-luau-execute

### Coverage
Coverage reporting requires a valid coverage instrumentation library:
- Wally: https://wally.run/package/evilbocchi/roblox-coverage
- roblox-ts: `npm i @rbxts/coverage`

To enable coverage reporting, use the `--coverage` flag:
```sh
npx jestrbx --place path/to/place.rbxl --coverage
```


### Example Project
See the `demo/` directory for a sample roblox-ts project with Jest tests configured.

Build and test with:

```sh
cd demo
npm run build   # Builds with roblox-ts and Rojo
npm test        # Runs tests with jest-roblox-assassin
```

## License
MIT
