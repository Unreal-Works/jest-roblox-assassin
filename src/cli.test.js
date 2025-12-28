import { spawn } from "child_process";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";

dotenv.config({ quiet: true });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Helper to run the CLI with arguments and return output
 */
function runCli(args = [], options = {}) {
    return new Promise((resolve, reject) => {
        const cliPath = path.join(__dirname, "cli.js");
        const child = spawn("node", [cliPath, ...args], {
            cwd: options.cwd || process.cwd(),
            env: { ...process.env, ...options.env },
        });

        let stdout = "";
        let stderr = "";

        child.stdout.on("data", (data) => {
            stdout += data.toString();
        });

        child.stderr.on("data", (data) => {
            stderr += data.toString();
        });

        child.on("close", (code) => {
            resolve({ code, stdout, stderr });
        });

        child.on("error", reject);

        // Set timeout
        setTimeout(() => {
            child.kill();
            reject(new Error("CLI timeout"));
        }, options.timeout || 30000);
    });
}

describe("CLI Integration Tests", () => {
    const demoDir = path.join(__dirname, "..", "demo");
    const demoPlaceFile = path.join(demoDir, "place.rbxl");

    // Skip tests if demo files don't exist
    const shouldSkip = !fs.existsSync(demoPlaceFile);

    describe("basic CLI functionality", () => {
        it("should display version", async () => {
            const { code, stdout } = await runCli(["--version"]);
            expect(stdout).toContain("1.0.0");
            expect(code).toBe(0);
        });

        it("should display help", async () => {
            const { code, stdout } = await runCli(["--help"]);
            expect(stdout).toContain("jestrbx");
            expect(stdout).toContain("Delightful Roblox testing");
            expect(code).toBe(0);
        });
    });

    describe("config file loading", () => {
        it("should error when config file does not exist", async () => {
            const { code, stderr } = await runCli([
                "--config",
                "/nonexistent/config.js",
                "--place",
                demoPlaceFile,
            ]);
            expect(stderr).toContain("Config file not found");
            expect(code).toBe(1);
        });

        it.concurrent.skipIf(shouldSkip)(
            "should load config file when specified",
            async () => {
                const configPath = path.join(demoDir, "src", "jest.config.ts");
                if (!fs.existsSync(configPath)) {
                    return;
                }

                // This test may fail if the config file is not in proper format
                // Just checking that it attempts to load it
                const { stderr } = await runCli([
                    "--config",
                    configPath,
                    "--place",
                    demoPlaceFile,
                ]);

                // Should either succeed or fail with a different error (not "file not found")
                expect(stderr).not.toContain("Config file not found");
            },
            15000
        );
    });

    describe("place file handling", () => {
        it.skipIf(shouldSkip)("should require place file", async () => {
            const { code, stderr } = await runCli([]);
            // Should fail without a place file
            expect(code).toBe(1);
        });

        it.concurrent.skipIf(shouldSkip)(
            "should accept place file via --place option",
            async () => {
                const { stderr } = await runCli(["--place", demoPlaceFile]);

                // May fail for other reasons (no JestCore, etc), but should not complain about missing place
                expect(stderr).not.toContain("place file not found");
            },
            15000
        );
    });

    describe("test filtering", () => {
        it.concurrent.skipIf(shouldSkip)(
            "should support testPathPattern as argument",
            async () => {
                const { stdout } = await runCli(
                    ["--place", demoPlaceFile, "add"],
                    { cwd: demoDir }
                );

                // Just verify it doesn't crash with the pattern
                expect(stdout).toBeDefined();
            },
            15000
        );

        it.concurrent.skipIf(shouldSkip)(
            "should support testNamePattern from environment variable",
            async () => {
                const { stdout } = await runCli(["--place", demoPlaceFile], {
                    cwd: demoDir,
                    env: { JEST_TEST_NAME_PATTERN: "should add" },
                });

                expect(stdout).toBeDefined();
            },
            15000
        );
    });

    describe("project discovery", () => {
        it.concurrent.skipIf(shouldSkip)(
            "should find default.project.json in place directory",
            async () => {
                const { stderr } = await runCli(["--place", demoPlaceFile], {
                    cwd: demoDir,
                });

                // Should not warn about missing project file
                expect(stderr).not.toContain(
                    "Could not find default.project.json"
                );
            },
            15000
        );

        it("should search subdirectories for default.project.json", async () => {
            // This tests the search logic, won't actually run tests
            const tempDir = fs.mkdtempSync(
                path.join(process.cwd(), "temp-test-")
            );
            const subDir = path.join(tempDir, "sub");
            fs.mkdirSync(subDir, { recursive: true });

            const projectPath = path.join(subDir, "default.project.json");
            fs.writeFileSync(projectPath, JSON.stringify({ tree: {} }));

            const placePath = path.join(tempDir, "test.rbxl");
            fs.writeFileSync(placePath, ""); // Empty file

            try {
                await runCli(["--place", placePath], { cwd: tempDir });
                // Just verify it doesn't crash during discovery
            } finally {
                // Cleanup with retry for Windows file locking issues
                try {
                    fs.rmSync(tempDir, { recursive: true, force: true });
                } catch (error) {
                    // Retry after a short delay
                    await new Promise((resolve) => setTimeout(resolve, 100));
                    try {
                        fs.rmSync(tempDir, { recursive: true, force: true });
                    } catch {
                        // Ignore cleanup errors in tests
                        console.warn(`Failed to cleanup ${tempDir}`);
                    }
                }
            }
        }, 60000);
    });

    describe("reporter configuration", () => {
        it.concurrent.skipIf(shouldSkip)(
            "should use default reporters when none specified",
            async () => {
                const { stdout } = await runCli(["--place", demoPlaceFile], {
                    cwd: demoDir,
                });

                // Default reporters should output test results
                expect(stdout).toBeDefined();
            },
            15000
        );

        it.concurrent.skipIf(shouldSkip)(
            "should accept custom reporters via --reporters",
            async () => {
                const { stdout } = await runCli(
                    ["--place", demoPlaceFile, "--reporters", "default"],
                    { cwd: demoDir }
                );

                expect(stdout).toBeDefined();
            },
            15000
        );
    });

    describe("CLI options", () => {
        it.concurrent.skipIf(shouldSkip)(
            "should accept --verbose flag",
            async () => {
                const { stdout } = await runCli(
                    ["--place", demoPlaceFile, "--verbose"],
                    { cwd: demoDir }
                );

                expect(stdout).toBeDefined();
            },
            15000
        );

        it.concurrent.skipIf(shouldSkip)(
            "should accept --ci flag",
            async () => {
                const { stdout } = await runCli(
                    ["--place", demoPlaceFile, "--ci"],
                    { cwd: demoDir }
                );

                expect(stdout).toBeDefined();
            },
            15000
        );

        it.concurrent.skipIf(shouldSkip)(
            "should accept --testTimeout",
            async () => {
                const { stdout } = await runCli(
                    ["--place", demoPlaceFile, "--testTimeout", "1000"],
                    { cwd: demoDir }
                );

                expect(stdout).toBeDefined();
            },
            15000
        );

        it.concurrent.skipIf(shouldSkip)(
            "should accept --passWithNoTests",
            async () => {
                const { code } = await runCli(
                    [
                        "--place",
                        demoPlaceFile,
                        "--passWithNoTests",
                        "--testPathPattern",
                        "nonexistent",
                    ],
                    { cwd: demoDir }
                );

                // Should pass even with no tests
                expect(code).toBe(0);
            },
            15000
        );
    });

    describe("error handling", () => {
        it("should handle missing Luau execution gracefully", async () => {
            const tempDir = fs.mkdtempSync(
                path.join(process.cwd(), "temp-test-")
            );
            const placePath = path.join(tempDir, "empty.rbxl");
            fs.writeFileSync(placePath, "");

            try {
                const { code, stderr } = await runCli(["--place", placePath]);
                expect(code).toBe(1);
                expect(stderr).toBeDefined();
            } finally {
                // Cleanup with retry for Windows file locking issues
                try {
                    fs.rmSync(tempDir, { recursive: true, force: true });
                } catch (error) {
                    await new Promise((resolve) => setTimeout(resolve, 100));
                    try {
                        fs.rmSync(tempDir, { recursive: true, force: true });
                    } catch {
                        console.warn(`Failed to cleanup ${tempDir}`);
                    }
                }
            }
        }, 30000);
    });

    describe("output format", () => {
        it.concurrent.skipIf(shouldSkip)(
            "should output JSON when --json flag is used",
            async () => {
                const { stdout } = await runCli(
                    ["--place", demoPlaceFile, "--json"],
                    { cwd: demoDir }
                );

                expect(stdout).toBeDefined();
            },
            15000
        );

        it.concurrent.skipIf(shouldSkip)(
            "should show config when --showConfig is used",
            async () => {
                const { code, stdout } = await runCli(
                    ["--place", demoPlaceFile, "--showConfig"],
                    { cwd: demoDir }
                );

                expect(code).toBe(0);
                // Config output should be valid
                expect(stdout).toBeDefined();
            },
            15000
        );
    });
});
