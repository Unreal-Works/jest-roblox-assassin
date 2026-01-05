import { TestPathPatterns } from "@jest/pattern";
import {
    DefaultReporter,
    SummaryReporter,
    VerboseReporter,
} from "@jest/reporters";
import fs from "fs";
import libCoverage from "istanbul-lib-coverage";
import libReport from "istanbul-lib-report";
import reports from "istanbul-reports";
import fetch from "node-fetch";
import path from "path";
import process from "process";
import { executeLuau } from "rbxluau";
import { pathToFileURL } from "url";
import { zstdDecompressSync } from "zlib";
import { ensureCache } from "./cache.js";
import {
    discoverCompilerOptions,
    discoverRojoProject,
    discoverTestFilesFromFilesystem,
    findPlaceFile,
} from "./discovery.js";
import { ResultRewriter } from "./rewriter.js";

/**
 * Executes JestRoblox with the given options, collects results and outputs them using reporters.
 * The options can also affect the behavior of what is done with the results.
 * @param {object} options The CLI options to run JestRoblox with.
 * @returns {Promise<number>} Exit code (0 for success, 1 for failure).
 */
export default async function runJestRoblox(options) {
    // Discover place file if not specified
    if (!options.place) {
        options.place = findPlaceFile();
    }
    if (!options.place) {
        console.error(
            "--place option is required to run tests. No .rbxl or .rbxlx file found in current directory or nearby."
        );
        return 1;
    }
    if (!fs.existsSync(options.place)) {
        console.error("Invalid --place file specified: " + options.place);
        return 1;
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
    const compilerOptions = discoverCompilerOptions(options.tsconfig);
    const rewriter = new ResultRewriter({
        compilerOptions,
        rojoProject,
        testLocationInResults: options.testLocationInResults,
    });

    // Convert coveragePathIgnorePatterns from source paths to datamodel paths
    let coverageIgnoreDatamodelPatterns = [];
    if (
        options.coveragePathIgnorePatterns &&
        Array.isArray(options.coveragePathIgnorePatterns)
    ) {
        if (options.debug) {
            console.log(
                "Source coverage ignore patterns:",
                options.coveragePathIgnorePatterns
            );
        }
        coverageIgnoreDatamodelPatterns =
            rewriter.convertSourcePatternsToDatamodelPatterns(
                options.coveragePathIgnorePatterns
            );
        if (options.debug && coverageIgnoreDatamodelPatterns.length > 0) {
            console.log(
                "Coverage ignore patterns (datamodel):",
                coverageIgnoreDatamodelPatterns
            );
        }
    }

    const actualStartTime = Date.now();
    let parsedResults;

    if (options.showConfig) {
        console.log(
            (
                await executeLuauTest({
                    ...options,
                    coverageIgnoreDatamodelPatterns,
                })
            ).config
        );
        return 0;
    }

    if (options.listTests) {
        const result = JSON.parse(
            await executeLuauTest({
                ...options,
                coverageIgnoreDatamodelPatterns,
            })
        );
        const reconstructed = [];
        for (const testPath of result)
            reconstructed.push(rewriter.datamodelPathToSourcePath(testPath));

        if (options.json) {
            const out = JSON.stringify(reconstructed);
            if (options.outputFile) {
                fs.writeFileSync(options.outputFile, out, "utf-8");
            } else {
                console.log(out);
            }
        } else {
            for (const testPath of reconstructed) {
                console.log(testPath);
            }
        }
        return 0;
    }

    // Check if we should use parallel execution
    const maxWorkers = options.maxWorkers || 1;
    const useParallel = maxWorkers > 1;
    const executeSingleWorker = async () => {
        return (
            (await executeLuauTest({
                ...options,
                coverageIgnoreDatamodelPatterns,
            })) ?? { exit: 1 }
        );
    };

    if (useParallel && !options.testPathPattern) {
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
        } else if (testSuites.length <= 1) {
            // Only one test suite, run single worker
            parsedResults = await executeSingleWorker();
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
                        coverageIgnoreDatamodelPatterns,
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

                    return await executeLuauTest(workerOptions);
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
        parsedResults = await executeSingleWorker();
    }

    if (parsedResults.exit !== undefined) return parsedResults.exit;

    rewriter.rewriteParsedResults(parsedResults.results);

    // Rewrite coverage paths if coverage data is available
    if (parsedResults.coverage) {
        parsedResults.coverage = rewriter.rewriteCoverageData(
            parsedResults.coverage
        );
    }

    if (options.passWithNoTests && parsedResults.results.numTotalTests === 0) {
        parsedResults.results.success = true;
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
                    // Convert absolute paths to file URLs for ESM loader compatibility
                    let moduleToImport = reporterName;
                    if (path.isAbsolute(reporterName)) {
                        moduleToImport = pathToFileURL(reporterName).href;
                    }
                    const ReporterModule = await import(moduleToImport);
                    if (ReporterModule) {
                        reporterConfigs.push({
                            Reporter: ReporterModule.default ?? ReporterModule,
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
        reporterConfigs.push({
            Reporter: options.verbose ? VerboseReporter : DefaultReporter,
            options: undefined,
        });
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

    // Generate coverage reports if coverage data is available
    if (parsedResults.coverage) {
        await generateCoverageReports(parsedResults.coverage, options);
    }

    if (options.json) {
        const json = JSON.stringify(rewriter.json(parsedResults));
        if (options.outputFile) {
            fs.writeFileSync(options.outputFile, json, "utf-8");
            console.log(`Test results written to: ${options.outputFile}`);
        } else {
            console.log(json);
        }
        // Handle early exit signals (e.g., "No tests found" with passWithNoTests)
        if (parsedResults.exit !== undefined) {
            return parsedResults.exit;
        }
        return parsedResults.results.success ? 0 : 1;
    }

    return parsedResults.results.success ? 0 : 1;
}

/**
 * Executes the Luau script to run Jest tests with the given options.
 * @param {object} options The Jest options to pass to the Luau script.
 * @returns {Promise<any>} The parsed results from the Luau script.
 */
async function executeLuauTest(options) {
    const cachePath = ensureCache();
    const randomHash = options.debug
        ? "debug"
        : Math.random().toString(36).substring(2, 8);
    const luauOutputPath = path.join(
        cachePath,
        `luau_output_${randomHash}.log`
    );

    const resultSplitMarker = `__JEST_RESULT_START__`;

    const luauScript = `
local HttpService = game:GetService("HttpService")
local jestOptions = HttpService:JSONDecode([===[${JSON.stringify(options)}]===])
-- These options are handled in JS
jestOptions.reporters = {}
jestOptions.json = jestOptions.listTests == true
jestOptions.watch = nil
jestOptions.watchAll = nil

local coverage
local runCLI
local projects = {}
local testFiles = {}
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
    elseif v.Name == "coverage" and v:FindFirstChild("src") then
        local coverageCandidate = require(v.src)
        if coverageCandidate and coverageCandidate.instrument then
            coverage = coverageCandidate
        end
    elseif v.Name:find(".spec") or v.Name:find(".test") then
        table.insert(testFiles, v)
    end
end

if not runCLI then
    error("Could not find JestCore CLI module")
end
if #projects == 0 then
    error("Could not find any jest.config modules")
end

pcall(function()
    settings().Studio.ScriptTimeoutLength = -1 -- Disable script timeout
end)

local runningCoverage = false
if jestOptions.coverage or jestOptions.collectCoverage then
    if coverage then
        local instrumentStartTime = os.clock()
        runningCoverage = true
        
        -- Build list of exclusions for coverage
        local ignorePatterns = jestOptions.coverageIgnoreDatamodelPatterns or {}
        if #ignorePatterns == 0 then
            table.insert(ignorePatterns, "ReplicatedStorage.rbxts_include")
        end

        local moduleExclusions = {}
        
        -- Helper function to check if a path should be ignored
        local function shouldIgnorePath(fullName)
            -- Check against user-specified ignore patterns
            for _, pattern in ipairs(ignorePatterns) do
                -- Support both exact matches and directory prefix matches
                -- e.g., "ReplicatedStorage.src.shared" matches "ReplicatedStorage.src.shared.setupTests"
                if fullName:find(pattern, 1, true) then -- plain text search
                    return true
                end
                -- Also check if this is a child of a directory pattern
                if fullName:sub(1, #pattern + 1) == pattern .. "." then
                    return true
                end
            end
            
            return false
        end
        
        -- Scan all modules in the game and build exclusion list
        for _, descendant in ipairs(game:GetDescendants()) do
            if descendant:IsA("ModuleScript") and shouldIgnorePath(descendant:GetFullName()) then
                table.insert(moduleExclusions, descendant)
            end
        end
        
        if jestOptions.debug then
            if #ignorePatterns > 0 then
                print("Coverage ignore patterns: " .. table.concat(ignorePatterns, ", "))
            end
            if #moduleExclusions > 0 then
                print("Excluding " .. #moduleExclusions .. " modules from coverage")
            end
        end
        
        -- Instrument all sources (nil) except exclusions
        coverage.instrument(nil, moduleExclusions) -- TODO: support collectCoverageFrom
        if jestOptions.debug then
            print("Coverage instrumentation took " .. ((os.clock() - instrumentStartTime) * 1000) .. "ms")
        end
    else
        warn("Coverage requested but coverage module not found")
    end
end

local runCLIStartTime = os.clock()
local success, resolved = runCLI(game, jestOptions, projects):await()
if jestOptions.debug then
    print("runCLI took " .. ((os.clock() - runCLIStartTime) * 1000) .. "ms")
end

if jestOptions.showConfig or jestOptions.listTests then
    return 0
end

if resolved and type(resolved) == "table" then
    resolved.resolveSuccess = success
    if runningCoverage then
        resolved.coverage = coverage.istanbul()
    end
end

local payload = HttpService:JSONEncode(resolved)
local payloadSize = #payload

local EncodingService = game:GetService("EncodingService")
local bufferPayload = buffer.fromstring(payload)

local compressionStartTime = os.clock()
local compressed = EncodingService:CompressBuffer(bufferPayload, Enum.CompressionAlgorithm.Zstd, 9)
if jestOptions.debug then
    print("Compression took " .. ((os.clock() - compressionStartTime) * 1000) .. "ms")
end

print("${resultSplitMarker}")
if buffer.len(compressed) <= 4194304 then
    return compressed
end

if jestOptions.debug then
    print("Payload size " .. payloadSize .. " bytes exceeds 4MB, uploading to GitHub")
end

-- Direct return is not possible; send to user-specified github repo
local repo = "${process.env.JEST_ASSASSIN_PAYLOAD_REPO ?? ""}"
if not repo or repo == "" then
    error("Payload too large (" .. payloadSize .. " bytes) and no JEST_ASSASSIN_PAYLOAD_REPO specified")
end
local gh_token = "${process.env.JEST_ASSASSIN_GITHUB_TOKEN ?? ""}"
if not gh_token or gh_token == "" then
    error("Payload too large (" .. payloadSize .. " bytes) and no JEST_ASSASSIN_GITHUB_TOKEN specified")
end
local fileName = "${
        process.env.JEST_ASSASSIN_PAYLOAD_FILENAME ?? "jest_payload"
    }"
local url = "https://api.github.com/repos/" .. repo .. "/contents/" .. fileName

-- Obtain SHA of existing file if it exists
local existingSha
local getSuccess, getResponse = pcall(function()
    return HttpService:GetAsync(url, false, {
        ["Authorization"] = "token " .. gh_token
    })
end)
if getSuccess then
    existingSha = HttpService:JSONDecode(getResponse).sha
end

local putPayload = {
    message = "JestRoblox large payload upload",
    content = bufferPayload,
    branch = "main",
}
if existingSha then
    putPayload.sha = existingSha
end

local putSuccess, putResponse = pcall(function()
    return game:GetService("HttpService"):RequestAsync({
        Url = url,
        Method = "PUT",
        Headers = {
            ["Authorization"] = "token " .. gh_token,
            ["Content-Type"] = "application/json"
        },
        Body = HttpService:JSONEncode(putPayload)
    })
end)
if not putSuccess then
    error("Failed to upload large payload to GitHub: " .. putResponse)
end
if putResponse.Success ~= true then
    error("GitHub API returned error: " .. tostring(putResponse.StatusCode) .. " - " .. tostring(putResponse.Body))
end
return "__PAYLOAD_URL_START__" .. url .. "__PAYLOAD_URL_END__"
`;

    const luauExitCode = await executeLuau(luauScript, {
        place: options.place,
        silent: true,
        exit: false,
        timeout: options.timeout ?? 300,
        out: luauOutputPath,
    });

    const outputLog = fs.readFileSync(luauOutputPath, "utf-8");
    if (!options.debug) {
        // Clean up Luau output file
        try {
            fs.unlinkSync(luauOutputPath);
        } catch {
            // Ignore
        }
    }

    if (luauExitCode !== 0) {
        throw new Error(
            `Luau script execution failed with exit code: ${luauExitCode}\n${outputLog}`
        );
    }

    if (options.listTests) {
        return outputLog;
    }

    if (options.debug) {
        console.log(outputLog.split(resultSplitMarker)[0]);
    }

    if (options.showConfig) {
        const firstBrace = outputLog.indexOf("{");
        const lastMarker = outputLog.lastIndexOf(resultSplitMarker);
        // Find the last brace BEFORE the result marker, not the last brace in the entire output
        let lastBrace = -1;
        for (let i = lastMarker - 1; i >= 0; i--) {
            if (outputLog[i] === "}") {
                lastBrace = i;
                break;
            }
        }
        return {
            config:
                lastBrace !== -1 && firstBrace !== -1
                    ? outputLog.slice(firstBrace, lastBrace + 1)
                    : null,
        };
    }

    const resultMarkerSplit = outputLog.split(resultSplitMarker);
    if (resultMarkerSplit.length < 2) {
        throw new Error(`No result found in output log:\n${outputLog}`);
    }
    const [miscOutput, luauReturnRaw] = resultMarkerSplit;

    let jestPayloadRaw;
    const payloadUrlMatch = luauReturnRaw.match(
        /__PAYLOAD_URL_START__(.+?)__PAYLOAD_URL_END__/
    );
    const payloadUrl = payloadUrlMatch ? payloadUrlMatch[1] : null;
    if (payloadUrl) {
        // Fetch payload from GitHub
        const gh_token = process.env.JEST_ASSASSIN_GITHUB_TOKEN;
        if (!gh_token) {
            throw new Error(
                "Payload too large; JEST_ASSASSIN_GITHUB_TOKEN not specified"
            );
        }
        const payloadUrlResponse = await fetch(payloadUrl, {
            headers: {
                Authorization: `token ${gh_token}`,
            },
        });
        if (!payloadUrlResponse.ok)
            throw new Error(
                `Failed to fetch large payload from GitHub: ${payloadUrlResponse.status} ${payloadUrlResponse.statusText}`
            );

        const gitUrl = (await payloadUrlResponse.json()).git_url;
        if (!gitUrl)
            throw new Error(
                `Invalid response from GitHub when fetching payload: ${await payloadUrlResponse.text()}`
            );

        const gitResponse = await fetch(gitUrl, {
            headers: {
                Authorization: `token ${gh_token}`,
            },
        });
        if (!gitResponse.ok)
            throw new Error(
                `Failed to fetch large payload content from GitHub: ${gitResponse.status} ${gitResponse.statusText}`
            );

        const data = await gitResponse.json();
        if (!data.content)
            throw new Error(
                `Invalid content response from GitHub when fetching payload: ${await gitResponse.text()}`
            );

        jestPayloadRaw = Buffer.from(data.content, "base64").toString("utf-8");
    } else {
        jestPayloadRaw = luauReturnRaw;
    }

    if (miscOutput.includes("No tests found, exiting with code")) {
        const startIndex = miscOutput.indexOf(
            "No tests found, exiting with code"
        );
        // The marker is not in miscOutput (it was already split off), so just use the end of miscOutput
        const message = miscOutput.slice(startIndex).trim();
        console.log(message);
        return {
            exit: options.passWithNoTests ? 0 : 1,
        };
    }

    if (!jestPayloadRaw)
        throw new Error(`Failed to retrieve test results:\n${outputLog}`);

    let jestPayload = JSON.parse(jestPayloadRaw);
    if (!jestPayload)
        throw new Error(`Failed to parse test results:\n${jestPayloadRaw}`);

    if (jestPayload.t === "buffer") {
        const bufferData = Buffer.from(jestPayload.base64, "base64");
        jestPayload = zstdDecompressSync(bufferData).toString("utf-8");
        jestPayload = JSON.parse(jestPayload);
    }

    if (!jestPayload.resolveSuccess)
        throw new Error(`Failed to resolve test results:\n${jestPayloadRaw}`);

    return jestPayload;
}

/**
 * Generates coverage reports using Istanbul.
 * @param {object} coverageData The coverage data in Istanbul format.
 * @param {object} options The CLI options containing coverageDirectory.
 */
async function generateCoverageReports(coverageData, options) {
    const coverageDir = options.coverageDirectory || "coverage";
    const coverageFile = path.join(coverageDir, "coverage-final.json");

    // Create coverage directory if it doesn't exist
    if (!fs.existsSync(coverageDir)) {
        fs.mkdirSync(coverageDir, { recursive: true });
    }

    // Write coverage-final.json
    fs.writeFileSync(coverageFile, JSON.stringify(coverageData, null, 2));

    // Create coverage map
    const coverageMap = libCoverage.createCoverageMap(coverageData);

    // Create report context
    const context = libReport.createContext({
        dir: coverageDir,
        coverageMap: coverageMap,
        defaultSummarizer: "nested",
    });

    // Generate report formats
    const reportFormats = [
        "html",
        "text",
        "text-summary",
        "lcov",
        "json-summary",
        "json",
        "cobertura",
    ];

    for (const formatName of reportFormats) {
        try {
            const report = reports.create(formatName);
            report.execute(context);
        } catch (error) {
            if (options.verbose) {
                console.warn(
                    `Failed to generate ${formatName} coverage report: ${error.message}`
                );
            }
        }
    }

    if (options.verbose) {
        console.log(`Coverage reports generated in ${coverageDir}`);
    }
}
