import chalk from "chalk";
import fs from "fs";
import path from "path";

export class ResultRewriter {
    constructor({ rojoProject, compilerOptions }) {
        this.rojoProject = rojoProject;
        this.compilerOptions = compilerOptions;

        /**
         * A map from datamodel paths to their corresponding Luau and source file paths.
         * @type {Map<string, { luauPath: string, sourcePath: string | undefined }>}
         */
        this.modulePathMap = (() => {
            const map = new Map();
            const sourcemap = rojoProject.sourcemap;
            if (!sourcemap) return map;

            const searchChildren = (node, parents) => {
                for (const child of node.children) {
                    // Recurse into children
                    searchChildren(child, [...parents, child.name]);

                    // Process current child
                    const datamodelPath = [...parents, child.name].join(".");
                    const luauPath = child.filePaths[0];
                    if (!luauPath) continue;

                    let sourcePath;

                    // If in outDir, map back to source using compiler options
                    if (
                        compilerOptions &&
                        luauPath.startsWith(compilerOptions.outDir)
                    ) {
                        const relativePath = path.relative(
                            compilerOptions.outDir,
                            luauPath
                        );
                        sourcePath = path.join(
                            compilerOptions.rootDir,
                            relativePath
                        );
                        // if called init, adjust to index
                        // TODO

                        // check if sourcePath exists
                        if (!fs.existsSync(sourcePath)) {
                            // if not, try changing extension to .ts or .tsx
                            const withTs = sourcePath.replace(
                                /\.(lua|luau)$/,
                                ".ts"
                            );
                            const withTsx = sourcePath.replace(
                                /\.(lua|luau)$/,
                                ".tsx"
                            );
                            if (fs.existsSync(withTs)) {
                                sourcePath = withTs;
                            } else if (fs.existsSync(withTsx)) {
                                sourcePath = withTsx;
                            }

                            // if still not, set to undefined
                            if (!fs.existsSync(sourcePath)) {
                                sourcePath = undefined;
                            }
                        }
                    }

                    map.set(datamodelPath, { luauPath, sourcePath });
                }
            };

            searchChildren(sourcemap, []);

            return map;
        })();
    }

    fileCache = new Map();

    /**
     * Reads lines from a file, with caching.
     * @param {string} filePath The file path to read.
     * @returns {string[]} The lines of the file.
     */
    readLines(filePath) {
        if (!filePath || !fs.existsSync(filePath)) return [];
        if (this.fileCache.has(filePath)) return this.fileCache.get(filePath);
        const lines = fs.readFileSync(filePath, "utf-8").split(/\r?\n/);
        this.fileCache.set(filePath, lines);
        return lines;
    }

    /**
     * Finds the corresponding source line for a given Luau line.
     * @param {string} luauPath The path to the Luau file.
     * @param {string} sourcePath The path to the source file.
     * @param {number} luauLineNumber The line number in the Luau file.
     * @returns {number} The corresponding line number in the source file.
     */
    findSourceLine(luauPath, sourcePath, luauLineNumber) {
        const luauLines = this.readLines(luauPath);
        const sourceLines = this.readLines(sourcePath);
        if (!luauLines.length || !sourceLines.length) return luauLineNumber;

        const target = (luauLines[luauLineNumber - 1] || "").trim();
        if (!target) return luauLineNumber;
        const normalizedTarget = target.replace(/\s+/g, "");

        const exactIndex = sourceLines.findIndex(
            (line) => line.trim() === target
        );
        if (exactIndex >= 0) return exactIndex + 1;

        const looseIndex = sourceLines.findIndex((line) =>
            line.replace(/\s+/g, "").includes(normalizedTarget)
        );
        if (looseIndex >= 0) return looseIndex + 1;

        return luauLineNumber;
    }

