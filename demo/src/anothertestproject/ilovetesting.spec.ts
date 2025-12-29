import { describe, expect, it } from "@rbxts/jest-globals";
import { myFunction } from "shared/myModule";

describe("myModule", () => {
    it("fails when expecting bye world", () => {
        expect(myFunction()).toBe("Bye, World!");
    });
});
