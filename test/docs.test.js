import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    jest,
} from "@jest/globals";
import fs from "fs";
import path from "path";
import { getCliOptions } from "../src/docs.js";

// Mock fetch globally
global.fetch = jest.fn();
describe("docs.js", () => {
    const mockOptionsPath = path.join(process.cwd(), "src", "cli-options.json");

    beforeEach(() => {
        jest.clearAllMocks();
        jest.spyOn(fs, "existsSync").mockReturnValue(false);
        jest.spyOn(fs, "readFileSync").mockReturnValue("");
        jest.spyOn(fs, "writeFileSync").mockImplementation(() => {});
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    describe("getCliOptions", () => {
        it("should return cached options if file exists", async () => {
            const mockOptions = [
                {
                    name: "--verbose",
                    type: "[boolean]",
                    description: "Display verbose output",
                },
                {
                    name: "--ci",
                    type: "[boolean]",
                    description: "Run in CI mode",
                },
            ];

            fs.existsSync.mockReturnValue(true);
            fs.readFileSync.mockReturnValue(JSON.stringify(mockOptions));

            const result = await getCliOptions();

            expect(result).toEqual(mockOptions);
            expect(fs.existsSync).toHaveBeenCalledWith(
                expect.stringContaining("cli-options.json")
            );
            expect(fs.readFileSync).toHaveBeenCalled();
            expect(global.fetch).not.toHaveBeenCalled();
        });

        it("should fetch from docs URL if cache does not exist", async () => {
            const mockMarkdown = `
### \`verbose\` [boolean]

Display verbose output

### \`ci\` [boolean]

Run in CI mode
`;

            fs.existsSync.mockReturnValue(false);
            global.fetch.mockResolvedValue({
                ok: true,
                text: async () => mockMarkdown,
            });
            fs.writeFileSync.mockReturnValue(undefined);

            const result = await getCliOptions();

            expect(global.fetch).toHaveBeenCalled();
            expect(fs.writeFileSync).toHaveBeenCalled();
            expect(result).toBeInstanceOf(Array);
            expect(result.length).toBeGreaterThan(0);
        });

        it("should handle fetch errors gracefully", async () => {
            fs.existsSync.mockReturnValue(false);
            global.fetch.mockResolvedValue({
                ok: false,
                statusText: "Not Found",
            });

            jest.spyOn(console, "error").mockImplementation(() => {});
            const result = await getCliOptions();

            expect(result).toEqual([]);
        });

        it("should handle network errors", async () => {
            fs.existsSync.mockReturnValue(false);
            global.fetch.mockRejectedValue(new Error("Network error"));

            jest.spyOn(console, "error").mockImplementation(() => {});
            const result = await getCliOptions();

            expect(result).toEqual([]);
        });

        it("should handle corrupted cache file", async () => {
            const mockMarkdown = `
### \`verbose\` [boolean]

Display verbose output
`;

            fs.existsSync.mockReturnValue(true);
            fs.readFileSync.mockReturnValue("invalid json{");
            global.fetch.mockResolvedValue({
                ok: true,
                text: async () => mockMarkdown,
            });
            fs.writeFileSync.mockReturnValue(undefined);
            jest.spyOn(console, "warn").mockImplementation(() => {});
            const result = await getCliOptions();

            // Should fall back to fetching
            expect(global.fetch).toHaveBeenCalled();
            expect(result).toBeInstanceOf(Array);
        });

        it("should parse markdown with HTML entities", async () => {
            const mockMarkdown = `
### \`testTimeout\` [number&lt;ms&gt;]

Set test timeout
`;

            fs.existsSync.mockReturnValue(false);
            global.fetch.mockResolvedValue({
                ok: true,
                text: async () => mockMarkdown,
            });
            fs.writeFileSync.mockReturnValue(undefined);

            const result = await getCliOptions();

            const timeoutOption = result.find(
                (opt) => opt.name === "--testTimeout"
            );
            expect(timeoutOption).toBeDefined();
            expect(timeoutOption.type).toContain("<");
            expect(timeoutOption.type).toContain(">");
        });

        it("should remove images and links from descriptions", async () => {
            const mockMarkdown = `
### \`verbose\` [boolean]

[![Jest](/img/jestjs.svg)](https://jestjs.io)

Display verbose output

![Aligned](/img/aligned.svg)
`;

            fs.existsSync.mockReturnValue(false);
            global.fetch.mockResolvedValue({
                ok: true,
                text: async () => mockMarkdown,
            });
            fs.writeFileSync.mockReturnValue(undefined);

            const result = await getCliOptions();

            const verboseOption = result.find(
                (opt) => opt.name === "--verbose"
            );
            expect(verboseOption.description).not.toContain("![");
            expect(verboseOption.description).not.toContain("](");
        });

        it("should remove tip blocks from descriptions", async () => {
            const mockMarkdown = `
### \`verbose\` [boolean]

Display verbose output

:::tip
This is a tip
:::

More description
`;

            fs.existsSync.mockReturnValue(false);
            global.fetch.mockResolvedValue({
                ok: true,
                text: async () => mockMarkdown,
            });
            fs.writeFileSync.mockReturnValue(undefined);

            const result = await getCliOptions();

            const verboseOption = result.find(
                (opt) => opt.name === "--verbose"
            );
            expect(verboseOption.description).not.toContain(":::tip");
            expect(verboseOption.description).toContain(
                "Display verbose output"
            );
        });

        it("should handle array types", async () => {
            const mockMarkdown = `
### \`reporters\` [array&lt;moduleName | [moduleName, options]&gt;]

Custom reporters
`;

            fs.existsSync.mockReturnValue(false);
            global.fetch.mockResolvedValue({
                ok: true,
                text: async () => mockMarkdown,
            });
            fs.writeFileSync.mockReturnValue(undefined);

            const result = await getCliOptions();

            const reportersOption = result.find(
                (opt) => opt.name === "--reporters"
            );
            expect(reportersOption).toBeDefined();
            expect(reportersOption.type).toContain("array");
        });

        it("should remove HTML comments from markdown", async () => {
            const mockMarkdown = `
<!-- This is a comment -->
### \`verbose\` [boolean]

Display verbose output
<!-- Another comment -->
`;

            fs.existsSync.mockReturnValue(false);
            global.fetch.mockResolvedValue({
                ok: true,
                text: async () => mockMarkdown,
            });
            fs.writeFileSync.mockReturnValue(undefined);

            const result = await getCliOptions();

            expect(result.length).toBeGreaterThan(0);
            const verboseOption = result.find(
                (opt) => opt.name === "--verbose"
            );
            expect(verboseOption).toBeDefined();
        });

        it("should parse multiple options correctly", async () => {
            const mockMarkdown = `
### \`verbose\` [boolean]

Display verbose output

### \`ci\` [boolean]

Run in CI mode

### \`testTimeout\` [number]

Set timeout
`;

            fs.existsSync.mockReturnValue(false);
            global.fetch.mockResolvedValue({
                ok: true,
                text: async () => mockMarkdown,
            });
            fs.writeFileSync.mockReturnValue(undefined);

            const result = await getCliOptions();

            expect(result.length).toBe(3);
            expect(result.map((opt) => opt.name)).toContain("--verbose");
            expect(result.map((opt) => opt.name)).toContain("--ci");
            expect(result.map((opt) => opt.name)).toContain("--testTimeout");
        });
    });
});