    /**
     * Formats a file path ready to be displayed to the terminal by making it relative and using forward slashes.
     * @param {string} filePath The file path to format.
     * @returns {string} The formatted path.
     */
    formatPath(filePath) {
        return path
            .relative(process.cwd(), filePath)
            .split(path.sep)
            .join("/")
            .replace(/\\/g, "/");
    }

    /**
     * Maps a datamodel stack frame to its source location.
     * @param {string} datamodelPath The path in the datamodel.
     * @param {number} lineNumber The line number in the datamodel file.
     * @returns {string | undefined} The mapped source location as "path:line" or undefined if not found.
     */
    mapDatamodelFrame(datamodelPath, lineNumber) {
        const entry = this.modulePathMap.get(datamodelPath);
        if (!entry) return undefined;
        const mappedLine = this.findSourceLine(
            entry.luauPath,
            entry.sourcePath,
            lineNumber
        );
        const displayPath = entry.sourcePath
            ? this.formatPath(entry.sourcePath)
            : entry.luauPath;
        return `${displayPath}:${mappedLine}`;
    }

    /**
     * Formats failure messages with syntax highlighting and colors.
     * @param {string} text The failure message text.
     * @returns {string} The formatted failure message.
     */
    formatFailureMessage(text) {
        if (!text) return text;

        // Color test header lines (e.g., "● test name")
        text = text.replace(/^(\s*●.*)$/gm, (match) => chalk.bold.red(match));

        // Fix indentation and color Expected: and Received: lines
        text = text.replace(
            /^\s+Expected:(.*)$/gm,
            (match, value) => `\n    Expected:${chalk.green(value)}`
        );
        text = text.replace(
            /^\s+Received:(.*)$/gm,
            (match, value) => `    Received:${chalk.red(value)}`
        );

        // Color expect assertions
        text = text.replace(
            /expect\((received)\)\.(\w+)\((expected)\)(\s*--\s*.+)?/g,
            (match, receivedWord, method, expectedWord, description) => {
                const colored =
                    chalk.gray("expect(") +
                    chalk.red(receivedWord) +
                    chalk.gray(").") +
                    chalk.white(method) +
                    chalk.gray("(") +
                    chalk.green(expectedWord) +
                    chalk.gray(")") +
                    (description ? chalk.gray(description) : "");
                return colored;
            }
        );

        // Color stack trace file paths
        text = text.replace(
            /((?:[\w@.\/\\-]*[\/\.\\][\w@.\/\\-]+)):(\d+)(?::(\d+))?/g,
            (match, filePart, line, col) => {
                const lineCol = chalk.gray(`:${line}${col ? `:${col}` : ""}`);
                return `${chalk.cyan(filePart)}${lineCol}`;
            }
        );

        return text;
    }

    /**
     * Rewrites stack strings to map datamodel paths to source paths.
     * @param {string} value The stack string to rewrite.
     * @returns {string} The rewritten stack string.
     */
    rewriteStackString(value) {
        if (!value) return value;

        // Try to find matches in modulePathMap
        const pattern =
            /((?:[\w@.\/\\-]*[\/\.\\][\w@.\/\\-]+)):(\d+)(?::(\d+))?/g;
        let match;
        let rewritten = value;
        const processed = new Set();
        while ((match = pattern.exec(value)) !== null) {
            const [fullMatch, filePart, lineStr] = match;
            const lineNumber = Number(lineStr);
            if (processed.has(fullMatch)) continue;
            processed.add(fullMatch);
            const mapped = this.mapDatamodelFrame(filePart, lineNumber);
            if (mapped) {
                rewritten = rewritten.split(fullMatch).join(mapped);
            }
        }

        return rewritten;
    }

