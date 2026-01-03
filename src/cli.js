#!/usr/bin/env node

import chokidar from "chokidar";
import dotenv from "dotenv";
import path from "path";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { findPlaceFile } from "./discovery.js";
import { getCliOptions } from "./docs.js";
import runJestRoblox from "./runJestRoblox.js";

// Load environment variables from .env file
dotenv.config({ quiet: true });

// Fetch CLI options and build yargs instance
const cliOptions = await getCliOptions();

let yargsInstance = yargs(hideBin(process.argv))
    .scriptName("jestrbx")
    .positional("testPathPattern", {
        describe: "test path pattern to match",
        type: "string",
    })
    .option("place", {
        describe: "path to Roblox place file",
        type: "string",
    })
    .option("project", {
        describe:
            "path to Rojo project JSON file. Used to map output back to source files",
        type: "string",
    })
    .option("tsconfig", {
        describe:
            "path to tsconfig.json file. Used to map output back to source files",
        type: "string",
    })
    .option("config", {
        describe: "path to Jest config file",
        type: "string",
    })
    .option("maxWorkers", {
        describe: "EXPERIMENTAL: maximum number of parallel workers to use",
        type: "number",
    })
    .option("testLocationInResults", {
        describe:
            "Adds a location field to test results. Useful if you want to report the location of a test in a reporter.",
        type: "boolean",
    })
    .option("coverage", {
        describe:
            "Indicates that test coverage information should be collected and reported in the output.",
        type: "boolean",
        alias: "collectCoverage",
    })
    .option("watch", {
        describe: "Alias of watchAll. Watches the place file and reruns tests on changes.",
        type: "boolean",
    })
    .option("watchAll", {
        describe: "Watches the place file and reruns tests on changes.",
        type: "boolean",
    })
    .option("useStderr", {
        describe: "Divert all output to stderr.",
        type: "boolean",
    })
    .option("outputFile", {
        describe:
            "Write test results to a file when the --json option is also specified. The returned JSON structure is documented in testResultsProcessor.",
        type: "string",
    });

// Add dynamically fetched CLI options
for (const opt of cliOptions) {
    const flagName = opt.name.replace(/^--/, "");
    const isArray = opt.type.includes("array");
    const isNumber = opt.type.includes("number");
    const isBoolean = opt.type.includes("boolean");

    const description = opt.description.split("\n")[0]; // First line only

    // Add short flags for common options
    const shortFlags = {
        verbose: "v",
        testNamePattern: "t",
    };

    const optionConfig = {
        describe: description,
        type: isBoolean
            ? "boolean"
            : isArray
            ? "array"
            : isNumber
            ? "number"
            : "string",
    };

    if (shortFlags[flagName]) {
        optionConfig.alias = shortFlags[flagName];
    }

    yargsInstance = yargsInstance.option(flagName, optionConfig);
}

const args = await yargsInstance
    .help("help", "Show help message")
    .alias("help", "h")
    .alias("version", "v")
    .strict(false).argv;

// Extract testPathPattern from positional args
const [testPathPattern] = args._;

// watch is a compat alias for watchAll in this tool
if (args.watch && !args.watchAll) {
    args.watchAll = true;
}

const watchMode = Boolean(args.watchAll);
const resolvedPlace = watchMode ? args.place ?? findPlaceFile() : args.place;

if (watchMode && !resolvedPlace) {
    console.error(
        "Watch mode requires a --place file or a discoverable place in the current workspace."
    );
    process.exit(1);
}

const absolutePlace = resolvedPlace ? path.resolve(resolvedPlace) : undefined;

const runOnce = async () => {
    try {
        return await runJestRoblox({
            ...args,
            place: absolutePlace ?? args.place,
            testPathPattern,
        });
    } catch (error) {
        console.error(error?.stack || error?.message || String(error));
        return 1;
    }
};

if (!watchMode) {
    process.exit(await runOnce());
}

let running = false;
let pending = false;
let lastExitCode = 0;
const DEBOUNCE_MS = 2000;
let debounceTimer = null;
let lastReason = null;

const triggerRun = async (reason) => {
    if (running) {
        pending = true;
        return;
    }

    running = true;
    if (reason) {
        console.log(`\nChange detected (${reason}). Running tests...`);
    }

    lastExitCode = await runOnce();
    running = false;

    if (pending) {
        pending = false;
        await triggerRun();
    }
};

const scheduleRun = (reason) => {
    lastReason = reason ?? lastReason;
    if (debounceTimer) {
        clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(() => {
        debounceTimer = null;
        triggerRun(lastReason);
    }, DEBOUNCE_MS);
};

console.log(
    `Watching ${path.relative(process.cwd(), absolutePlace)} for changes. Press Ctrl+C to exit.`
);

const watcher = chokidar.watch(absolutePlace, { ignoreInitial: true });

watcher.on("all", (event, changedPath) => {
    if (event === "change" || event === "add" || event === "unlink") {
        const reason = changedPath
            ? path.relative(process.cwd(), changedPath)
            : event;
        scheduleRun(reason);
    }
});

watcher.on("error", (error) => {
    console.error(`Watcher error: ${error?.message || error}`);
});

await triggerRun("initial run");

const cleanup = () => {
    watcher.close().catch?.(() => {});
    if (debounceTimer) {
        clearTimeout(debounceTimer);
    }
    process.exit(lastExitCode);
};

process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);
