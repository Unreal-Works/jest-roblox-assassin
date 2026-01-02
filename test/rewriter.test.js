import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import fs from "fs";
import path from "path";
import { ResultRewriter } from "../src/rewriter.js";

jest.mock("chalk", () => ({
    default: {
        bold: { red: (text) => text },
        green: (text) => text,
        red: (text) => text,
        gray: (text) => text,
        grey: (text) => text,
        cyan: (text) => text,
        white: (text) => text,
        magenta: (text) => text,
        yellow: (text) => text,
        dim: (text) => text,
    },
}));

describe("ResultRewriter", () => {
    let rewriter;
    const mockProjectRoot = "/workspace/project";
    const mockRootDir = "/workspace/project/src";
    const mockOutDir = "/workspace/project/out";

    const mockRojoProject = {
        root: mockProjectRoot,
        sourcemap: {
            name: "DataModel",
            filePaths: [],
            children: [
                {
                    name: "ReplicatedStorage",
                    filePaths: [],
                    children: [
                        {
                            name: "src",
                            filePaths: [],
                            children: [
                                {
                                    name: "test",
                                    filePaths: [
                                        path.join(mockOutDir, "test.luau"),
                                    ],
                                    children: [],
                                },
                            ],
                        },
                    ],
                },
            ],
        },
    };

    const mockCompilerOptions = {
        rootDir: mockRootDir,
        outDir: mockOutDir,
    };

    beforeEach(() => {
        jest.clearAllMocks();

        // Mock fs.existsSync to return false by default
        jest.spyOn(fs, "existsSync").mockReturnValue(false);
        jest.spyOn(fs, "readFileSync").mockReturnValue("");

        rewriter = new ResultRewriter({
            rojoProject: mockRojoProject,
            compilerOptions: mockCompilerOptions,
        });
    });

    describe("constructor", () => {
        it("should initialize with correct properties", () => {
            expect(rewriter.rojoProject).toBe(mockRojoProject);
            expect(rewriter.compilerOptions).toBe(mockCompilerOptions);
        });

        it("should build module path map from sourcemap", () => {
            expect(rewriter.modulePathMap).toBeInstanceOf(Map);
            expect(
                rewriter.modulePathMap.has("ReplicatedStorage.src.test")
            ).toBe(true);
        });
    });

    describe("readLines", () => {
        it("should return empty array for non-existent file", () => {
            fs.existsSync.mockReturnValue(false);
            const result = rewriter.readLines("/nonexistent.ts");
            expect(result).toEqual([]);
        });

        it("should read and cache file lines", () => {
            fs.existsSync.mockReturnValue(true);
            fs.readFileSync.mockReturnValue("line1\nline2\nline3");

            const result = rewriter.readLines("/test.ts");
            expect(result).toEqual(["line1", "line2", "line3"]);
            expect(rewriter.fileCache.has("/test.ts")).toBe(true);
        });
    });

    describe("findSourceLine", () => {
        it("should return same line number when files dont exist", () => {
            const result = rewriter.findSourceLine(
                "/luau.luau",
                "/source.ts",
                10
            );
            expect(result).toBe(10);
        });

        it("should find exact matching line", () => {
            fs.existsSync.mockReturnValue(true);
            fs.readFileSync
                .mockReturnValueOnce("line1\n  const x = 5;\nline3")
                .mockReturnValueOnce("other\n  const x = 5;\nother");

            const result = rewriter.findSourceLine(
                "/luau.luau",
                "/source.ts",
                2
            );
            expect(result).toBe(2);
        });
    });

    describe("formatPath", () => {
        it("should format path relative to current working directory", () => {
            const cwd = process.cwd();
            const testPath = path.join(cwd, "src", "test.ts");
            const result = rewriter.formatPath(testPath);
            expect(result).toBe("src/test.ts");
        });
    });

    describe("mapDatamodelFrame", () => {
        it("should return undefined for unknown datamodel path", () => {
            const result = rewriter.mapDatamodelFrame("Unknown.Path", 10);
            expect(result).toBeUndefined();
        });

        it("should map known datamodel path to source location", () => {
            const luauPath = path.join(mockOutDir, "test.luau");
            const sourcePath = path.join(mockRootDir, "test.ts");

            rewriter.modulePathMap.set("ReplicatedStorage.src.test", {
                luauPath,
                sourcePath,
            });

            fs.existsSync.mockReturnValue(true);
            fs.readFileSync.mockReturnValue("line1\nline2\nline3");

            const result = rewriter.mapDatamodelFrame(
                "ReplicatedStorage.src.test",
                2
            );
            expect(result).toContain("test.ts");
            expect(result).toContain(":2");
        });
    });

    describe("rewriteStackString", () => {
        it("should rewrite datamodel paths in stack traces", () => {
            rewriter.modulePathMap.set("ReplicatedStorage.src.test", {
                luauPath: path.join(mockOutDir, "test.luau"),
                sourcePath: path.join(mockRootDir, "test.ts"),
            });

            fs.existsSync.mockReturnValue(true);
            fs.readFileSync.mockReturnValue("line1\nline2\nline3");

            const stack = "Error at ReplicatedStorage.src.test:2";
            const result = rewriter.rewriteStackString(stack);
            expect(result).toContain("test.ts:2");
        });
    });

    describe("datamodelPathToSourcePath", () => {
        it("should correctly remap nested paths with multiple separators", () => {
            const sourcePath = path.join(
                mockRootDir,
                "__tests__/afolder/myCompartmentalizedTests.spec.ts"
            );
            rewriter.modulePathMap.set(
                "ReplicatedStorage.src.__tests__.afolder.myCompartmentalizedTests.spec",
                {
                    luauPath: path.join(
                        mockOutDir,
                        "__tests__/afolder/myCompartmentalizedTests.spec.luau"
                    ),
                    sourcePath: sourcePath,
                }
            );

            const result = rewriter.datamodelPathToSourcePath(
                "__tests__/afolder/myCompartmentalizedTests.spec"
            );
            expect(result).toBe(sourcePath);
        });

        it("should handle backslashes in testFilePath", () => {
            const sourcePath = path.join(
                mockRootDir,
                "__tests__/afolder/myCompartmentalizedTests.spec.ts"
            );
            rewriter.modulePathMap.set(
                "ReplicatedStorage.src.__tests__.afolder.myCompartmentalizedTests.spec",
                {
                    luauPath: path.join(
                        mockOutDir,
                        "__tests__/afolder/myCompartmentalizedTests.spec.luau"
                    ),
                    sourcePath: sourcePath,
                }
            );

            const result = rewriter.datamodelPathToSourcePath(
                "__tests__\\afolder\\myCompartmentalizedTests.spec"
            );
            expect(result).toBe(sourcePath);
        });
    });

    describe("rewriteSuiteResult", () => {
        it("should rewrite test file path", () => {
            const sourcePath = path.join(mockRootDir, "test.ts");
            rewriter.modulePathMap.set("test", {
                luauPath: path.join(mockOutDir, "test.luau"),
                sourcePath: sourcePath,
            });

            const suite = {
                testFilePath: "test",
                testResults: [],
            };

            rewriter.rewriteSuiteResult(suite);
            expect(suite.testFilePath).toBe(path.resolve(sourcePath));
        });

        it("should add test locations with 0-based column", () => {
            const sourcePath = path.join(mockRootDir, "test.ts");
            const luauPath = path.join(mockOutDir, "test.luau");
            rewriter.modulePathMap.set("test", {
                luauPath,
                sourcePath,
            });

            const fileContent = [
                "describe(\"group\", () => {",
                "  it(\"does work\", () => {})",
                "});",
            ].join("\n");

            fs.existsSync.mockImplementation((p) => p === sourcePath);
            fs.readFileSync.mockImplementation((p) =>
                p === sourcePath ? fileContent : ""
            );

            const suite = {
                testFilePath: "test",
                testResults: [{ title: "does work" }],
            };

            rewriter.testLocationInResults = true;

            rewriter.rewriteSuiteResult(suite);

            expect(suite.testResults[0].location).toEqual({
                column: 2,
                line: 2,
            });
        });
    });

    describe("parseFrame", () => {
        it("should parse file path and line number", () => {
            fs.existsSync.mockReturnValue(true);
            const text = "Error at src/test.ts:42:10";
            const result = rewriter.parseFrame(text);

            expect(result).toBeDefined();
            expect(result.line).toBe(42);
            expect(result.column).toBe(10);
        });
    });

    describe("buildCodeFrame", () => {
        it("should build code frame with context lines", () => {
            fs.existsSync.mockReturnValue(true);
            fs.readFileSync.mockReturnValue(
                "line1\nline2\nline3\nline4\nline5"
            );

            const result = rewriter.buildCodeFrame("/test.ts", 3, 1, 1);
            expect(result).toBeDefined();
            expect(result).toContain("line2");
            expect(result).toContain("line3");
            expect(result).toContain("line4");
        });
    });

    describe("formatFailureMessage", () => {
        it("should format test headers with color", () => {
            const message = "  ● test name";
            const result = rewriter.formatFailureMessage(message);
            expect(result).toBeDefined();
        });
    });

    describe("highlightCode", () => {
        it("should highlight strings", () => {
            const code = 'const x = "hello";';
            const result = rewriter.highlightCode(code);
            expect(result).toBeDefined();
        });
    });

    describe("appendCodeFrames", () => {
        it("should append code frame to array of messages", () => {
            const messages = ["message1", "message2"];
            const frameText = "code frame";
            const result = rewriter.appendCodeFrames(messages, frameText);
            expect(result).toEqual([
                "message1\n\ncode frame",
                "message2\n\ncode frame",
            ]);
        });

        it("should return messages unchanged if not an array", () => {
            const messages = "single message";
            const frameText = "code frame";
            const result = rewriter.appendCodeFrames(messages, frameText);
            expect(result).toBe("single message");
        });

        it("should return messages unchanged if no frameText", () => {
            const messages = ["message1"];
            const result = rewriter.appendCodeFrames(messages, "");
            expect(result).toEqual(["message1"]);
        });
    });

    describe("injectCodeFrame", () => {
        it("should inject code frame and move stack traces below", () => {
            const text =
                "Error message\nsrc/test.ts:10\nanother line\nsrc/other.ts:20";
            const frame = { absPath: "/path/test.ts", line: 10, column: 1 };
            const codeFrame = "  > 10 | const x = 5;";
            const result = rewriter.injectCodeFrame(text, frame, codeFrame);
            expect(result).toContain("Error message\nanother line");
            expect(result).toContain("  > 10 | const x = 5;");
            expect(result).toContain("src/test.ts:10\nsrc/other.ts:20");
        });

        it("should return text unchanged if no frame", () => {
            const text = "Error message";
            const result = rewriter.injectCodeFrame(text, null, "code frame");
            expect(result).toBe("Error message");
        });

        it("should return text unchanged if no codeFrame", () => {
            const text = "Error message";
            const frame = { absPath: "/path/test.ts", line: 10, column: 1 };
            const result = rewriter.injectCodeFrame(text, frame, "");
            expect(result).toBe("Error message");
        });

        it("should handle text with no stack lines", () => {
            const text = "Error message\nsome text";
            const frame = { absPath: "/path/test.ts", line: 10, column: 1 };
            const codeFrame = "code frame";
            const result = rewriter.injectCodeFrame(text, frame, codeFrame);
            expect(result).toBe("Error message\nsome text\n\ncode frame\n\n");
        });
    });

    describe("rewriteParsedResults", () => {
        it("should rewrite multiple test suites", () => {
            const suite1 = { testFilePath: "test1", failureMessage: "error1" };
            const suite2 = { testFilePath: "test2", failureMessage: "error2" };
            const results = { testResults: [suite1, suite2] };

            // Mock the methods called
            jest.spyOn(rewriter, "formatPath").mockReturnValue(
                "formatted/path"
            );
            jest.spyOn(rewriter, "datamodelPathToSourcePath").mockReturnValue(
                "/source/path"
            );
            jest.spyOn(rewriter, "rewriteStackString").mockImplementation(
                (str) => `rewritten ${str}`
            );
            jest.spyOn(rewriter, "parseFrame").mockReturnValue(null); // No frame for simplicity
            jest.spyOn(rewriter, "formatFailureMessage").mockImplementation(
                (str) => `formatted ${str}`
            );

            rewriter.rewriteParsedResults(results);

            expect(rewriter.datamodelPathToSourcePath).toHaveBeenCalledWith(
                "test1"
            );
            expect(rewriter.datamodelPathToSourcePath).toHaveBeenCalledWith(
                "test2"
            );
            expect(suite1.testFilePath).not.toBe("formatted/path");
            expect(suite2.testFilePath).not.toBe("formatted/path");
            expect(suite1.failureMessage).toBe("formatted rewritten error1");
            expect(suite2.failureMessage).toBe("formatted rewritten error2");
        });

        it("should handle empty results", () => {
            const results = {};
            rewriter.rewriteParsedResults(results);
            expect(results).toEqual({});
        });

        it("should handle results with empty testResults", () => {
            const results = { testResults: [] };
            rewriter.rewriteParsedResults(results);
            expect(results.testResults).toEqual([]);
        });

        it("should handle null results", () => {
            rewriter.rewriteParsedResults(null);
            // Should not throw
        });
    });
});
