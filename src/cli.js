#!/usr/bin/env node

import { TestPathPatterns } from "@jest/pattern";
import { DefaultReporter, SummaryReporter } from "@jest/reporters";
import { Command } from "commander";
import dotenv from "dotenv";
import fs from "fs";
import path, { dirname } from "path";
import * as rbxluau from "rbxluau";
import { fileURLToPath } from "url";
import { ResultRewriter } from "./rewriter.js";
import { getCliOptions } from "./docs.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const outputPath = path.join(__dirname, "luau_output.log");

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
    .option("--project <file>", "path to project JSON file");

// Add options from fetched documentation
function collect(value, previous) {
    return previous.concat([value]);
}

for (const opt of cliOptions) {
    const flagName = opt.name.replace(/^--/, "");
    const isArray = opt.type.includes("array");
    const isNumber = opt.type.includes("number");
    
    let flags = opt.name;
    // Add short flags for common options
    const shortFlags = {
        verbose: "-v",
        testNamePattern: "-t"
    };
    if (shortFlags[flagName]) {
        flags = `${shortFlags[flagName]}, ${opt.name}`;
    }
    
    // Handle value placeholder
    if (opt.type.includes("string")) {
        flags += " <value>";
    } else if (isNumber) {
        flags += " <ms>";
    }
    
    const description = opt.description.split("\n")[0]; // First line only
    
    if (isArray) {
        program.option(flags, description, collect, []);
    } else if (isNumber) {
        program.option(flags, description, Number);
    } else {
        program.option(flags, description);
    }
}

program.parse();

const options = program.opts();
const [testPathPattern] = program.args;

// Build jestOptions from parsed arguments
const jestOptions = {};
if (options.ci) jestOptions.ci = true;
if (options.clearMocks) jestOptions.clearMocks = true;
if (options.debug) jestOptions.debug = true;
if (options.expand) jestOptions.expand = true;
if (options.json) jestOptions.json = true;
if (options.listTests) jestOptions.listTests = true;
if (options.noStackTrace) jestOptions.noStackTrace = true;
if (options.passWithNoTests) jestOptions.passWithNoTests = true;
if (options.resetMocks) jestOptions.resetMocks = true;
if (options.showConfig) jestOptions.showConfig = true;
if (options.updateSnapshot) jestOptions.updateSnapshot = true;
if (options.verbose) jestOptions.verbose = true;
if (options.testTimeout) jestOptions.testTimeout = options.testTimeout;
if (options.testNamePattern) jestOptions.testNamePattern = options.testNamePattern;
if (options.testPathPattern) jestOptions.testPathPattern = options.testPathPattern;
else if (testPathPattern) jestOptions.testPathPattern = testPathPattern;
if (options.testMatch && options.testMatch.length > 0) jestOptions.testMatch = options.testMatch;
if (options.testPathIgnorePatterns && options.testPathIgnorePatterns.length > 0) {
    jestOptions.testPathIgnorePatterns = options.testPathIgnorePatterns;
}
if (options.reporters && options.reporters.length > 0) jestOptions.reporters = options.reporters;

const placeFile = options.place;
let projectFile = options.project ? path.resolve(options.project) : undefined;

const workspaceRoot = placeFile
    ? path.dirname(path.resolve(placeFile))
    : process.cwd();

let projectRoot = workspaceRoot;

if (!projectFile) {
    const defaultProject = path.join(projectRoot, "default.project.json");
    if (fs.existsSync(defaultProject)) {
        projectFile = defaultProject;
    } else {
        // Search up to 2 levels deep
        const getSubdirs = (dir) => {
            try {
                return fs.readdirSync(dir, { withFileTypes: true })
                    .filter(
                        (dirent) =>
                            dirent.isDirectory() &&
                            !dirent.name.startsWith(".") &&
                            dirent.name !== "node_modules"
                    )
                    .map((dirent) => path.join(dir, dirent.name));
            } catch {
                return [];
            }
        };

        const level1 = getSubdirs(projectRoot);
        for (const dir of level1) {
            const p = path.join(dir, "default.project.json");
            if (fs.existsSync(p)) {
                projectFile = p;
                projectRoot = dir;
                break;
            }
        }

        if (!projectFile) {
            for (const dir of level1) {
                const level2 = getSubdirs(dir);
                for (const dir2 of level2) {
                    const p = path.join(dir2, "default.project.json");
                    if (fs.existsSync(p)) {
                        projectFile = p;
                        projectRoot = dir2;
                        break;
                    }
                }
                if (projectFile) break;
            }
        }
    }
}

const tsConfigPath = path.join(projectRoot, "tsconfig.json");

const stripJsonComments = (text) =>
    text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const readJsonWithComments = (jsonPath) => {
    if (!fs.existsSync(jsonPath)) return undefined;
    const raw = fs.readFileSync(jsonPath, "utf-8");
    try {
        return JSON.parse(stripJsonComments(raw));
    } catch (error) {
        return undefined;
    }
};

const compilerOptions =
    readJsonWithComments(tsConfigPath)?.compilerOptions || {};

const rootDir = compilerOptions.rootDir || "src";
const outDir = compilerOptions.outDir || "out";

