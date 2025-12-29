for (const [key] of pairs(_G)) {
    // Clear registered modules to reset the roblox-ts runtime
    if (typeIs(key, "Instance") && key.IsA("ModuleScript")) {
        _G[key as unknown as keyof typeof _G] =
            undefined as unknown as (typeof _G)[keyof typeof _G];
    }
}

export = script as ModuleScript;
