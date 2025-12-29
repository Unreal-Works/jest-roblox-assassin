import { Config } from "@rbxts/jest";
import setupTestsModule from "shared/setupTests";

export = {
    testMatch: ["**/*.spec"],
    setupFiles: [setupTestsModule],
} satisfies Config;
