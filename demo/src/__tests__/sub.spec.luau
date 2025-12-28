-- Compiled with roblox-ts v3.0.0
local TS = require(game:GetService("ReplicatedStorage"):WaitForChild("rbxts_include"):WaitForChild("RuntimeLib"))
local _jest_globals = TS.import(script, game:GetService("ReplicatedStorage"), "rbxts_include", "node_modules", "@rbxts", "jest-globals", "src")
local describe = _jest_globals.describe
local expect = _jest_globals.expect
local it = _jest_globals.it
-- partially passing tests
describe("sub", function()
	it("subtracts 10 - 4 to equal 6", function()
        expect(10 - 4).toBe(6)
    end)
    it("subtracts 20 - 5 to equal 15", function()
        expect(20 - 5).toBe(15)
    end)
    it("subtracts 8 - 3 to equal 5", function()
        expect(8 - 3).toBe(5)
    end)
    it("fails when expecting 9 - 2 to equal 8", function()
        expect(9 - 2).toBe(8)
    end)
end)
