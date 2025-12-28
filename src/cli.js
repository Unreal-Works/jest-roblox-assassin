#!/usr/bin/env node

import { TestPathPatterns } from "@jest/pattern";
import { DefaultReporter, SummaryReporter } from "@jest/reporters";
import { Command } from "commander";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import * as rbxluau from "rbxluau";
import { pathToFileURL } from "url";
import { ensureCache } from "./cache.js";
import { getCliOptions } from "./docs.js";
import { ResultRewriter } from "./rewriter.js";

const cachePath = ensureCache();
const luauOutputPath = path.join(cachePath, "luau_output.log");

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
    .option("--project <file>", "path to project JSON file")
    .option("--config <file>", "path to Jest config file")
    .option(
        "--maxWorkers <number>",
        "maximum number of parallel workers to use"
    );

// Add options from fetched documentation
function collect(value, previous) {
    return previous.concat([value]);
}

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

// Load config file if specified
let configFileOptions = {};
if (options.config) {
    const configPath = path.resolve(options.config);
    if (!fs.existsSync(configPath)) {
        console.error(`Config file not found: ${configPath}`);
        process.exit(1);
    }
    try {
        const configUrl = pathToFileURL(configPath).href;
        const configModule = await import(configUrl);
        configFileOptions = configModule.default || configModule;
    } catch (error) {
        console.error(`Failed to load config file: ${error.message}`);
        process.exit(1);
    }
}

// Build jestOptions from config file first, then override with CLI arguments
const jestOptions = { ...configFileOptions };
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
if (options.maxWorkers) jestOptions.maxWorkers = options.maxWorkers;
if (options.testNamePattern)
    jestOptions.testNamePattern = options.testNamePattern;
if (options.testPathPattern)
    jestOptions.testPathPattern = options.testPathPattern;
else if (testPathPattern) jestOptions.testPathPattern = testPathPattern;
if (options.testMatch && options.testMatch.length > 0)
    jestOptions.testMatch = options.testMatch;
if (
    options.testPathIgnorePatterns &&
    options.testPathIgnorePatterns.length > 0
) {
    jestOptions.testPathIgnorePatterns = options.testPathIgnorePatterns;
}
if (options.reporters && options.reporters.length > 0)
    jestOptions.reporters = options.reporters;

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
                return fs
                    .readdirSync(dir, { withFileTypes: true })
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

// Helper function to execute Luau and parse results
async function executeLuauTest(testOptions, workerOutputPath) {
    const luauScript = `
local jestOptions = game:GetService("HttpService"):JSONDecode([===[${JSON.stringify(
        testOptions
    )}]===])
jestOptions.reporters = {} -- Redundant reporters, handled in JS

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

if jestOptions.showConfig then
    return 0
end

print("__SUCCESS_START__")
print(success)
print("__SUCCESS_END__")
print("__RESULT_START__")
print(game:GetService("HttpService"):JSONEncode(resolved))
print("__RESULT_END__")
return 0
`;

    const luauExitCode = await rbxluau.executeLuau(luauScript, {
        place: placeFile,
        silent: true,
        exit: false,
        out: workerOutputPath,
    });
    const outputLog = fs.readFileSync(workerOutputPath, "utf-8");

    if (luauExitCode !== 0) {
        throw new Error(
            `Luau script execution failed with exit code: ${luauExitCode}\n${outputLog}`
        );
    }

    if (testOptions.showConfig) {
        const firstBrace = outputLog.indexOf("{");
        const lastBrace = outputLog.lastIndexOf("}");
        return {
            config: JSON.parse(outputLog.slice(firstBrace, lastBrace + 1)),
        };
    }

    const successMatch = outputLog.match(
        /__SUCCESS_START__\s*(true|false)\s*__SUCCESS_END__/s
    );
    const resultMatch = outputLog.match(
        /__RESULT_START__\s*([\s\S]*?)\s*__RESULT_END__/s
    );

    if (!successMatch || !resultMatch) {
        throw new Error(`Failed to parse output log:\n${outputLog}`);
    }

    return JSON.parse(resultMatch[1]);
}

