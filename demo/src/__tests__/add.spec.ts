import { describe, expect, it } from "@rbxts/jest-globals";

// fully failing tests
describe("add", () => {
	it("fails when expecting 5 + 5 to equal 30", () => {
		expect(5 + 5).toBe(30);
	});

	it("fails when expecting 10 + 15 to equal 20", () => {
		expect(10 + 15).toBe(20);
	});

	it("fails when expecting 7 + 8 to equal 10", () => {
		expect(7 + 8).toBe(10);
	});

	it("fails when expecting 0 + 0 to equal 1", () => {
		expect(0 + 0).toBe(1);
	});
});
