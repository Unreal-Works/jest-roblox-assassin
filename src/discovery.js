import fs from "fs";
import path from "path";
import process from "process";
import { createSourcemap } from "./sourcemap.js";

/**
 * Gets subdirectories of a directory, excluding hidden dirs and node_modules.
 * @param {string} dir The directory to scan.
 * @returns {string[]} Array of subdirectory paths.
 */
function getSubdirs(dir) {
    try {
        return fs
            .readdirSync(dir, { withFileTypes: true })
            .filter(
                (dirent) =>
                    dirent.isDirectory() &&
                    !dirent.name.startsWith(".") &&
                    dirent.name !== "node_modules"
            )
            .map((dirent) => path.join(dir, dirent.name));
    } catch {
        return [];
    }
}

/**
 * Searches upwards from startDir for a file matching the predicate.
 * @param {string} startDir The directory to start searching from.
 * @param {(filePath: string) => boolean} predicate Function to test each file.
 * @returns {string | null} The path to the first matching file, or null.
 */
function findFileUpwards(startDir, predicate) {
    let current = startDir;
    while (current !== path.parse(current).root) {
        try {
            const files = fs.readdirSync(current);
            for (const file of files) {
                const filePath = path.join(current, file);
                if (fs.statSync(filePath).isFile() && predicate(filePath)) {
                    return filePath;
                }
            }
        } catch {
            // Ignore errors
        }
        current = path.dirname(current);
    }
    return null;
}

/**
 * Searches up to maxDepth levels deep from startDir for a file matching the predicate.
 * @param {string} startDir The directory to start searching from.
 * @param {(filePath: string) => boolean} predicate Function to test each file.
 * @param {number} maxDepth Maximum depth to search.
 * @returns {string | null} The path to the first matching file, or null.
 */
function findFileDeep(startDir, predicate, maxDepth = 2) {
    const search = (dirs, depth) => {
        if (depth > maxDepth) return null;
        for (const dir of dirs) {
            try {
                const files = fs.readdirSync(dir);
                for (const file of files) {
                    const filePath = path.join(dir, file);
                    if (fs.statSync(filePath).isFile() && predicate(filePath)) {
                        return filePath;
                    }
                }
            } catch {
                // Ignore errors
            }
            const subdirs = getSubdirs(dir);
            const result = search(subdirs, depth + 1);
            if (result) return result;
        }
        return null;
    };
    return search(getSubdirs(startDir), 1);
}

/**
 * Discovers the Rojo project file and root directory.
 * @param {string | null} projectFile Optional path to a known Rojo project file.
 */
export function discoverRojoProject(projectFile = null) {
    if (projectFile && fs.existsSync(projectFile)) {
        return {
            file: projectFile,
            root: path.dirname(projectFile),
            sourcemap: createSourcemap(projectFile),
        };
    }

    const startDir = process.cwd();
    const predicate = (filePath) => path.basename(filePath) === "default.project.json";

    // Search upwards first
    projectFile = findFileUpwards(startDir, predicate);

    if (!projectFile) {
        // Search up to 2 levels deep
        projectFile = findFileDeep(startDir, predicate, 2);
    }

    const projectRoot = projectFile ? path.dirname(projectFile) : startDir;

    return {
        file: projectFile,
        root: projectRoot,
        sourcemap: projectFile ? createSourcemap(projectFile) : undefined,
    };
}

/**
 * Discovers a Roblox place file (.rbxl or .rbxlx).
 * Searches upwards from cwd, then up to 2 levels deep.
 * @param {string} cwd The current working directory to start searching from.
 * @returns {string | null} The path to the place file, or null if not found.
 */
export function discoverPlaceFile(cwd = process.cwd()) {
    const placeExtensions = ['.rbxl', '.rbxlx'];

    const isPlaceFile = (filePath) => {
        const ext = path.extname(filePath).toLowerCase();
        return placeExtensions.includes(ext);
    };

    // Search upwards first
    let placeFile = findFileUpwards(cwd, isPlaceFile);

    if (!placeFile) {
        // Search up to 2 levels deep
        placeFile = findFileDeep(cwd, isPlaceFile, 2);
    }

    return placeFile;
}

/**
 * Discovers TypeScript compiler options from tsconfig.json.
 * If not found, defaults to rootDir: "src" and outDir: "out".
 * If the specified directories do not exist, will default rootDir to "." and outDir to rootDir.
 * @param {string} cwd The current working directory to look for tsconfig.json.
 * @returns {{ rootDir: string, outDir: string }} The discovered rootDir and outDir.
 */
export function discoverCompilerOptions(cwd = process.cwd()) {
    const tsConfigPath = path.join(cwd, "tsconfig.json");

    const stripJsonComments = (text) =>
        text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

    const readJsonWithComments = (jsonPath) => {
        if (!fs.existsSync(jsonPath)) return undefined;
        const raw = fs.readFileSync(jsonPath, "utf-8");
        try {
            return JSON.parse(stripJsonComments(raw));
        } catch (error) {
            return undefined;
        }
    };

    const compilerOptions =
        readJsonWithComments(tsConfigPath)?.compilerOptions || {};
    const dirs = {
        rootDir: compilerOptions.rootDir || "src",
        outDir: compilerOptions.outDir || "out",
    };

    if (!fs.existsSync(dirs.rootDir)) {
        dirs.rootDir = ".";
    }
    if (!fs.existsSync(dirs.outDir)) {
        dirs.outDir = dirs.rootDir;
    }
    return dirs;
}