// Helper function to discover test files from filesystem
function discoverTestFilesFromFilesystem() {
    const outDirPath = path.join(projectRoot, outDir);

    if (!fs.existsSync(outDirPath)) {
        if (jestOptions.verbose) {
            console.log(`Output directory not found: ${outDirPath}`);
        }
        return [];
    }

    // Default test patterns if none specified
    const defaultTestMatch = [
        "**/__tests__/**/*.[jt]s?(x)",
        "**/?(*.)+(spec|test).[jt]s?(x)",
    ];

    const testMatchPatterns =
        jestOptions.testMatch && jestOptions.testMatch.length > 0
            ? jestOptions.testMatch
            : defaultTestMatch;

    // Convert glob patterns to work with .luau files in outDir
    const luauPatterns = testMatchPatterns.map((pattern) => {
        // Replace js/ts extensions with luau
        return pattern
            .replace(/\.\[jt\]s\?\(x\)/g, ".luau")
            .replace(/\.\[jt\]sx?/g, ".luau")
            .replace(/\.tsx?/g, ".luau")
            .replace(/\.jsx?/g, ".luau")
            .replace(/\.ts/g, ".luau")
            .replace(/\.js/g, ".luau");
    });

    // Add patterns for native .luau test files
    if (
        !luauPatterns.some(
            (p) => p.includes(".spec.luau") || p.includes(".test.luau")
        )
    ) {
        luauPatterns.push("**/__tests__/**/*.spec.luau");
        luauPatterns.push("**/__tests__/**/*.test.luau");
        luauPatterns.push("**/*.spec.luau");
        luauPatterns.push("**/*.test.luau");
    }

    const testFiles = [];

    // Simple recursive file finder with glob-like pattern matching
    function findFiles(dir, baseDir) {
        try {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
                const fullPath = path.join(dir, entry.name);
                const relativePath = path
                    .relative(baseDir, fullPath)
                    .replace(/\\/g, "/");

                if (entry.isDirectory()) {
                    // Skip node_modules and hidden directories
                    if (
                        !entry.name.startsWith(".") &&
                        entry.name !== "node_modules"
                    ) {
                        findFiles(fullPath, baseDir);
                    }
                } else if (entry.isFile() && entry.name.endsWith(".luau")) {
                    // Check if file matches any test pattern
                    const isTestFile = luauPatterns.some((pattern) => {
                        return matchGlobPattern(relativePath, pattern);
                    });

                    if (isTestFile) {
                        testFiles.push(relativePath);
                    }
                }
            }
        } catch (error) {
            // Ignore errors reading directories
        }
    }

    // Simple glob pattern matcher
    function matchGlobPattern(filePath, pattern) {
        // Handle common glob patterns
        let regexPattern = pattern
            .replace(/\./g, "\\.")
            .replace(/\*\*/g, "{{GLOBSTAR}}")
            .replace(/\*/g, "[^/]*")
            .replace(/{{GLOBSTAR}}/g, ".*")
            .replace(/\?/g, ".");

        // Handle optional groups like ?(x)
        regexPattern = regexPattern.replace(/\\\?\(([^)]+)\)/g, "($1)?");

        // Handle pattern groups like +(spec|test)
        regexPattern = regexPattern.replace(/\+\(([^)]+)\)/g, "($1)+");

        try {
            const regex = new RegExp(`^${regexPattern}$`, "i");
            return regex.test(filePath);
        } catch {
            // If pattern is invalid, fall back to simple check
            return filePath.includes(".spec.") || filePath.includes(".test.");
        }
    }

    findFiles(outDirPath, outDirPath);

    // Apply testPathIgnorePatterns if specified
    let filteredFiles = testFiles;
    if (
        jestOptions.testPathIgnorePatterns &&
        jestOptions.testPathIgnorePatterns.length > 0
    ) {
        filteredFiles = testFiles.filter((file) => {
            return !jestOptions.testPathIgnorePatterns.some((pattern) => {
                try {
                    const regex = new RegExp(pattern);
                    return regex.test(file);
                } catch {
                    return file.includes(pattern);
                }
            });
        });
    }

    // Apply testPathPattern filter if specified
    if (jestOptions.testPathPattern) {
        const pathPatternRegex = new RegExp(jestOptions.testPathPattern, "i");
        filteredFiles = filteredFiles.filter((file) =>
            pathPatternRegex.test(file)
        );
    }

    // Convert to roblox-jest path format (e.g., "src/__tests__/add.spec")
    // These paths are relative to projectRoot, use forward slashes, and have no extension
    const jestPaths = filteredFiles.map((file) => {
        // Remove .luau extension
        const withoutExt = file.replace(/\.luau$/, "");
        // Normalize to forward slashes
        const normalizedPath = withoutExt.replace(/\\/g, "/");
        // Prepend the rootDir (since outDir maps to rootDir in the place)
        return `${rootDir}/${normalizedPath}`;
    });

    if (jestOptions.verbose) {
        console.log(
            `Discovered ${jestPaths.length} test file(s) from filesystem`
        );
    }

    return jestPaths;
}

