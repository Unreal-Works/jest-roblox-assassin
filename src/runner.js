import { TestPathPatterns } from "@jest/pattern";
import { DefaultReporter, SummaryReporter } from "@jest/reporters";
import fs from "fs";
import path from "path";
import * as rbxluau from "rbxluau";
import { pathToFileURL } from "url";
import { ensureCache } from "./cache.js";
import {
    discoverCompilerOptions,
    discoverPlaceFile,
    discoverRojoProject,
    discoverTestFilesFromFilesystem,
} from "./discovery.js";
import { ResultRewriter } from "./rewriter.js";

const cachePath = ensureCache();
const luauOutputPath = path.join(cachePath, "luau_output.log");

/**
 * Executes JestRoblox with the given options, collects results and outputs them using reporters.
 * The options can also affect the behavior of what is done with the results.
 * @param {object} options The CLI options to run JestRoblox with.
 * @returns {Promise<number>} Exit code (0 for success, 1 for failure).
 */
export async function runJestRoblox(options) {
    // Discover place file if not specified
    if (!options.place) {
        options.place = discoverPlaceFile();
    }

    // Load config file if specified
    let configFileOptions = {};
    if (options.config) {
        const configPath = path.resolve(options.config);
        if (!fs.existsSync(configPath)) {
            console.error(`Config file not found: ${configPath}`);
            return 1;
        }
        try {
            const configUrl = pathToFileURL(configPath).href;
            const configModule = await import(configUrl);
            configFileOptions = configModule.default || configModule;
            for (const key of Object.keys(configFileOptions)) {
                options[key] = configFileOptions[key];
            }
        } catch (error) {
            console.error(`Failed to load config file: ${error.message}`);
            return 1;
        }
    }

    if (process.env.JEST_TEST_NAME_PATTERN) {
        options.testNamePattern = process.env.JEST_TEST_NAME_PATTERN;
    }

    const rojoProject = discoverRojoProject(
        options.project ? path.resolve(options.project) : undefined
    );
    const compilerOptions = discoverCompilerOptions();

    const actualStartTime = Date.now();
    let parsedResults;

    if (options.showConfig || options.listTests) {
        const result = await executeLuauTest(options, luauOutputPath);
        if (options.showConfig) {
            console.log(result.config);
        } else {
            console.log(result);
        }
        return 0;
    }

    // Check if we should use parallel execution
    const maxWorkers = options.maxWorkers || 1;
    const useParallel = maxWorkers > 1;

    if (useParallel) {
        // Discover test files from filesystem
        const testSuites = discoverTestFilesFromFilesystem(
            compilerOptions,
            options
        );

        if (options.verbose) {
            console.log(`Found ${testSuites.length} test suite(s)`);
        }

        if (testSuites.length === 0) {
            console.warn("No test suites found");
            parsedResults = {
                globalConfig: {
                    rootDir: cwd,
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
            if (options.verbose) {
                console.log("Running single test suite");
            }
            parsedResults = await executeLuauTest(options, luauOutputPath);
        } else {
            // Split test suites across workers
            const workers = [];
            const suitesPerWorker = Math.ceil(testSuites.length / maxWorkers);

            for (let i = 0; i < maxWorkers; i++) {
                const start = i * suitesPerWorker;
                const end = Math.min(
                    start + suitesPerWorker,
                    testSuites.length
                );
                const workerSuites = testSuites.slice(start, end);

                if (workerSuites.length === 0) break;

                workers.push({
                    id: i,
                    suites: workerSuites,
                });
            }

            if (options.verbose) {
                console.log(`Running tests with ${workers.length} worker(s)`);
            }

            // Execute workers in parallel
            const workerResults = await Promise.all(
                workers.map(async (worker) => {
                    const workerOptions = {
                        ...options,
                    };

                    // Create a testPathPattern regex that matches this worker's suites
                    // Each suite is a datamodel path like "ReplicatedStorage.src.__tests__.add.spec"
                    // We escape special regex chars and join with | for OR matching
                    const escapedPaths = worker.suites.map((s) =>
                        s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
                    );
                    workerOptions.testPathPattern = `(${escapedPaths.join(
                        "|"
                    )})$`;

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
                    numPassedTestSuites +=
                        result.results.numPassedTestSuites || 0;
                    numFailedTestSuites +=
                        result.results.numFailedTestSuites || 0;
                    numPendingTestSuites +=
                        result.results.numPendingTestSuites || 0;
                    numRuntimeErrorTestSuites +=
                        result.results.numRuntimeErrorTestSuites || 0;
                    numTotalTestSuites +=
                        result.results.numTotalTestSuites || 0;
                    allSuccess = allSuccess && result.results.success;
                    combinedTestResults.push(
                        ...(result.results.testResults || [])
                    );

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
                        combinedSnapshot.filesUnmatched +=
                            snap.filesUnmatched || 0;
                        combinedSnapshot.filesUpdated += snap.filesUpdated || 0;
                        combinedSnapshot.total += snap.total || 0;
                        combinedSnapshot.didUpdate =
                            combinedSnapshot.didUpdate ||
                            snap.didUpdate ||
                            false;
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
                globalConfig: globalConfig || { rootDir: cwd },
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
        parsedResults = await executeLuauTest(options, luauOutputPath);
        if (parsedResults === undefined) return 1;
    }

    new ResultRewriter({ compilerOptions, rojoProject }).rewriteParsedResults(
        parsedResults.results
    );

    if (
        options.passWithNoTests &&
        parsedResults.results.numTotalTests === 0
    ) {
        parsedResults.results.success = true;
    }

    if (options.json) {
        console.log(JSON.stringify(parsedResults.results, null, 2));
        return parsedResults.results.success ? 0 : 1;
    }

    // Fix globalConfig - set rootDir to current working directory if null
    const globalConfig = {
        ...(parsedResults.globalConfig || {}),
        ...options,
        rootDir:
            (parsedResults.globalConfig &&
                parsedResults.globalConfig.rootDir) ||
            process.cwd(),
        testPathPatterns: new TestPathPatterns(
            options.testPathPattern ? [options.testPathPattern] : []
        ),
    };

    const reporterConfigs = [];

    if (options.reporters && options.reporters.length > 0) {
        // Custom reporters specified
        for (const reporterEntry of options.reporters) {
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
    return parsedResults.results.success ? 0 : 1;
}

/**
 * Executes the Luau script to run Jest tests with the given options.
 * @param {object} options The Jest options to pass to the Luau script.
 * @param {string} workerOutputPath The file path to write the Luau output log.
 * @returns {Promise<any>} The parsed results from the Luau script.
 */
export async function executeLuauTest(options, workerOutputPath) {
    const luauScript = `
local jestOptions = game:GetService("HttpService"):JSONDecode([===[${JSON.stringify(
        options
    )}]===])
-- These options are handled in JS
jestOptions.reporters = {}
jestOptions.json = false

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
        local fullName = v:GetFullName()
        if not fullName:find("rbxts_include") and not fullName:find("node_modules") then
            table.insert(projects, v.Parent)
        end
    end
end

if not runCLI then
    error("Could not find JestCore CLI module")
end
if #projects == 0 then
    error("Could not find any jest.config modules")
end

local success, resolved = runCLI(game, jestOptions, projects):await()

if jestOptions.showConfig or jestOptions.listTests then
    return 0
end

print("__SUCCESS_START__")
print(success)
print("__SUCCESS_END__")
print("__PROJECTS_START__")
local fullNameProjects = {}
for i, v in pairs(projects) do
    table.insert(fullNameProjects, v:GetFullName())
end
print(game:GetService("HttpService"):JSONEncode(fullNameProjects))
print("__PROJECTS_END__")
print("__RESULT_START__")
return game:GetService("HttpService"):JSONEncode(resolved)
`;

    let luauExitCode = 0;

    if (!options.skipExecution) {
        if (!options.place) {
            console.error(
                "--place option is required to run tests. No .rbxl or .rbxlx file found in current directory or nearby."
            );
            return;
        }

        luauExitCode = await rbxluau.executeLuau(luauScript, {
            place: options.place,
            silent: true,
            exit: false,
            out: workerOutputPath,
        });
    }
    const outputLog = fs.readFileSync(workerOutputPath, "utf-8");

    if (luauExitCode !== 0) {
        throw new Error(
            `Luau script execution failed with exit code: ${luauExitCode}\n${outputLog}`
        );
    }

    if (options.listTests) {
        return outputLog;
    }

    if (options.showConfig) {
        const firstBrace = outputLog.indexOf("{");
        const lastBrace = outputLog.lastIndexOf("}");
        return {
            config: JSON.parse(outputLog.slice(firstBrace, lastBrace + 1)),
        };
    }

    const successMatch = outputLog.match(
        /__SUCCESS_START__\s*(true|false)\s*__SUCCESS_END__/s
    );
    const resultMatch = outputLog.match(/__RESULT_START__\s*([\s\S]*)$/s);

    if (!successMatch || !resultMatch) {
        throw new Error(`Failed to parse output log:\n${outputLog}`);
    }

    const success = successMatch[1] === "true";
    const result = JSON.parse(resultMatch[1].trim());

    if (!success) {
        if (typeof result === "string") {
            throw new Error(`Jest execution failed: ${result}`);
        } else {
            throw new Error(
                `Jest execution failed: ${JSON.stringify(result, null, 2)}`
            );
        }
    }

    return result;
}
