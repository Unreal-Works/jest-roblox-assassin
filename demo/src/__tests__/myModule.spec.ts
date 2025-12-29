import { describe, expect, it } from "@rbxts/jest-globals";
import { myFunction } from "shared/myModule";

describe("myModule", () => {
    it("returns hello world", () => {
        expect(myFunction()).toBe("Hello, World!");
    });
});
