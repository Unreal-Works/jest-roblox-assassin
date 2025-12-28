import { describe, expect, it } from "@rbxts/jest-globals";

// fully passing tests
describe("div", () => {
	it("divides 6 / 2 to equal 3", () => {
		expect(6 / 2).toBe(3);
	});

    it("divides 9 / 3 to equal 3", () => {
        expect(9 / 3).toBe(3);
    });

    it("divides 8 / 2 to equal 4", () => {
        expect(8 / 2).toBe(4);
    });
});
