import { describe, expect, it, jest } from "@jest/globals";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import util from "util";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

jest.unstable_mockModule("rbxluau", () => ({
    executeLuau: async (luauScript, luauOptions) => {
        // Check if the place is the demo place
        if (luauOptions.place.includes("demo_place.rbxl")) {
            let jestOptions = {};
            // Manually search through the Luau script to reverse engineer the options
            const match = luauScript.match(
                /local jestOptions = game:GetService\("HttpService"\):JSONDecode\((.*?)\)/s
            );
            if (match) {
                jestOptions = JSON.parse(
                    match[1].substring(5, match[1].length - 5)
                );
            }

            let fileToUse = "demo_default_output.txt";

            if (jestOptions.debug) {
                fileToUse = "demo_default_debug.txt";
            }

            if (jestOptions.passWithNoTests) {
                fileToUse = "demo_default_passWithNoTests.txt";
            }

            // Write to out
            fs.writeFileSync(
                luauOptions.out,
                fs.readFileSync(
                    path.join(__dirname, "dummy", fileToUse),
                    "utf-8"
                )
            );
        }

        return 0;
    },
}));

const runJestRoblox = (await import("../src/runJestRoblox.js")).default;

dotenv.config({ quiet: true });

describe("runJestRoblox.js", () => {
    it("should exit gracefully if --place file is missing", async () => {
        const consoleErrorSpy = jest
            .spyOn(console, "error")
            .mockImplementation(() => {});
        const exitCode = await runJestRoblox({
            place: "nonexistent_place.rbxl",
        });
        expect(exitCode).toBe(1);
        expect(consoleErrorSpy).toHaveBeenCalled();
        consoleErrorSpy.mockRestore();
    });

    it("should exit gracefully if config file is missing", async () => {
        const consoleErrorSpy = jest
            .spyOn(console, "error")
            .mockImplementation(() => {});
        const exitCode = await runJestRoblox({
            place: path.join(__dirname, "dummy", "demo_place.rbxl"),
            config: "nonexistent_config.js",
        });
        expect(exitCode).toBe(1);
        expect(consoleErrorSpy).toHaveBeenCalledWith(
            expect.stringContaining("Config file not found")
        );
        consoleErrorSpy.mockRestore();
    });

    it("should handle --json option", async () => {
        const buffer = [];
        const consoleLogSpy = jest
            .spyOn(console, "log")
            .mockImplementation((...args) => buffer.push(...args));
        const stdOutSpy = jest
            .spyOn(process.stdout, "write")
            .mockImplementation(() => {});
        const stdErrSpy = jest
            .spyOn(process.stderr, "write")
            .mockImplementation(() => {});

        const exitCode = await runJestRoblox({
            place: path.join(__dirname, "dummy", "demo_place.rbxl"),
            project: path.join(__dirname, "..", "demo", "default.project.json"),
            tsconfig: path.join(__dirname, "..", "demo", "tsconfig.json"),
            json: true,
        });

        expect(exitCode).toBe(1);
        const output = buffer.join(" ");
        expect(output).toContain("numPassedTests");
        expect(output).toContain("numFailedTests");
        expect(output).toContain("testResults");

        consoleLogSpy.mockRestore();
        stdOutSpy.mockRestore();
        stdErrSpy.mockRestore();
    });

    it("should handle --debug option", async () => {
        const buffer = [];
        const consoleLogSpy = jest
            .spyOn(console, "log")
            .mockImplementation((...args) => buffer.push(...args));
        const stdOutSpy = jest
            .spyOn(process.stdout, "write")
            .mockImplementation(() => {});
        const stdErrSpy = jest
            .spyOn(process.stderr, "write")
            .mockImplementation(() => {});

        const exitCode = await runJestRoblox({
            place: path.join(__dirname, "dummy", "demo_place.rbxl"),
            project: path.join(__dirname, "..", "demo", "default.project.json"),
            tsconfig: path.join(__dirname, "..", "demo", "tsconfig.json"),
            debug: true,
        });

        expect(exitCode).toBe(1);
        const output = buffer.join(" ");
        expect(output).toContain("globalConfig");
        expect(output).toContain("version");

        consoleLogSpy.mockRestore();
        stdOutSpy.mockRestore();
        stdErrSpy.mockRestore();
    });

    it("should handle --passWithNoTests option", async () => {
        const consoleLogSpy = jest
            .spyOn(console, "log")
            .mockImplementation(() => {});
        const consoleWarnSpy = jest
            .spyOn(console, "warn")
            .mockImplementation(() => {});
        const stdOutSpy = jest
            .spyOn(process.stdout, "write")
            .mockImplementation(() => {});
        const stdErrSpy = jest
            .spyOn(process.stderr, "write")
            .mockImplementation(() => {});

        const exitCode = await runJestRoblox({
            place: path.join(__dirname, "dummy", "demo_place.rbxl"),
            project: path.join(__dirname, "..", "demo", "default.project.json"),
            tsconfig: path.join(__dirname, "..", "demo", "tsconfig.json"),
            passWithNoTests: true,
            testPathPattern: "nonexistent_pattern_xyz",
            json: true,
        });

        // Since we filter to nonexistent pattern, there should be no tests
        // With passWithNoTests, should exit 0
        expect(exitCode).toBe(0);

        consoleLogSpy.mockRestore();
        consoleWarnSpy.mockRestore();
        stdOutSpy.mockRestore();
        stdErrSpy.mockRestore();
    });

    it("should respect JEST_TEST_NAME_PATTERN env var", async () => {
        const originalEnv = process.env.JEST_TEST_NAME_PATTERN;
        process.env.JEST_TEST_NAME_PATTERN = "specific test name";

        const buffer = [];
        const stdOutSpy = jest
            .spyOn(process.stdout, "write")
            .mockImplementation((...args) => buffer.push(...args));
        const stdErrSpy = jest
            .spyOn(process.stderr, "write")
            .mockImplementation((...args) => buffer.push(...args));

        await runJestRoblox({
            place: path.join(__dirname, "dummy", "demo_place.rbxl"),
            project: path.join(__dirname, "..", "demo", "default.project.json"),
            tsconfig: path.join(__dirname, "..", "demo", "tsconfig.json"),
        });

        // Restore env var
        if (originalEnv) {
            process.env.JEST_TEST_NAME_PATTERN = originalEnv;
        } else {
            delete process.env.JEST_TEST_NAME_PATTERN;
        }

        stdOutSpy.mockRestore();
        stdErrSpy.mockRestore();
    });

    it("should handle custom reporters gracefully when they don't exist", async () => {
        const consoleWarnSpy = jest
            .spyOn(console, "warn")
            .mockImplementation(() => {});
        const stdOutSpy = jest
            .spyOn(process.stdout, "write")
            .mockImplementation(() => {});
        const stdErrSpy = jest
            .spyOn(process.stderr, "write")
            .mockImplementation(() => {});

        const exitCode = await runJestRoblox({
            place: path.join(__dirname, "dummy", "demo_place.rbxl"),
            project: path.join(__dirname, "..", "demo", "default.project.json"),
            tsconfig: path.join(__dirname, "..", "demo", "tsconfig.json"),
            reporters: ["nonexistent-reporter"],
        });

        expect(consoleWarnSpy).toHaveBeenCalledWith(
            expect.stringContaining("Failed to load reporter module")
        );

        consoleWarnSpy.mockRestore();
        stdOutSpy.mockRestore();
        stdErrSpy.mockRestore();
    });

    it("should handle 'default' and 'summary' reporter names", async () => {
        const buffer = [];
        const stdOutSpy = jest
            .spyOn(process.stdout, "write")
            .mockImplementation((...args) => buffer.push(...args));
        const stdErrSpy = jest
            .spyOn(process.stderr, "write")
            .mockImplementation((...args) => buffer.push(...args));

        const exitCode = await runJestRoblox({
            place: path.join(__dirname, "dummy", "demo_place.rbxl"),
            project: path.join(__dirname, "..", "demo", "default.project.json"),
            tsconfig: path.join(__dirname, "..", "demo", "tsconfig.json"),
            reporters: ["default", "summary"],
        });

        expect(exitCode).toBe(1);

        stdOutSpy.mockRestore();
        stdErrSpy.mockRestore();
    });

    it("should run tests with valid --place file", async () => {
        const requiredMatches = [
            " FAIL  src/__tests__/add.spec.ts",
            "fails when expecting 5 + 5 to equal 30",
            "    Expected: 30",
            "    Received: 10",
            `describe("add", () => {`,
            `it("fails when expecting 5 + 5 to equal 30", () => {`,
            `expect(5 + 5).toBe(30);`,
            `it("fails when expecting 10 + 15 to equal 20", () => {`,
            "src/__tests__/add.spec.ts:6",
            "node_modules/@rbxts-js/jest-circus/src/circus/utils.lua",
            " PASS  src/__tests__/afolder/myCompartmentalizedTests.spec.ts",
            " PASS  src/__tests__/div.spec.ts",
            " FAIL  src/__tests__/mul.spec.ts",
            " PASS  src/__tests__/myModule.spec.ts",
            " FAIL  src/__tests__/sub.spec.luau",
            "fails when expecting 9 - 2 to equal 8",
            `it("fails when expecting 9 - 2 to equal 8", function()`,
            `expect(9 - 2).toBe(8)`,
            "src/__tests__/sub.spec.luau:19",
            " FAIL  src/anothertestproject/ilovetesting.spec.ts",
            "src/anothertestproject/ilovetesting.spec.ts:6",
            "Test Suites: 4 failed, 3 passed, 7 total",
            "Tests:       7 failed, 11 passed, 18 total",
            "Snapshots:   0 total",
            "Ran all test suites.",
        ];

        const found = new Set();
        const buffer = [];
        const stdOutSpy = jest
            .spyOn(process.stdout, "write")
            .mockImplementation((...args) => buffer.push(...args));
        const stdErrSpy = jest
            .spyOn(process.stderr, "write")
            .mockImplementation((...args) => buffer.push(...args));

        const exitCode = await runJestRoblox({
            place: path.join(__dirname, "dummy", "demo_place.rbxl"),
            project: path.join(__dirname, "..", "demo", "default.project.json"),
            tsconfig: path.join(__dirname, "..", "demo", "tsconfig.json"),
        });
        expect(exitCode).toBe(1); // The demo tests are designed to fail

        const message = util.stripVTControlCharacters(buffer.join(" "));

        for (const match of requiredMatches) {
            if (message.includes(match)) {
                found.add(match);
            }
        }

        expect(found.size).toBe(requiredMatches.length);
        stdOutSpy.mockRestore();
        stdErrSpy.mockRestore();
    });
});