const actualStartTime = Date.now();
let parsedResults;

if (jestOptions.showConfig) {
    const result = await executeLuauTest(jestOptions, luauOutputPath);
    console.log(result.config);
    process.exit(0);
}

// Check if we should use parallel execution
const maxWorkers = jestOptions.maxWorkers || 1;
const useParallel = maxWorkers > 1;

if (useParallel) {
    // Discover test files from filesystem (fast, no caching needed)
    const testSuites = discoverTestFilesFromFilesystem();

    if (jestOptions.verbose) {
        console.log(`Found ${testSuites.length} test suite(s)`);
    }

    if (testSuites.length === 0) {
        console.warn("No test suites found");
        parsedResults = {
            globalConfig: {
                rootDir: workspaceRoot,
            },
            results: {
                numPassedTests: 0,
                numFailedTests: 0,
                numTotalTests: 0,
                testResults: [],
                success: true,
            },
        };
    } else if (testSuites.length === 1) {
        // If only one test suite, no point in splitting
        if (jestOptions.verbose) {
            console.log("Running single test suite");
        }
        parsedResults = await executeLuauTest(jestOptions, luauOutputPath);
    } else {
        // Split test suites across workers
        const workers = [];
        const suitesPerWorker = Math.ceil(testSuites.length / maxWorkers);

        for (let i = 0; i < maxWorkers; i++) {
            const start = i * suitesPerWorker;
            const end = Math.min(start + suitesPerWorker, testSuites.length);
            const workerSuites = testSuites.slice(start, end);

            if (workerSuites.length === 0) break;

            workers.push({
                id: i,
                suites: workerSuites,
            });
        }

        if (jestOptions.verbose) {
            console.log(`Running tests with ${workers.length} worker(s)`);
        }

        // Execute workers in parallel
        const workerResults = await Promise.all(
            workers.map(async (worker) => {
                const workerOptions = {
                    ...jestOptions,
                };

                // Create a testPathPattern regex that matches this worker's suites
                // Each suite is a datamodel path like "ReplicatedStorage.src.__tests__.add.spec"
                // We escape special regex chars and join with | for OR matching
                const escapedPaths = worker.suites.map((s) =>
                    s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
                );
                workerOptions.testPathPattern = `(${escapedPaths.join("|")})$`;

                const workerOutputPath = path.join(
                    cachePath,
                    `luau_output_worker_${worker.id}.log`
                );

                try {
                    return await executeLuauTest(
                        workerOptions,
                        workerOutputPath
                    );
                } finally {
                    // Clean up worker output file
                    if (fs.existsSync(workerOutputPath)) {
                        fs.unlinkSync(workerOutputPath);
                    }
                }
            })
        );

        // Combine results from all workers
        const combinedTestResults = [];
        let numPassedTests = 0;
        let numFailedTests = 0;
        let numPendingTests = 0;
        let numTodoTests = 0;
        let numTotalTests = 0;
        let numPassedTestSuites = 0;
        let numFailedTestSuites = 0;
        let numPendingTestSuites = 0;
        let numRuntimeErrorTestSuites = 0;
        let numTotalTestSuites = 0;
        let allSuccess = true;
        let globalConfig = null;
        const combinedSnapshot = {
            added: 0,
            fileDeleted: false,
            matched: 0,
            unchecked: 0,
            uncheckedKeys: [],
            unmatched: 0,
            updated: 0,
            filesAdded: 0,
            filesRemoved: 0,
            filesRemovedList: [],
            filesUnmatched: 0,
            filesUpdated: 0,
            didUpdate: false,
            total: 0,
            failure: false,
            uncheckedKeysByFile: [],
        };

        for (const result of workerResults) {
            if (result.results) {
                numPassedTests += result.results.numPassedTests || 0;
                numFailedTests += result.results.numFailedTests || 0;
                numPendingTests += result.results.numPendingTests || 0;
                numTodoTests += result.results.numTodoTests || 0;
                numTotalTests += result.results.numTotalTests || 0;
                numPassedTestSuites += result.results.numPassedTestSuites || 0;
                numFailedTestSuites += result.results.numFailedTestSuites || 0;
                numPendingTestSuites +=
                    result.results.numPendingTestSuites || 0;
                numRuntimeErrorTestSuites +=
                    result.results.numRuntimeErrorTestSuites || 0;
                numTotalTestSuites += result.results.numTotalTestSuites || 0;
                allSuccess = allSuccess && result.results.success;
                combinedTestResults.push(...(result.results.testResults || []));

                // Aggregate snapshot data
                if (result.results.snapshot) {
                    const snap = result.results.snapshot;
                    combinedSnapshot.added += snap.added || 0;
                    combinedSnapshot.matched += snap.matched || 0;
                    combinedSnapshot.unchecked += snap.unchecked || 0;
                    combinedSnapshot.unmatched += snap.unmatched || 0;
                    combinedSnapshot.updated += snap.updated || 0;
                    combinedSnapshot.filesAdded += snap.filesAdded || 0;
                    combinedSnapshot.filesRemoved += snap.filesRemoved || 0;
                    combinedSnapshot.filesUnmatched += snap.filesUnmatched || 0;
                    combinedSnapshot.filesUpdated += snap.filesUpdated || 0;
                    combinedSnapshot.total += snap.total || 0;
                    combinedSnapshot.didUpdate =
                        combinedSnapshot.didUpdate || snap.didUpdate || false;
                    combinedSnapshot.failure =
                        combinedSnapshot.failure || snap.failure || false;
                    if (snap.filesRemovedList) {
                        combinedSnapshot.filesRemovedList.push(
                            ...snap.filesRemovedList
                        );
                    }
                    if (snap.uncheckedKeysByFile) {
                        combinedSnapshot.uncheckedKeysByFile.push(
                            ...snap.uncheckedKeysByFile
                        );
                    }
                    if (snap.uncheckedKeys) {
                        combinedSnapshot.uncheckedKeys.push(
                            ...snap.uncheckedKeys
                        );
                    }
                }
            }
            // Use globalConfig from first worker
            if (!globalConfig && result.globalConfig) {
                globalConfig = result.globalConfig;
            }
        }

        parsedResults = {
            globalConfig: globalConfig || { rootDir: workspaceRoot },
            results: {
                numPassedTests,
                numFailedTests,
                numPendingTests,
                numTodoTests,
                numTotalTests,
                numPassedTestSuites,
                numFailedTestSuites,
                numPendingTestSuites,
                numRuntimeErrorTestSuites,
                numTotalTestSuites,
                testResults: combinedTestResults,
                success: allSuccess,
                snapshot: combinedSnapshot,
                startTime: 0,
                wasInterrupted: false,
                openHandles: [],
            },
        };
    }
} else {
    // Single worker execution (original behavior)
    parsedResults = await executeLuauTest(jestOptions, luauOutputPath);
}

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
    ...jestOptions,
    rootDir: parsedResults.globalConfig.rootDir || workspaceRoot,
    testPathPatterns,
};

