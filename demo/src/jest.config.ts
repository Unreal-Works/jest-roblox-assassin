import { Config } from "@rbxts/jest";

export = {
    testMatch: ["**/*.spec"],
    setupFiles: [script.Parent!.WaitForChild("setup") as ModuleScript],
} satisfies Config;
