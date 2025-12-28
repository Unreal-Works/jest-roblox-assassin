#!/usr/bin/env node

import { TestPathPatterns } from "@jest/pattern";
import { DefaultReporter, SummaryReporter } from "@jest/reporters";
import dotenv from "dotenv";
import fs from "fs";
import path, { dirname } from "path";
import * as rbxluau from "rbxluau";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const outputPath = path.join(__dirname, "luau_output.log");

// Load environment variables from .env file
dotenv.config({ quiet: true });

// Parse command line arguments
const args = process.argv.slice(2);
let placeFile = undefined;
for (let i = 0; i < args.length; i++) {
    if (args[i] === "--place" && i + 1 < args.length) {
        placeFile = args[i + 1];
        i++; // Skip the next argument since we used it
    }
}

// Get test filter from environment variable (set by VS Code extension)
const testNamePattern = process.env.JEST_TEST_NAME_PATTERN || "";

const testPathPatterns = new TestPathPatterns(
    testNamePattern ? [testNamePattern] : []
);

// Build the Luau script with optional test filter
let luauScript = `
local jestOptions = {}
jestOptions.testNamePattern = ${
    testNamePattern
        ? `"${testNamePattern.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
        : undefined
}

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

// Fix globalConfig - set rootDir to current working directory if null
const globalConfig = {
    ...parsedResults.globalConfig,
    rootDir: parsedResults.globalConfig.rootDir || process.cwd(),
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
