#!/usr/bin/env node

import dotenv from "dotenv";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
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
        describe: "maximum number of parallel workers to use",
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
        describe: "TODO: Not yet implemented",
        type: "boolean",
    })
    .option("watchAll", {
        describe: "TODO: Not yet implemented",
        type: "boolean",
    })
    .option("useStderr", {
        describe: "TODO: Not yet implemented",
        type: "boolean",
    })
    .option("outputFile", {
        describe: "TODO: Not yet implemented",
        type: "string",
    })
    .option("skipExecution", {
        describe: "development command",
        type: "boolean",
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

process.exit(
    await runJestRoblox({
        ...args,
        testPathPattern,
    })
);