/**
 * Discovers test files from the filesystem based on jest options.
 * @param {{ rootDir: string, outDir: string }} compilerOptions The TypeScript compiler options.
 * @param {object} jestOptions The Jest configuration options.
 * @returns {string[]} An array of discovered test file paths in roblox-jest format.
 */
export function discoverTestFilesFromFilesystem(compilerOptions, jestOptions) {
    const { rootDir, outDir } = compilerOptions;

    const outDirPath = path.join(outDir);

    if (!fs.existsSync(outDirPath)) {
        if (jestOptions.verbose) {
            console.log(`Output directory not found: ${outDirPath}`);
        }
        return [];
    }

    // Default test patterns if none specified
    const defaultTestMatch = [
        "**/__tests__/**/*.[jt]s?(x)",
        "**/?(*.)+(spec|test).[jt]s?(x)",
    ];

    const testMatchPatterns =
        jestOptions.testMatch && jestOptions.testMatch.length > 0
            ? jestOptions.testMatch
            : defaultTestMatch;

    // Convert glob patterns to work with .luau files in outDir
    const luauPatterns = testMatchPatterns.map((pattern) => {
        // Replace js/ts extensions with luau
        return pattern
            .replace(/\.\[jt\]s\?\(x\)/g, ".luau")
            .replace(/\.\[jt\]sx?/g, ".luau")
            .replace(/\.tsx?/g, ".luau")
            .replace(/\.jsx?/g, ".luau")
            .replace(/\.ts/g, ".luau")
            .replace(/\.js/g, ".luau");
    });

    // Add patterns for native .luau test files
    if (
        !luauPatterns.some(
            (p) => p.includes(".spec.luau") || p.includes(".test.luau")
        )
    ) {
        luauPatterns.push("**/__tests__/**/*.spec.luau");
        luauPatterns.push("**/__tests__/**/*.test.luau");
        luauPatterns.push("**/*.spec.luau");
        luauPatterns.push("**/*.test.luau");
    }

    const testFiles = [];

    // Simple recursive file finder with glob-like pattern matching
    function findFiles(dir, baseDir) {
        try {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
                const fullPath = path.join(dir, entry.name);
                const relativePath = path
                    .relative(baseDir, fullPath)
                    .replace(/\\/g, "/");

                if (entry.isDirectory()) {
                    // Skip node_modules and hidden directories
                    if (
                        !entry.name.startsWith(".") &&
                        entry.name !== "node_modules"
                    ) {
                        findFiles(fullPath, baseDir);
                    }
                } else if (entry.isFile() && entry.name.endsWith(".luau")) {
                    // Check if file matches any test pattern
                    const isTestFile = luauPatterns.some((pattern) => {
                        return matchGlobPattern(relativePath, pattern);
                    });

                    if (isTestFile) {
                        testFiles.push(relativePath);
                    }
                }
            }
        } catch (error) {
            // Ignore errors reading directories
        }
    }

    // Simple glob pattern matcher
    function matchGlobPattern(filePath, pattern) {
        // Handle common glob patterns
        let regexPattern = pattern
            .replace(/\./g, "\\.")
            .replace(/\*\*/g, "{{GLOBSTAR}}")
            .replace(/\*/g, "[^/]*")
            .replace(/{{GLOBSTAR}}/g, ".*")
            .replace(/\?/g, ".");

        // Handle optional groups like ?(x)
        regexPattern = regexPattern.replace(/\\\?\(([^)]+)\)/g, "($1)?");

        // Handle pattern groups like +(spec|test)
        regexPattern = regexPattern.replace(/\+\(([^)]+)\)/g, "($1)+");

        try {
            const regex = new RegExp(`^${regexPattern}$`, "i");
            return regex.test(filePath);
        } catch {
            // If pattern is invalid, fall back to simple check
            return filePath.includes(".spec.") || filePath.includes(".test.");
        }
    }

    findFiles(outDirPath, outDirPath);

    // Apply testPathIgnorePatterns if specified
    let filteredFiles = testFiles;
    if (
        jestOptions.testPathIgnorePatterns &&
        jestOptions.testPathIgnorePatterns.length > 0
    ) {
        filteredFiles = testFiles.filter((file) => {
            return !jestOptions.testPathIgnorePatterns.some((pattern) => {
                try {
                    const regex = new RegExp(pattern);
                    return regex.test(file);
                } catch {
                    return file.includes(pattern);
                }
            });
        });
    }

    // Apply testPathPattern filter if specified
    if (jestOptions.testPathPattern) {
        const pathPatternRegex = new RegExp(jestOptions.testPathPattern, "i");
        filteredFiles = filteredFiles.filter((file) =>
            pathPatternRegex.test(file)
        );
    }

    // Convert to roblox-jest path format (e.g., "src/__tests__/add.spec")
    // These paths are relative to projectRoot, use forward slashes, and have no extension
    const jestPaths = filteredFiles.map((file) => {
        // Remove .luau extension
        const withoutExt = file.replace(/\.luau$/, "");
        // Normalize to forward slashes
        const normalizedPath = withoutExt.replace(/\\/g, "/");
        // Prepend the rootDir (since outDir maps to rootDir in the place)
        return `${rootDir}/${normalizedPath}`;
    });

    if (jestOptions.verbose) {
        console.log(
            `Discovered ${jestPaths.length} test file(s) from filesystem`
        );
    }

    return jestPaths;
}