const findDatamodelPath = (tree, targetPath, currentPath = []) => {
    const normalize = (p) =>
        path
            .normalize(p)
            .replace(/[\\\/]$/, "")
            .replace(/\\/g, "/");
    const normalizedTarget = normalize(targetPath);

    if (tree.$path && normalize(tree.$path) === normalizedTarget) {
        return currentPath;
    }

    for (const [key, value] of Object.entries(tree)) {
        if (key.startsWith("$")) continue;
        if (typeof value !== "object") continue;

        const found = findDatamodelPath(value, targetPath, [
            ...currentPath,
            key,
        ]);
        if (found) return found;
    }
    return undefined;
};

const projectJson = projectFile ? readJsonWithComments(projectFile) : undefined;
let datamodelPrefixSegments = projectJson
    ? findDatamodelPath(projectJson.tree, outDir)
    : undefined;

if (!datamodelPrefixSegments || datamodelPrefixSegments.length === 0) {
    console.warn(
        `Could not determine datamodel prefix for outDir "${outDir}".`
    );
    datamodelPrefixSegments = ["ReplicatedStorage", ...rootDir.split(path.sep)];
}

// Get test filter from environment variable (set by VS Code extension)
if (process.env.JEST_TEST_NAME_PATTERN) {
    jestOptions.testNamePattern = process.env.JEST_TEST_NAME_PATTERN;
}

const testPathPatterns = new TestPathPatterns(
    jestOptions.testPathPattern ? [jestOptions.testPathPattern] : []
);

// Build the Luau script with optional test filter
let luauScript = `
local jestOptions = game:GetService("HttpService"):JSONDecode([===[${JSON.stringify(
    jestOptions
)}]===])

local runCLI
local projects = {}
for i, v in pairs(game:GetDescendants()) do
    if v.Name == "cli" and v.Parent.Name == "JestCore" and v:IsA("ModuleScript") then
        local reading = require(v)
        if reading and reading.runCLI then
            if runCLI then
                warn("Multiple JestCore CLI modules found;" .. v:GetFullName())
            end
            runCLI = reading.runCLI
        end
    elseif v.Name == "jest.config" and v:IsA("ModuleScript") then
        table.insert(projects, v.Parent)
    end
end

if not runCLI then
    error("Could not find JestCore CLI module")
end
if #projects == 0 then
    error("Could not find any jest.config modules")
end

local success, resolved = runCLI(game, jestOptions, projects):await()
print("__SUCCESS_START__")
print(success)
print("__SUCCESS_END__")
print("__RESULT_START__")
print(game:GetService("HttpService"):JSONEncode(resolved))
print("__RESULT_END__")
return 0
`;

const actualStartTime = Date.now();
const luauExitCode = await rbxluau.executeLuau(luauScript, {
    place: placeFile,
    silent: true,
    exit: false,
    out: outputPath,
});

const outputLog = fs.readFileSync(outputPath, "utf-8");

if (luauExitCode !== 0) {
    console.error("Luau script execution failed with exit code:", luauExitCode);
    console.error(outputLog);
    process.exit(1);
}

const successMatch = outputLog.match(
    /__SUCCESS_START__\s*(true|false)\s*__SUCCESS_END__/s
);
const resultMatch = outputLog.match(
    /__RESULT_START__\s*([\s\S]*?)\s*__RESULT_END__/s
);

if (!successMatch || !resultMatch) {
    console.error("Failed to parse output log:");
    console.error(outputLog);
    process.exit(1);
}

const parsedResults = JSON.parse(resultMatch[1]);

new ResultRewriter({
    workspaceRoot,
    projectRoot,
    rootDir,
    outDir,
    datamodelPrefixSegments,
}).rewriteParsedResults(parsedResults.results);

// Fix globalConfig - set rootDir to current working directory if null
const globalConfig = {
    ...parsedResults.globalConfig,
    rootDir: parsedResults.globalConfig.rootDir || workspaceRoot,
    testPathPatterns,
};
const reporterClasses = [DefaultReporter, SummaryReporter];
for (const Reporter of reporterClasses) {
    const reporter = new Reporter(globalConfig);

    // Create aggregated results in the format Jest expects
    const aggregatedResults = {
        ...parsedResults.results,
        numPassedTests: parsedResults.results.numPassedTests || 0,
        numFailedTests: parsedResults.results.numFailedTests || 0,
        numTotalTests: parsedResults.results.numTotalTests || 0,
        testResults: parsedResults.results.testResults || [],
        startTime: actualStartTime,
    };

    // Call reporter lifecycle methods
    reporter.onRunStart(aggregatedResults, {
        estimatedTime: 0,
        showStatus: true,
    });

    // Report each test result
    if (parsedResults.results.testResults) {
        for (const testResult of parsedResults.results.testResults) {
            reporter.onTestResult(
                { context: { config: globalConfig } },
                testResult,
                aggregatedResults
            );
        }
    }

    // Complete the run
    reporter.onRunComplete(new Set(), aggregatedResults);
}

// Exit with appropriate code
process.exit(parsedResults.results.success ? 0 : 1);
