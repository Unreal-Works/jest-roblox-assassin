#!/usr/bin/env node

import { Command } from "commander";
import dotenv from "dotenv";
import { getCliOptions } from "./docs.js";
import runJestRoblox from "./runJestRoblox.js";

// Load environment variables from .env file
dotenv.config({ quiet: true });

// Fetch CLI options and build commander program
const cliOptions = await getCliOptions();

const program = new Command();

program
    .name("jestrbx")
    .description("Delightful Roblox testing.")
    .version("1.0.0")
    .argument("[testPathPattern]", "test path pattern to match")
    .option("--place <file>", "path to Roblox place file")
    .option("--project <file>", "path to Rojo project JSON file. Used to map output back to source files")
    .option("--tsconfig <file>", "path to tsconfig.json file. Used to map output back to source files")
    .option("--config <file>", "path to Jest config file")
    .option(
        "--maxWorkers <number>",
        "maximum number of parallel workers to use"
    )
    .option(
        "--testLocationInResults",
        "Adds a location field to test results. Useful if you want to report the location of a test in a reporter."
    )
    .option(
        "--watch",
        "Watch files for changes and rerun tests related to changed files. If you want to re-run all tests when a file has changed, use the --watchAll option instead."
    )
    .option(
        "--watchAll",
        "Watch files for changes and rerun all tests when something changes. If you want to re-run only the tests that depend on the changed files, use the --watch option."
    );

for (const opt of cliOptions) {
    const flagName = opt.name.replace(/^--/, "");
    const isArray = opt.type.includes("array");
    const isNumber = opt.type.includes("number");
    const isString = opt.type.includes("string") || opt.type.includes("regex");

    let flags = opt.name;
    // Add short flags for common options
    const shortFlags = {
        verbose: "-v",
        testNamePattern: "-t",
    };
    if (shortFlags[flagName]) {
        flags = `${shortFlags[flagName]}, ${opt.name}`;
    }

    // Handle value placeholder
    if (isString) {
        flags += " <value>";
    } else if (isNumber) {
        flags += " <ms>";
    }

    const description = opt.description.split("\n")[0]; // First line only

    if (isArray) {
        program.option(flags, description, (value, previous) => {
            return previous ? previous.concat([value]) : [value];
        });
    } else if (isNumber) {
        program.option(flags, description, Number);
    } else {
        program.option(flags, description);
    }
}

const argv = process.argv.slice(2);
program.parse();

// Exit early for info-only flags to avoid running the heavy runner setup
const infoOnlyFlags = new Set(["--version", "-V", "--help", "-h"]);
if (argv.some((flag) => infoOnlyFlags.has(flag))) {
    process.exit(0);
}

const [testPathPattern] = program.args;
process.exit(await runJestRoblox({ ...program.opts(), testPathPattern }));
