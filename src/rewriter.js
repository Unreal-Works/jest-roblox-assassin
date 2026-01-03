import chalk from "chalk";
import fs from "fs";
import path from "path";
import util from "util";

export class ResultRewriter {
    constructor({ rojoProject, compilerOptions, testLocationInResults }) {
        this.rojoProject = rojoProject;
        this.compilerOptions = compilerOptions;
        this.testLocationInResults = Boolean(testLocationInResults);
        this.luauPathMap = new Map();
        const projectRoot = this.rojoProject?.root ?? process.cwd();
        this.projectRoot = projectRoot;

        const rootDirRelative = compilerOptions?.rootDir ?? "src";
        const outDirRelative = compilerOptions?.outDir ?? "out";
        const absoluteRootDir = path.isAbsolute(rootDirRelative)
            ? rootDirRelative
            : path.join(projectRoot, rootDirRelative);
        const absoluteOutDir = path.isAbsolute(outDirRelative)
            ? outDirRelative
            : path.join(projectRoot, outDirRelative);

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

                    const absoluteLuauPath = path.join(projectRoot, luauPath);
                    let sourcePath;

                    if (absoluteOutDir) {
                        const normalizedOutDir = absoluteOutDir.replace(
                            /\\/g,
                            "/"
                        );
                        const normalizedLuau = absoluteLuauPath.replace(
                            /\\/g,
                            "/"
                        );
                        if (normalizedLuau.startsWith(normalizedOutDir)) {
                            const relativePath = path.relative(
                                absoluteOutDir,
                                absoluteLuauPath
                            );
                            let candidateSource = path.join(
                                absoluteRootDir,
                                relativePath
                            );
                            if (
                                path
                                    .basename(candidateSource)
                                    .startsWith("init.")
                            ) {
                                candidateSource = path.join(
                                    path.dirname(candidateSource),
                                    "index" + path.extname(candidateSource)
                                );
                            }

                            if (!fs.existsSync(candidateSource)) {
                                const withTs = candidateSource.replace(
                                    /\.(lua|luau)$/,
                                    ".ts"
                                );
                                const withTsx = candidateSource.replace(
                                    /\.(lua|luau)$/,
                                    ".tsx"
                                );
                                if (fs.existsSync(withTs)) {
                                    candidateSource = withTs;
                                } else if (fs.existsSync(withTsx)) {
                                    candidateSource = withTsx;
                                }
                            }

                            if (fs.existsSync(candidateSource)) {
                                sourcePath = candidateSource;
                            }
                        }
                    }

                    const entry = { luauPath, absoluteLuauPath, sourcePath };
                    map.set(datamodelPath, entry);
                    const normalizedLuauPath = luauPath.replace(/\\/g, "/");
                    this.luauPathMap.set(normalizedLuauPath, entry);
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
     * Finds the matcher column for an expectation on a line. Falls back to the start of `expect`.
     * @param {string} lineText The source line text.
     * @returns {number} The 1-based column index.
     */
    findExpectationColumn(lineText) {
        if (!lineText) return 1;

        const expectIndex = lineText.search(/\bexpect\s*\(/);
        if (expectIndex === -1) return 1;

        // Look for the last matcher call after the expect expression to cover any matcher name.
        const afterExpect = lineText.slice(expectIndex);
        const matcherRegex = /\.\s*([A-Za-z_$][\w$]*)\s*(?=\()/g;
        let matcher;
        let match;
        while ((match = matcherRegex.exec(afterExpect)) !== null) {
            matcher = match;
        }

        if (!matcher) {
            return expectIndex + 1;
        }

        const matcherName = matcher[1];
        const matcherNameOffset =
            matcher.index + matcher[0].indexOf(matcherName);
        return expectIndex + matcherNameOffset + 1;
    }

    /**
     * Finds the line/column for a test title within a source file.
     * @param {string} testTitle The title of the test case.
     * @param {string} sourcePath The path to the source file.
     * @returns {{ line: number, column: number } | undefined} The location with 1-based line and 0-based column.
     */
    findTestHeaderLocation(testTitle, sourcePath) {
        if (!testTitle || !sourcePath) return undefined;
        const lines = this.readLines(sourcePath);
        if (!lines.length) return undefined;

        const escapedTitle = testTitle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const patterns = [
            new RegExp(
                "\\b(?:it|test|xtest|fit|ftest|xit)\\s*\\(\\s*[\"'`]" +
                    escapedTitle +
                    "[\"'`]",
                "i"
            ),
            new RegExp("[\"'`]" + escapedTitle + "[\"'`]", "i"),
        ];

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            for (const pattern of patterns) {
                const match = pattern.exec(line);
                if (match) {
                    return { line: i + 1, column: match.index };
                }
            }
        }

        return undefined;
    }

    /**
     * Formats a file path ready to be displayed to the terminal by making it relative and using forward slashes.
     * @param {string} filePath The file path to format.
     * @returns {string} The formatted path.
     */
    formatPath(filePath) {
        const baseDir = this.projectRoot || process.cwd();
        let relativePath = path.relative(baseDir, filePath);
        if (!relativePath || relativePath.startsWith("..")) {
            relativePath = path.relative(process.cwd(), filePath);
        }
        if (!relativePath) {
            relativePath = filePath;
        }
        return relativePath.split(path.sep).join("/").replace(/\\/g, "/");
    }

    /**
     * Maps a datamodel stack frame to its source location.
     * @param {string} datamodelPath The path in the datamodel.
     * @param {number} lineNumber The line number in the datamodel file.
     * @returns {{ line: number, column: number, file: string } | undefined} The mapped location.
     */
    mapDatamodelFrame(datamodelPath, lineNumber) {
        const normalizedPath = datamodelPath.replace(/\\/g, "/");
        let entry =
            this.modulePathMap.get(datamodelPath) ||
            this.modulePathMap.get(normalizedPath);
        if (!entry) {
            entry = this.luauPathMap.get(normalizedPath);
        }
        if (!entry && this.projectRoot) {
            const candidateAbsolute = path.isAbsolute(datamodelPath)
                ? path.resolve(datamodelPath)
                : path.join(this.projectRoot, normalizedPath);
            const relativeToRoot = path
                .relative(this.projectRoot, candidateAbsolute)
                .replace(/\\/g, "/");
            entry = this.luauPathMap.get(relativeToRoot);
        }
        if (!entry) return undefined;
        const absoluteLuauPath =
            entry.absoluteLuauPath ?? path.resolve(entry.luauPath);
        const mappedLine = this.findSourceLine(
            absoluteLuauPath,
            entry.sourcePath ?? absoluteLuauPath,
            lineNumber
        );
        const sourceForColumn = entry.sourcePath ?? absoluteLuauPath;
        const sourceLines = this.readLines(sourceForColumn);
        const lineText = sourceLines[mappedLine - 1] || "";
        const column = this.findExpectationColumn(lineText);

        return {
            line: mappedLine,
            column,
            file: sourceForColumn,
        };
    }

    /**
     * Formats `suite.failureMessage` text with colors for terminal output.
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
    rewriteStackString(value, options = {}) {
        if (!value) return value;
        const { absolutePaths = false } = options;

        // Try to find matches in modulePathMap
        const pattern =
            /((?:[\w@.\/\\-]*[\/.\\][\w@.\/\\-]+)):(\d+)(?::(\d+))?/g;
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
                const filePath = absolutePaths
                    ? path.resolve(mapped.file)
                    : this.formatPath(mapped.file);
                rewritten = rewritten
                    .split(fullMatch)
                    .join(`${filePath}:${mapped.line}:${mapped.column}`);
            }
        }

        return rewritten;
    }

    /**
     * Rewrites `suite.testResults[].failureMessages` entries.
     * @param {Array<string>} messages The failure messages array.
     * @returns {Array<string>} The rewritten messages array.
     */
    rewriteFailureMessages(messages) {
        if (!Array.isArray(messages)) return messages;

        const rewriteFailureMessage = (text) => {
            if (!text) return text;

            const rewritten = this.rewriteStackString(text, {
                absolutePaths: true,
            });

            const lines = rewritten.split(/\r?\n/);
            const resultLines = [];

            for (const rawLine of lines) {
                if (!rawLine.trim()) continue;

                // Strip Luau [string "..."] wrappers if present
                const strippedLine = rawLine.replace(
                    /^\[string\s+"(.+?)"\]\s*/i,
                    "$1"
                );

                const stackMatch = /^(.*):(\d+)(?::(\d+))?(?:\s|$)/.exec(
                    strippedLine
                );

                if (stackMatch) {
                    const [, filePart, lineStr, colStr] = stackMatch;
                    const lineNumber = Number(lineStr);
                    const colNumber = Number(colStr || "1");
                    const mapped = this.mapDatamodelFrame(filePart, lineNumber);
                    const absFile = mapped
                        ? path.resolve(mapped.file)
                        : path.isAbsolute(filePart)
                        ? filePart
                        : path.resolve(
                              this.projectRoot || process.cwd(),
                              filePart
                          );
                    const finalLine = mapped?.line ?? lineNumber;
                    const finalCol = mapped?.column ?? colNumber;
                    resultLines.push(
                        `    at ${absFile}:${finalLine}:${finalCol}`
                    );
                    continue;
                }

                resultLines.push(strippedLine);
            }

            return resultLines.join("\n");
        };

        return messages
            .map((msg) => rewriteFailureMessage(msg))
            .filter((msg) => Boolean(msg));
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
        const normalizedPath = testFilePath.replace(/\\/g, "/");
        let entry =
            this.modulePathMap.get(testFilePath) ||
            this.modulePathMap.get(normalizedPath);
        if (!entry) {
            entry = this.luauPathMap.get(normalizedPath);
        }
        if (!entry && this.projectRoot) {
            const candidateAbsolute = path.isAbsolute(testFilePath)
                ? path.resolve(testFilePath)
                : path.join(this.projectRoot, normalizedPath);
            const relativeToRoot = path
                .relative(this.projectRoot, candidateAbsolute)
                .replace(/\\/g, "/");
            entry = this.luauPathMap.get(relativeToRoot);
        }
        if (entry?.sourcePath) {
            return entry.sourcePath;
        }

        let matchingPath = testFilePath
            .replace(/\.(lua|luau)$/, "")
            .replace(/\\/g, ".")
            .replace(/\//g, ".");

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
     * Parses a stack frame from text and returns file path, line, and column.
     * @param {string} text The text to parse.
     * @returns {{ absPath: string, line: number, column: number } | undefined} The parsed frame info or undefined if not found.
     */
    parseFrame(text) {
        if (!text) return undefined;
        const cleanText = util.stripVTControlCharacters(text);
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
        // Replace tabs with 4 spaces for consistent formatting
        lines.forEach((_, idx) => {
            lines[idx] = lines[idx].replace(/\t/g, "    ");
        });
        const start = Math.max(1, line - context);
        const end = Math.min(lines.length, line + context + 1);
        const frame = [];

        const digitWidth = String(end).length;

        for (let i = start; i <= end; i++) {
            const isBright = i === start;
            const lineNum = String(i).padStart(digitWidth, " ");
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
        const sourcePath = this.datamodelPathToSourcePath(suite.testFilePath);
        const resolvedTestFilePath = path.resolve(sourcePath);
        suite.testFilePath = resolvedTestFilePath;

        if (Array.isArray(suite.testResults)) {
            for (const testResult of suite.testResults) {
                if (this.testLocationInResults && !testResult.location) {
                    const location =
                        this.findTestHeaderLocation(
                            testResult.title,
                            sourcePath
                        ) ||
                        (sourcePath !== resolvedTestFilePath
                            ? this.findTestHeaderLocation(
                                  testResult.title,
                                  resolvedTestFilePath
                              )
                            : undefined);
                    if (location) {
                        testResult.location = location;
                    }
                }

                if (Array.isArray(testResult.failureMessages)) {
                    testResult.failureMessages = this.rewriteFailureMessages(
                        testResult.failureMessages
                    );
                }
            }
        }

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

    /**
     * Rewrites coverage data to use source file paths instead of datamodel paths.
     * @param {object} coverageData The coverage data.
     * @returns {object} The rewritten coverage data.
     */
    rewriteCoverageData(coverageData) {
        if (!coverageData) return coverageData;

        const rewritten = {};
        for (const [datamodelPath, coverage] of Object.entries(coverageData)) {
            // Skip the "total" key
            if (datamodelPath === "total") {
                rewritten[datamodelPath] = coverage;
                continue;
            }

            // Convert datamodel path to luau path
            // Coverage data uses slashes, but modulePathMap uses dots
            const normalizedPath = datamodelPath.replace(/\//g, ".");
            let entry = this.modulePathMap.get(normalizedPath);

            const finalPath = path.resolve(entry?.luauPath ?? datamodelPath);

            // Clone the coverage object and update the path property
            const rewrittenCoverage = { ...coverage };
            if (rewrittenCoverage.path) {
                rewrittenCoverage.path = finalPath;
            }

            rewritten[finalPath] = rewrittenCoverage;
        }

        return rewritten;
    }

    /**
     * Converts raw Jest results into JSON format similar to `jest --json` output.
     * @param {{ results: object, coverage?: object, globalConfig?: object }} jestRunCliReturn The raw Jest results.
     */
    json(jestRunCliReturn) {
        const results = { ...jestRunCliReturn.results };

        if (jestRunCliReturn.coverage) {
            results.coverageMap = jestRunCliReturn.coverage;
        }

        for (const suite of results.testResults) {
            suite.message = suite.failureMessage ?? "";
            delete suite.failureMessage;

            suite.assertionResults = suite.testResults || [];
            delete suite.testResults;

            suite.name = suite.testFilePath;
            delete suite.testFilePath;

            let overallPassed = true;
            for (const testResult of suite.testResults || []) {
                if (testResult.status === "failed") {
                    overallPassed = false;
                    break;
                }
            }
            suite.status = overallPassed ? "passed" : "failed";
        }
        return results;
    }
}
