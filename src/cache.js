import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Ensures that the .cache directory exists with a .gitignore file.
 * @returns {string} The path to the .cache directory.
 */
export function ensureCache() {
    const CACHE_FOLDER_PATH = path.join(__dirname, "..", ".cache");
    if (!fs.existsSync(CACHE_FOLDER_PATH)) {
        fs.mkdirSync(CACHE_FOLDER_PATH, { recursive: true });
        fs.writeFileSync(path.join(CACHE_FOLDER_PATH, ".gitignore"), `*`);
    }
    return CACHE_FOLDER_PATH;
}

