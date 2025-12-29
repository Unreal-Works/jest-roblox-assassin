import fs from "fs";
import path from "path";

/**
 * Generates a sourcemap from a Rojo project file.
 * @param {string} projectFilePath Path to the .project.json file.
 * @returns {object | undefined} The generated sourcemap object.
 */
export function createSourcemap(projectFilePath) {
    const absoluteProjectRef = path.resolve(projectFilePath);
    const projectDir = path.dirname(absoluteProjectRef);

    let project;
    try {
        project = JSON.parse(fs.readFileSync(absoluteProjectRef, "utf8"));
    } catch (err) {
        console.error(`Failed to read project file: ${err.message}`);
        return;
    }

    const rootName = project.name || path.basename(projectDir);
    const rootNode = processNode(
        project.tree,
        rootName,
        projectDir,
        projectDir
    );
    // Add the project.json to the root filePaths
    rootNode.filePaths.push(toRelativePosixPath(absoluteProjectRef, projectDir));
    // Add meta.json if exists
    const metaPath = absoluteProjectRef + ".meta.json";
    if (fs.existsSync(metaPath)) {
        rootNode.filePaths.push(toRelativePosixPath(metaPath, projectDir));
    }
    return filterScripts(rootNode);
}

function toRelativePosixPath(p, base) {
    return path.relative(base, p).split(path.sep).join("/");
}

/**
 * Processes a Rojo project node recursively.
 * @param {object} node The current node in the project tree.
 * @param {string} name The name of the current node.
 * @param {string} currentDir The current directory for resolving relative paths.
 * @param {string} projectDir The root project directory for relative paths.
 * @returns {object} The processed node with className, filePaths, and children.
 */
function processNode(node, name, currentDir, projectDir) {
    let className = node.$className || "Folder";
    let filePaths = [];
    let children = [];

    if (node.$path) {
        const resolvedPath = path.resolve(currentDir, node.$path);
        if (fs.existsSync(resolvedPath)) {
            const stats = fs.statSync(resolvedPath);

            if (stats.isFile()) {
                const result = getScriptInfo(resolvedPath);
                if (result) {
                    className = node.$className || result.className;
                    filePaths = [resolvedPath];
                }
            } else if (stats.isDirectory()) {
                const dirResult = processDirectory(resolvedPath, projectDir);
                className = node.$className || dirResult.className;
                filePaths = dirResult.filePaths;
                children = dirResult.children;
            }
        }
        // Check for meta.json
        const metaPath = resolvedPath + ".meta.json";
        if (fs.existsSync(metaPath)) {
            filePaths.push(metaPath);
        }
    }

    // Process explicit children in the tree
    for (const [childName, childNode] of Object.entries(node)) {
        if (childName.startsWith("$")) continue;
        const child = processNode(childNode, childName, currentDir, projectDir);
        if (child) {
            children.push(child);
        }
    }

    return {
        name: name,
        className: className,
        filePaths: filePaths.map((p) => toRelativePosixPath(p, projectDir)),
        children: children,
    };
}

/**
 * Determines script class name based on file extension and naming convention.
 * @param {string} filePath The file path to analyze.
 * @returns {{ className: string, name: string } | null} The script info or null if not a script.
 */
function getScriptInfo(filePath) {
    const ext = path.extname(filePath);
    const base = path.basename(filePath, ext);

    if (ext === ".lua" || ext === ".luau") {
        if (base.endsWith(".server")) {
            return { className: "Script", name: base.slice(0, -7) };
        } else if (base.endsWith(".client")) {
            return { className: "LocalScript", name: base.slice(0, -7) };
        } else {
            return { className: "ModuleScript", name: base };
        }
    }
    return null;
}

/**
 * Processes a directory to find scripts and subdirectories.
 * @param {string} dirPath The directory path to process.
 * @param {string} projectDir The root project directory for relative paths.
 * @returns {{ className: string, filePaths: string[], children: object[] }} The processed directory info.
 */
function processDirectory(dirPath, projectDir) {
    const entries = fs.readdirSync(dirPath);
    let className = "Folder";
    let filePaths = [];
    let children = [];

    // Check for init scripts
    const initFile = entries.find((e) => {
        const ext = path.extname(e);
        const base = path.basename(e, ext);
        return base === "init" && (ext === ".lua" || ext === ".luau");
    });

    if (initFile) {
        const initPath = path.join(dirPath, initFile);
        const result = getScriptInfo(initPath);
        if (result) {
            className = result.className;
            filePaths = [initPath];
        }
    }

    for (const entry of entries) {
        const fullPath = path.join(dirPath, entry);
        const stats = fs.statSync(fullPath);

        if (stats.isDirectory()) {
            // Check if this directory has a default.project.json (subproject)
            const projectPath = path.join(fullPath, "default.project.json");
            if (fs.existsSync(projectPath)) {
                let subProject;
                try {
                    subProject = JSON.parse(fs.readFileSync(projectPath, "utf8"));
                } catch (err) {
                    console.warn(`Failed to read subproject file: ${err.message}`);
                }
                if (subProject) {
                    const subRootNode = processNode(
                        subProject.tree,
                        subProject.name || entry,
                        fullPath,
                        projectDir
                    );
                    // Add the project.json to filePaths
                    subRootNode.filePaths.push(toRelativePosixPath(projectPath, projectDir));
                    // Add meta.json if exists
                    const metaPath = projectPath + ".meta.json";
                    if (fs.existsSync(metaPath)) {
                        subRootNode.filePaths.push(toRelativePosixPath(metaPath, projectDir));
                    }
                    children.push(subRootNode);
                    continue;
                }
            }
            // Otherwise, process as normal directory
            const childNode = processNode(
                { $path: entry },
                entry,
                dirPath,
                projectDir
            );
            if (childNode) {
                children.push(childNode);
            }
        } else {
            const ext = path.extname(entry);
            const base = path.basename(entry, ext);

            // Skip init files as they are handled by the parent directory
            if (base === "init" && (ext === ".lua" || ext === ".luau"))
                continue;
            // Skip project files and meta files
            if (
                entry === "default.project.json" ||
                entry.endsWith(".meta.json")
            )
                continue;

            const result = getScriptInfo(fullPath);
            if (result) {
                let scriptFilePaths = [toRelativePosixPath(fullPath, projectDir)];
                const metaPath = fullPath + ".meta.json";
                if (fs.existsSync(metaPath)) {
                    scriptFilePaths.push(toRelativePosixPath(metaPath, projectDir));
                }
                children.push({
                    name: result.name,
                    className: result.className,
                    filePaths: scriptFilePaths,
                    children: [],
                });
            }
        }
    }

    return { className, filePaths, children };
}

/**
 * Filters the tree to only include scripts or nodes with script descendants.
 * @param {object} node The current node in the tree.
 * @returns {object | null} The filtered node or null if it has no scripts.
 */
function filterScripts(node) {
    const isScript = ["Script", "LocalScript", "ModuleScript"].includes(
        node.className
    );
    const filteredChildren = node.children
        .map((child) => filterScripts(child))
        .filter(Boolean);

    if (isScript || filteredChildren.length > 0) {
        return {
            name: node.name,
            className: node.className,
            filePaths: node.filePaths,
            children: filteredChildren,
        };
    }
}
