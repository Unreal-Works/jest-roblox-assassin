import chalk from "chalk";
import fs from "fs";
import path from "path";
import { ensureCache } from "./cache.js";

const DOCS_URL =
    "https://raw.githubusercontent.com/Roblox/jest-roblox/master/docs/docs/CLI.md";

export async function getCliOptions() {
    const cliOptionsPath = path.join(ensureCache(), "cli-options.json");

    // Check if cached JSON exists
    if (fs.existsSync(cliOptionsPath)) {
        try {
            const cached = JSON.parse(fs.readFileSync(cliOptionsPath, "utf-8"));
            return cached;
        } catch (error) {
            console.warn(
                "Failed to read cached CLI options, fetching fresh..."
            );
        }
    }

    // Fetch and parse
    try {
        const response = await fetch(DOCS_URL);
        if (!response.ok) {
            throw new Error(
                `Failed to fetch documentation: ${response.statusText}`
            );
        }
        const markdown = await response.text();
        const options = parseMarkdown(markdown);

        // Save to JSON for future use
        fs.mkdirSync(path.dirname(cliOptionsPath), { recursive: true });
        fs.writeFileSync(cliOptionsPath, JSON.stringify(options, null, 2));

        return options;
    } catch (error) {
        console.error(
            chalk.red(`Error fetching documentation: ${error.message}`)
        );
        return [];
    }
}

export async function showHelp() {
    const options = await getCliOptions();

    console.log("Usage: jestrbx [TestPathPatterns]");
    console.log("");

    for (const doc of options) {
        console.log(`${chalk.green.bold(doc.name)} ${chalk.cyan(doc.type)}`);
        console.log(`${doc.description.trim()}`);
        console.log("");
    }

    console.log(
        chalk.gray("Source: https://roblox.github.io/jest-roblox-internal/cli")
    );
}

function parseMarkdown(markdown) {
    const options = [];

    // Remove HTML comments
    const cleanMarkdown = markdown.replace(/<!--[\s\S]*?-->/g, "");

    // Match ### `optionName` [type]
    const sectionRegex = /### `([^`]+)` \\?\[([^\]]+)\]([\s\S]*?)(?=\n### |$)/g;
    let match;

    while ((match = sectionRegex.exec(cleanMarkdown)) !== null) {
        const name = match[1];
        let type = match[2];
        let description = match[3];

        // Decode HTML entities in type
        type = type.replace(/&lt;?/g, "<").replace(/&gt;?/g, ">");

        // Remove images and links like [![Jest](/img/jestjs.svg)](...) ![Aligned](/img/aligned.svg)
        description = description.replace(/\[!\[.*?\]\(.*?\)\]\(.*?\)/g, "");
        description = description.replace(/!\[.*?\]\(.*?\)/g, "");

        // Remove tip blocks
        description = description.replace(/:::tip[\s\S]*?:::/g, "");

        // Remove extra whitespace and newlines
        description = description.trim();

        options.push({
            name: `--${name}`,
            type: `[${type}]`,
            description,
        });
    }

    return options;
}