const reporterConfigs = [];

if (jestOptions.reporters && jestOptions.reporters.length > 0) {
    // Custom reporters specified
    for (const reporterEntry of jestOptions.reporters) {
        // Reporter can be a string or [string, options]
        const reporterName = Array.isArray(reporterEntry)
            ? reporterEntry[0]
            : reporterEntry;
        const reporterOptions = Array.isArray(reporterEntry)
            ? reporterEntry[1]
            : undefined;

        if (reporterName === "default") {
            reporterConfigs.push({
                Reporter: DefaultReporter,
                options: reporterOptions,
            });
        } else if (reporterName === "summary") {
            reporterConfigs.push({
                Reporter: SummaryReporter,
                options: reporterOptions,
            });
        } else {
            try {
                const ReporterModule = await import(reporterName);
                if (ReporterModule && ReporterModule.default) {
                    reporterConfigs.push({
                        Reporter: ReporterModule.default,
                        options: reporterOptions,
                    });
                } else {
                    console.warn(
                        `Reporter module "${reporterName}" does not have a default export.`
                    );
                }
            } catch (error) {
                console.warn(
                    `Failed to load reporter module "${reporterName}": ${error.message}`
                );
            }
        }
    }
} else {
    // Default reporters
    reporterConfigs.push({ Reporter: DefaultReporter, options: undefined });
    reporterConfigs.push({ Reporter: SummaryReporter, options: undefined });
}

