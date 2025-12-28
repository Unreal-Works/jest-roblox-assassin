import chalk from "chalk";
import fs from "fs";
import path from "path";

export class ResultRewriter {
    INTERNAL_FRAME_PATTERNS = [
        /rbxts_include\.node_modules/i,
        /@rbxts-js\.Promise/i,
        /@rbxts-js\.JestCircus/i,
    ];

    constructor({
        workspaceRoot,
        projectRoot,
        rootDir,
        outDir,
        datamodelPrefixSegments,
    }) {
        this.workspaceRoot = workspaceRoot || projectRoot;
        this.projectRoot = projectRoot;
        this.rootDir = rootDir;
        this.outDir = outDir;
        this.datamodelPrefixSegments = datamodelPrefixSegments;

        const firstSegment = this.datamodelPrefixSegments[0];
        this.stackFramePattern = new RegExp(
            `(?:\\[string\\s+")?(${firstSegment}[^\\]":\\n]+)(?:"\\])?:([0-9]+)`,
            "g"
        );

        /**
         * A map from datamodel paths to their corresponding Luau and source file paths.
         * @type {Map<string, { luauPath: string, sourcePath: string | undefined }>}
         */
        this.modulePathMap = (() => {
            const map = new Map();
            const outRoot = path.join(this.projectRoot, this.outDir);
            if (!fs.existsSync(outRoot)) return map;

            function visit(folder) {
                for (const entry of fs.readdirSync(folder, {
                    withFileTypes: true,
                })) {
                    const abs = path.join(folder, entry.name);
                    if (entry.isDirectory()) {
                        visit(abs);
                        continue;
                    }
                    if (!entry.name.endsWith(".luau")) continue;

                    const rel = path.relative(outRoot, abs);
                    const withoutExt = rel.slice(0, -".luau".length);
                    const datamodelPath = [
                        ...datamodelPrefixSegments,
                        ...withoutExt.split(path.sep),
                    ].join(".");

                    const candidateBases = [
                        withoutExt + ".ts",
                        withoutExt + ".tsx",
                        withoutExt + ".lua",
                        withoutExt + ".luau",
                    ];
                    let sourcePath;
                    for (const candidate of candidateBases) {
                        const candidatePath = path.join(
                            projectRoot,
                            rootDir,
                            candidate
                        );
                        if (fs.existsSync(candidatePath)) {
                            sourcePath = candidatePath;
                            break;
                        }
                    }

                    map.set(datamodelPath, {
                        luauPath: abs,
                        sourcePath,
                    });
                }
            }

            visit(outRoot);
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
     * Formats a file path relative to the project root with forward slashes.
     * @param {string} filePath The file path to format.
     * @returns {string} The formatted path.
     */
    formatPath(filePath) {
        return path
            .relative(this.workspaceRoot, filePath)
            .split(path.sep)
            .join("/");
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
            : datamodelPath;
        return `${displayPath}:${mappedLine}`;
    }

    /**
     * Cleans internal stack trace lines from a text block.
     * @param {string} text The text block to clean.
     * @returns {string} The cleaned text block.
     */
    cleanInternalLines(text) {
        if (!text) return text;
        const lines = text.split(/\r?\n/);
        const kept = lines.filter(
            (line) =>
                !this.INTERNAL_FRAME_PATTERNS.some((pat) => pat.test(line))
        );
        const squashed = kept.join("\n").replace(/\n{3,}/g, "\n\n");
        return squashed.trimEnd();
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
        return typeof value === "string"
            ? this.cleanInternalLines(
                  value.replace(
                      this.stackFramePattern,
                      (match, dmPath, line) => {
                          const mapped = this.mapDatamodelFrame(
                              dmPath,
                              Number(line)
                          );
                          return mapped || match;
                      }
                  )
              )
            : value;
    }

    /**
     * Rewrites a test case's failure messages and details.
     * @param {object} testCase The test case to rewrite.
     */
    rewriteTestCase(testCase) {
        if (Array.isArray(testCase.failureMessages)) {
            const rewritten = testCase.failureMessages.map(
                this.rewriteStackString.bind(this)
            );
            let candidateFrame;

            // Search all failure messages for a valid file frame
            for (const msg of rewritten) {
                const frame = this.parseFrame(msg);
                if (frame) {
                    candidateFrame = frame;
                    break;
                }
            }

            // Fallback to failureDetails if no frame found in messages
            if (!candidateFrame && Array.isArray(testCase.failureDetails)) {
                for (const detail of testCase.failureDetails) {
                    const stack =
                        this.rewriteStackString(detail.stack) ||
                        this.rewriteStackString(detail.__stack) ||
                        this.rewriteStackString(detail.message);
                    const frame = this.parseFrame(stack);
                    if (frame) {
                        candidateFrame = frame;
                        break;
                    }
                }
            }

            const codeFrame = candidateFrame
                ? this.buildCodeFrame(
                      candidateFrame.absPath,
                      candidateFrame.line,
                      candidateFrame.column
                  )
                : undefined;

            // Only append the code frame to the first message to avoid duplication
            if (codeFrame && rewritten.length > 0) {
                rewritten[0] = this.injectCodeFrame(
                    rewritten[0],
                    candidateFrame,
                    codeFrame
                );
            }

            testCase.failureMessages = rewritten.map(
                this.formatFailureMessage.bind(this)
            );
        }
        if (Array.isArray(testCase.failureDetails)) {
            testCase.failureDetails = testCase.failureDetails.map((detail) => ({
                ...detail,
                stack: this.formatFailureMessage(
                    this.rewriteStackString(detail.stack)
                ),
                __stack: this.formatFailureMessage(
                    this.rewriteStackString(detail.__stack)
                ),
                message: this.formatFailureMessage(
                    this.rewriteStackString(detail.message)
                ),
            }));
        }
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
                : path.join(this.workspaceRoot, filePart);
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
        // Sort by score descending, then by line number (prefer higher line numbers which are usually the actual error)
        return candidates.sort(
            (a, b) => b.score - a.score || b.line - a.line
        )[0];
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
     * Injects a code frame into a text block, moving the corresponding stack frame line to the bottom.
     * @param {string} text The text block.
     * @param {object} frame The parsed frame info.
     * @param {string} codeFrame The code frame text.
     * @returns {string} The updated text block.
     */
    injectCodeFrame(text, frame, codeFrame) {
        if (!codeFrame || !frame) return text;

        const lines = text.split(/\r?\n/);
        let frameLine = "";
        let frameLineIndex = -1;

        const displayPath = this.formatPath(frame.absPath);
        const searchPath1 = `${displayPath}:${frame.line}`;
        const searchPath2 = `${frame.absPath}:${frame.line}`;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (line.includes(searchPath1) || line.includes(searchPath2)) {
                frameLine = line;
                frameLineIndex = i;
                break;
            }
        }

        if (frameLineIndex !== -1) {
            lines.splice(frameLineIndex, 1);
            return `${lines
                .join("\n")
                .trimEnd()}\n\n${codeFrame}\n\n${frameLine}`;
        }

        return `${text.trimEnd()}\n\n${codeFrame}`;
    }

    /**
     * Rewrites a test suite's results.
     * @param {object} suite The test suite result to rewrite.
     */
    rewriteSuiteResult(suite) {
        if (!suite) return;
        suite.testFilePath = this.formatPath(
            this.extendTestFilePath(suite.testFilePath)
        );

        if (Array.isArray(suite.testResults)) {
            suite.testResults.forEach((value) => {
                this.rewriteTestCase(value);
            });
        }

        if (suite.failureMessage) {
            let rewritten = this.rewriteStackString(suite.failureMessage);

            // Split by the test header "  ● " to handle multiple failures in one string
            const sections = rewritten.split(/(\s+●\s+)/);
            if (sections.length > 1) {
                for (let i = 2; i < sections.length; i += 2) {
                    const sectionContent = sections[i];
                    const frame = this.parseFrame(sectionContent);
                    if (frame) {
                        const codeFrame = this.buildCodeFrame(
                            frame.absPath,
                            frame.line,
                            frame.column
                        );
                        sections[i] =
                            this.injectCodeFrame(
                                sectionContent,
                                frame,
                                codeFrame
                            ) + "\n";
                    }
                }
                rewritten = sections.join("");
            } else {
                const frame = this.parseFrame(rewritten);
                if (frame) {
                    const codeFrame = this.buildCodeFrame(
                        frame.absPath,
                        frame.line,
                        frame.column
                    );
                    rewritten = this.injectCodeFrame(
                        rewritten,
                        frame,
                        codeFrame
                    ) + "\n";
                }
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