    /**
     * Converts a testFilePath from the Jest datamodel format to the source file path.
     * A testFilePath looks like: `parent/testName.spec`, where ancestors after parent are sliced off.
     * Hence, only infering from the modulePathMap is possible. If conflicts arise, no match is made and the original path is returned.
     *
     * @param {string} testFilePath The raw testFilePath from runner results.
     * @returns {string} The source file path.
     */
    datamodelPathToSourcePath(testFilePath) {
        if (!testFilePath) return testFilePath;

        // Attempt direct lookup first
        const entry = this.modulePathMap.get(testFilePath);
        if (entry?.sourcePath) {
            return entry.sourcePath;
        }

        let matchingPath = testFilePath
            .replace(/\.(lua|luau)$/, "")
            .replace("\\", ".")
            .replace("/", ".");

        const matches = [];
        for (const [dmPath, paths] of this.modulePathMap.entries()) {
            if (dmPath.endsWith(matchingPath)) {
                matches.push(paths.sourcePath ?? paths.luauPath);
            }
        }

        if (matches.length === 1) {
            return matches[0];
        }

        // Last resort: return as-is joined with projectRoot
        return path.join(this.rojoProject.root, testFilePath);
    }

    /**
     * Extends a test file path by checking for common extensions.
     * @param {string} testFilePath The original test file path.
     * @returns {string} The extended test file path.
     */
    extendTestFilePath(testFilePath) {
        if (!testFilePath) return testFilePath;
        const withExts = [".ts", ".tsx", ""]; // last entry preserves original
        for (const ext of withExts) {
            const candidate = path.join(
                this.projectRoot,
                `${testFilePath}${ext}`
            );
            if (fs.existsSync(candidate)) return candidate;
        }
        return path.join(this.projectRoot, testFilePath);
    }

    /**
     * Strips ANSI escape codes from a string.
     * @param {string} str The string to strip.
     * @returns {string} The stripped string.
     */
    stripAnsi(str) {
        return typeof str === "string"
            ? str.replace(/\u001b\[[0-9;]*m/g, "")
            : str;
    }

    /**
     * Parses a stack frame from text and returns file path, line, and column.
     * @param {string} text The text to parse.
     * @returns {{ absPath: string, line: number, column: number } | undefined} The parsed frame info or undefined if not found.
     */
    parseFrame(text) {
        if (!text) return undefined;
        const cleanText = this.stripAnsi(text);
        // Match patterns like "src/test.ts:10" or "C:\path\test.ts:10"
        // We look for something that looks like a file path followed by a colon and a number
        const pattern =
            /(?:^|\s|")((?:[a-zA-Z]:[\\\/][^:\s\n"]+|[\w@.\/\\-]+\.[a-z0-9]+)):(\d+)(?::(\d+))?/gi;
        let match;
        const candidates = [];
        while ((match = pattern.exec(cleanText)) !== null) {
            const [, filePart, lineStr, colStr] = match;
            const absPath = path.isAbsolute(filePart)
                ? filePart
                : path.join(this.rojoProject.root, filePart);
            if (fs.existsSync(absPath)) {
                candidates.push({
                    absPath,
                    line: Number(lineStr),
                    column: colStr ? Number(colStr) : 1,
                    score:
                        (filePart.includes(".") ? 1 : 0) +
                        (filePart.includes("/") || filePart.includes("\\")
                            ? 1
                            : 0),
                });
            }
        }