for (const { Reporter, options: reporterOptions } of reporterConfigs) {
    const reporter = new Reporter(globalConfig, reporterOptions);

    // Create aggregated results in the format Jest expects
    const aggregatedResults = {
        ...parsedResults.results,
        numPassedTests: parsedResults.results.numPassedTests || 0,
        numFailedTests: parsedResults.results.numFailedTests || 0,
        numTotalTests: parsedResults.results.numTotalTests || 0,
        testResults: parsedResults.results.testResults || [],
        startTime: actualStartTime,
        snapshot: parsedResults.results.snapshot || {
            added: 0,
            fileDeleted: false,
            matched: 0,
            unchecked: 0,
            uncheckedKeys: [],
            unmatched: 0,
            updated: 0,
        },
        wasInterrupted: false,
    };

    // Call reporter lifecycle methods if they exist
    if (typeof reporter.onRunStart === "function") {
        await Promise.resolve(
            reporter.onRunStart(aggregatedResults, {
                estimatedTime: 0,
                showStatus: true,
            })
        );
    }

    // Report each test result
    if (parsedResults.results.testResults) {
        for (const testResult of parsedResults.results.testResults) {
            if (typeof reporter.onTestResult === "function") {
                await Promise.resolve(
                    reporter.onTestResult(
                        { context: { config: globalConfig } },
                        testResult,
                        aggregatedResults
                    )
                );
            } else if (typeof reporter.onTestStart === "function") {
                await Promise.resolve(reporter.onTestStart(testResult));
            }
        }
    }

    // Complete the run
    if (typeof reporter.onRunComplete === "function") {
        await Promise.resolve(
            reporter.onRunComplete(new Set(), aggregatedResults)
        );
    }
}

// Exit with appropriate code
process.exit(parsedResults.results.success ? 0 : 1);
