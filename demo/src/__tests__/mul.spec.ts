import { describe, expect, it } from "@rbxts/jest-globals";

// partially passing tests
describe("mul", () => {
	it("multiplies 6 * 2 to equal 12", () => {
		expect(6 * 2).toBe(12);
	});

    it("multiplies 3 * 4 to equal 12", () => {
        expect(3 * 4).toBe(12);
    });

    it("multiplies 5 * 5 to equal 25", () => {
        expect(5 * 5).toBe(25);
    });

    it("fails when expecting 5 * 5 to equal 30", () => {
        expect(5 * 5).toBe(30);
    });
});