        if (candidates.length === 0) return undefined;
        return candidates[0];
    }

    /**
     * Syntax highlights code for terminal output.
     * @param {string} text The code text to highlight.
     * @returns {string} The highlighted code.
     */
    highlightCode(text) {
        if (!text) return text;
        return text.replace(
            /((["'`])(?:(?=(\\?))\3.)*?\2)|(\b\d+(?:\.\d+)?\b)|(=>|[,\.\+\-\*\/%=<>!?:;&|\[\]])/g,
            (match, string, quote, escape, number, punctuation) => {
                if (string) return chalk.green(match);
                if (number) return chalk.magenta(match);
                if (punctuation) return chalk.yellow(match);
                return match;
            }
        );
    }

    /**
     * Builds a code frame for a given file and line.
     * @param {string} absPath The absolute file path.
     * @param {number} line The line to build the frame around.
     * @param {number} column The column to point to.
     * @param {number} context The number of context lines to include.
     * @returns {string|undefined} The code frame as a string, or undefined if file not found.
     */
    buildCodeFrame(absPath, line, column = 1, context = 2) {
        const lines = this.readLines(absPath);
        if (!lines.length) return undefined;
        const start = Math.max(1, line - context);
        const end = Math.min(lines.length, line + context + 1);
        const frame = [];

        for (let i = start; i <= end; i++) {
            const isBright = i === start;
            const lineNum = String(i).padStart(String(end).length, " ");
            const gutter = `${
                i === line ? chalk.bold.red(">") : " "
            } ${chalk.grey(lineNum + " |")}`;
            const rawContent = lines[i - 1] || "";
            const highlightedContent = this.highlightCode(rawContent);
            const content = `    ${gutter} ${highlightedContent}`;
            frame.push(isBright ? content : chalk.dim(content));
        }
        return frame.join("\n");
    }

    /**
     * Appends code frames to messages.
     * @param {Array|string} messages The messages to append to.
     * @param {string} frameText The code frame text to append.
     * @returns {Array|string} The messages with appended code frames.
     */
    appendCodeFrames(messages, frameText) {
        if (!Array.isArray(messages) || !frameText) return messages;
        return messages.map((msg) =>
            typeof msg === "string" ? `${msg}\n\n${frameText}` : msg
        );
    }

    /**
     * Injects a code frame into a text block, moving all stack trace lines to below the code frame.
     * @param {string} text The text block.
     * @param {object} frame The parsed frame info.
     * @param {string} codeFrame The code frame text.
     * @returns {string} The updated text block.
     */
    injectCodeFrame(text, frame, codeFrame) {
        if (!codeFrame || !frame) return text;

        const lines = text.split(/\r?\n/);
        const stackLines = [];
        const nonStackLines = [];
        const pattern =
            /(?:^|\s|")((?:[a-zA-Z]:[\\\/][^:\s\n"]+|[\w@.\/\\-]+\.[a-z0-9]+)):(\d+)(?::(\d+))?/gi;

        for (const line of lines) {
            pattern.lastIndex = 0; // Reset regex state
            if (pattern.test(line)) {
                stackLines.push(line);
            } else {
                nonStackLines.push(line);
            }
        }

        const mainText = nonStackLines.join("\n");
        return `${mainText}\n\n${codeFrame}\n\n${stackLines.join("\n")}`;
    }

    /**
     * Rewrites a test suite's results.
     * @param {object} suite The test suite result to rewrite.
     */
    rewriteSuiteResult(suite) {
        if (!suite) return;
        suite.testFilePath = this.formatPath(
            this.datamodelPathToSourcePath(suite.testFilePath)
        );

        if (suite.failureMessage) {
            let rewritten = this.rewriteStackString(suite.failureMessage);

            // Split by the test header "  ● " to handle multiple failures in one string
            const sections = rewritten.split(/(\s+●\s+)/);

            const rewriteSection = (sectionContent) => {
                const frame = this.parseFrame(sectionContent);
                if (!frame) return sectionContent;

                const codeFrame = this.buildCodeFrame(
                    frame.absPath,
                    frame.line,
                    frame.column
                );
                return (
                    this.injectCodeFrame(sectionContent, frame, codeFrame) +
                    "\n"
                );
            };

            if (sections.length > 1) {
                for (let i = 2; i < sections.length; i += 2) {
                    sections[i] = rewriteSection(sections[i]);
                }
                rewritten = sections.join("");
            } else {
                rewritten = rewriteSection(rewritten);
            }

            suite.failureMessage = this.formatFailureMessage(rewritten);
        }
    }

    /**
     * Rewrites parsed test results.
     * @param {object} results The parsed test results.
     */
    rewriteParsedResults(results) {
        if (!results?.testResults) return;
        for (const suite of results.testResults) {
            this.rewriteSuiteResult(suite);
        }
    }
}
