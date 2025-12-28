import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ResultRewriter } from './rewriter.js';
import fs from 'fs';
import path from 'path';

vi.mock('fs');
vi.mock('chalk', () => ({
    default: {
        bold: { red: (text) => text },
        green: (text) => text,
        red: (text) => text,
        gray: (text) => text,
        grey: (text) => text,
        cyan: (text) => text,
        white: (text) => text,
        magenta: (text) => text,
        yellow: (text) => text,
        dim: (text) => text,
    }
}));

describe('ResultRewriter', () => {
    let rewriter;
    const mockWorkspaceRoot = '/workspace';
    const mockProjectRoot = '/workspace/project';
    const mockRootDir = 'src';
    const mockOutDir = 'out';
    const mockDatamodelSegments = ['ReplicatedStorage', 'src'];

    beforeEach(() => {
        vi.clearAllMocks();
        
        // Mock fs.existsSync to return false by default
        fs.existsSync.mockReturnValue(false);
        
        // Mock fs.readdirSync to return empty array by default
        fs.readdirSync.mockReturnValue([]);
        
        rewriter = new ResultRewriter({
            workspaceRoot: mockWorkspaceRoot,
            projectRoot: mockProjectRoot,
            rootDir: mockRootDir,
            outDir: mockOutDir,
            datamodelPrefixSegments: mockDatamodelSegments,
        });
    });

    describe('constructor', () => {
        it('should initialize with correct properties', () => {
            expect(rewriter.workspaceRoot).toBe(mockWorkspaceRoot);
            expect(rewriter.projectRoot).toBe(mockProjectRoot);
            expect(rewriter.rootDir).toBe(mockRootDir);
            expect(rewriter.outDir).toBe(mockOutDir);
            expect(rewriter.datamodelPrefixSegments).toEqual(mockDatamodelSegments);
        });

        it('should create stack frame pattern from datamodel segments', () => {
            expect(rewriter.stackFramePattern).toBeInstanceOf(RegExp);
            expect(rewriter.stackFramePattern.source).toContain('ReplicatedStorage');
        });

        it('should build module path map from outDir', () => {
            expect(rewriter.modulePathMap).toBeInstanceOf(Map);
        });
    });

    describe('readLines', () => {
        it('should return empty array for non-existent file', () => {
            fs.existsSync.mockReturnValue(false);
            const result = rewriter.readLines('/nonexistent.ts');
            expect(result).toEqual([]);
        });

        it('should read and cache file lines', () => {
            fs.existsSync.mockReturnValue(true);
            fs.readFileSync.mockReturnValue('line1\nline2\nline3');
            
            const result = rewriter.readLines('/test.ts');
            expect(result).toEqual(['line1', 'line2', 'line3']);
            expect(rewriter.fileCache.has('/test.ts')).toBe(true);
        });

        it('should return cached lines on subsequent calls', () => {
            fs.existsSync.mockReturnValue(true);
            fs.readFileSync.mockReturnValue('line1\nline2');
            
            rewriter.readLines('/test.ts');
            rewriter.readLines('/test.ts');
            
            expect(fs.readFileSync).toHaveBeenCalledTimes(1);
        });
    });

    describe('findSourceLine', () => {
        it('should return same line number when files dont exist', () => {
            const result = rewriter.findSourceLine('/luau.luau', '/source.ts', 10);
            expect(result).toBe(10);
        });

        it('should find exact matching line', () => {
            fs.existsSync.mockReturnValue(true);
            fs.readFileSync
                .mockReturnValueOnce('line1\n  const x = 5;\nline3')
                .mockReturnValueOnce('other\n  const x = 5;\nother');
            
            const result = rewriter.findSourceLine('/luau.luau', '/source.ts', 2);
            expect(result).toBe(2);
        });

        it('should handle normalized whitespace matching', () => {
            fs.existsSync.mockReturnValue(true);
            fs.readFileSync
                .mockReturnValueOnce('line1\nconst   x   =   5;\nline3')
                .mockReturnValueOnce('other\nconst x = 5;\nother');
            
            const result = rewriter.findSourceLine('/luau.luau', '/source.ts', 2);
            expect(result).toBe(2);
        });
    });

    describe('formatPath', () => {
        it('should format path relative to workspace root', () => {
            const result = rewriter.formatPath('/workspace/project/src/test.ts');
            expect(result).toBe('project/src/test.ts');
        });

        it('should use forward slashes', () => {
            const windowsPath = path.win32.join(mockWorkspaceRoot, 'project', 'src', 'test.ts');
            const result = rewriter.formatPath(windowsPath);
            expect(result).not.toContain('\\');
        });
    });

    describe('mapDatamodelFrame', () => {
        it('should return undefined for unknown datamodel path', () => {
            const result = rewriter.mapDatamodelFrame('Unknown.Path', 10);
            expect(result).toBeUndefined();
        });

        it('should map known datamodel path to source location', () => {
            const luauPath = '/workspace/project/out/test.luau';
            const sourcePath = '/workspace/project/src/test.ts';
            
            rewriter.modulePathMap.set('ReplicatedStorage.src.test', {
                luauPath,
                sourcePath,
            });
            
            fs.existsSync.mockReturnValue(true);
            fs.readFileSync.mockReturnValue('line1\nline2\nline3');
            
            const result = rewriter.mapDatamodelFrame('ReplicatedStorage.src.test', 2);
            expect(result).toContain('test.ts');
            expect(result).toContain(':2');
        });
    });

    describe('cleanInternalLines', () => {
        it('should remove lines matching internal patterns', () => {
            const text = `Error: test failed
    at rbxts_include.node_modules.something:10
    at real.code:20
    at @rbxts-js.Promise:30
    at more.real.code:40`;
            
            const result = rewriter.cleanInternalLines(text);
            expect(result).not.toContain('rbxts_include.node_modules');
            expect(result).not.toContain('@rbxts-js.Promise');
            expect(result).toContain('real.code:20');
            expect(result).toContain('more.real.code:40');
        });

        it('should reduce excessive newlines', () => {
            const text = 'line1\n\n\n\n\nline2';
            const result = rewriter.cleanInternalLines(text);
            expect(result).not.toContain('\n\n\n');
        });

        it('should return text unchanged if null or undefined', () => {
            expect(rewriter.cleanInternalLines(null)).toBeNull();
            expect(rewriter.cleanInternalLines(undefined)).toBeUndefined();
        });
    });

    describe('stripAnsi', () => {
        it('should remove ANSI escape codes', () => {
            const text = '\u001b[31mRed text\u001b[0m normal';
            const result = rewriter.stripAnsi(text);
            expect(result).toBe('Red text normal');
        });

        it('should handle non-string input', () => {
            expect(rewriter.stripAnsi(null)).toBeNull();
            expect(rewriter.stripAnsi(undefined)).toBeUndefined();
        });
    });

    describe('rewriteStackString', () => {
        it('should rewrite datamodel paths in stack traces', () => {
            rewriter.modulePathMap.set('ReplicatedStorage.src.test', {
                luauPath: '/workspace/project/out/test.luau',
                sourcePath: '/workspace/project/src/test.ts',
            });
            
            fs.existsSync.mockReturnValue(true);
            fs.readFileSync.mockReturnValue('line1\nline2\nline3');
            
            const stack = 'Error at ReplicatedStorage.src.test:2';
            const result = rewriter.rewriteStackString(stack);
            expect(result).toContain('test.ts:2');
        });

        it('should clean internal lines from stack', () => {
            const stack = `Error
    at real.code:10
    at rbxts_include.node_modules.internal:20`;
            
            const result = rewriter.rewriteStackString(stack);
            expect(result).toContain('real.code:10');
            expect(result).not.toContain('rbxts_include');
        });

        it('should return non-string values unchanged', () => {
            expect(rewriter.rewriteStackString(null)).toBeNull();
            expect(rewriter.rewriteStackString(123)).toBe(123);
        });
    });

    describe('parseFrame', () => {
        it('should parse file path and line number', () => {
            fs.existsSync.mockReturnValue(true);
            const text = 'Error at src/test.ts:42:10';
            const result = rewriter.parseFrame(text);
            
            expect(result).toBeDefined();
            expect(result.line).toBe(42);
            expect(result.column).toBe(10);
        });

        it('should handle paths without column numbers', () => {
            fs.existsSync.mockReturnValue(true);
            const text = 'Error at src/test.ts:42';
            const result = rewriter.parseFrame(text);
            
            expect(result).toBeDefined();
            expect(result.line).toBe(42);
            expect(result.column).toBe(1);
        });

        it('should strip ANSI codes before parsing', () => {
            fs.existsSync.mockReturnValue(true);
            const text = 'Error at \u001b[31msrc/test.ts:42\u001b[0m';
            const result = rewriter.parseFrame(text);
            
            expect(result).toBeDefined();
            expect(result.line).toBe(42);
        });

        it('should return undefined if no valid frame found', () => {
            const text = 'Error with no file reference';
            const result = rewriter.parseFrame(text);
            expect(result).toBeUndefined();
        });
    });

    describe('buildCodeFrame', () => {
        it('should build code frame with context lines', () => {
            fs.existsSync.mockReturnValue(true);
            fs.readFileSync.mockReturnValue('line1\nline2\nline3\nline4\nline5');
            
            const result = rewriter.buildCodeFrame('/test.ts', 3, 1, 1);
            expect(result).toBeDefined();
            expect(result).toContain('line2');
            expect(result).toContain('line3');
            expect(result).toContain('line4');
        });

        it('should return undefined for non-existent file', () => {
            fs.existsSync.mockReturnValue(false);
            const result = rewriter.buildCodeFrame('/nonexistent.ts', 3);
            expect(result).toBeUndefined();
        });

        it('should handle edge cases at file boundaries', () => {
            fs.existsSync.mockReturnValue(true);
            fs.readFileSync.mockReturnValue('line1\nline2\nline3');
            
            const result = rewriter.buildCodeFrame('/test.ts', 1, 1, 2);
            expect(result).toBeDefined();
        });
    });

    describe('rewriteTestCase', () => {
        it('should rewrite failure messages in test case', () => {
            const testCase = {
                failureMessages: ['Error at ReplicatedStorage.src.test:10'],
                failureDetails: [],
            };
            
            rewriter.modulePathMap.set('ReplicatedStorage.src.test', {
                luauPath: '/workspace/project/out/test.luau',
                sourcePath: '/workspace/project/src/test.ts',
            });
            
            fs.existsSync.mockReturnValue(true);
            fs.readFileSync.mockReturnValue('line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nline9\nline10');
            
            rewriter.rewriteTestCase(testCase);
            
            expect(testCase.failureMessages[0]).toBeDefined();
        });

        it('should handle test cases without failures', () => {
            const testCase = {
                failureMessages: [],
            };
            
            expect(() => rewriter.rewriteTestCase(testCase)).not.toThrow();
        });
    });

    describe('extendTestFilePath', () => {
        it('should find existing file with .ts extension', () => {
            fs.existsSync
                .mockReturnValueOnce(true);
            
            const result = rewriter.extendTestFilePath('test');
            expect(result).toContain('test.ts');
        });

        it('should return original path if no extension matches', () => {
            fs.existsSync.mockReturnValue(false);
            
            const result = rewriter.extendTestFilePath('test');
            expect(result).toContain('test');
        });

        it('should handle null or undefined input', () => {
            const result = rewriter.extendTestFilePath(null);
            expect(result).toBeNull();
        });
    });

    describe('rewriteSuiteResult', () => {
        it('should rewrite test file path', () => {
            fs.existsSync.mockReturnValue(true);
            
            const suite = {
                testFilePath: 'src/test',
                testResults: [],
            };
            
            rewriter.rewriteSuiteResult(suite);
            expect(suite.testFilePath).toContain('src/test');
        });

        it('should rewrite all test results in suite', () => {
            const suite = {
                testFilePath: 'src/test.ts',
                testResults: [
                    { failureMessages: [] },
                    { failureMessages: [] },
                ],
            };
            
            fs.existsSync.mockReturnValue(true);
            fs.readFileSync.mockReturnValue('code');
            
            expect(() => rewriter.rewriteSuiteResult(suite)).not.toThrow();
        });

        it('should handle null suite', () => {
            expect(() => rewriter.rewriteSuiteResult(null)).not.toThrow();
        });
    });

    describe('rewriteParsedResults', () => {
        it('should rewrite all test suites in results', () => {
            fs.existsSync.mockReturnValue(true);
            fs.readFileSync.mockReturnValue('code');
            
            const results = {
                testResults: [
                    { testFilePath: 'src/test1.ts', testResults: [] },
                    { testFilePath: 'src/test2.ts', testResults: [] },
                ],
            };
            
            rewriter.rewriteParsedResults(results);
            expect(results.testResults.length).toBe(2);
        });

        it('should handle results without testResults', () => {
            expect(() => rewriter.rewriteParsedResults({})).not.toThrow();
            expect(() => rewriter.rewriteParsedResults(null)).not.toThrow();
        });
    });

    describe('formatFailureMessage', () => {
        it('should format test headers with color', () => {
            const message = '  ● test name';
            const result = rewriter.formatFailureMessage(message);
            expect(result).toBeDefined();
        });

        it('should format Expected and Received lines', () => {
            const message = '    Expected: 5\n    Received: 10';
            const result = rewriter.formatFailureMessage(message);
            expect(result).toContain('Expected:');
            expect(result).toContain('Received:');
        });

        it('should handle null or undefined input', () => {
            expect(rewriter.formatFailureMessage(null)).toBeNull();
            expect(rewriter.formatFailureMessage(undefined)).toBeUndefined();
        });
    });

    describe('highlightCode', () => {
        it('should highlight strings', () => {
            const code = 'const x = "hello";';
            const result = rewriter.highlightCode(code);
            expect(result).toBeDefined();
        });

        it('should highlight numbers', () => {
            const code = 'const x = 42;';
            const result = rewriter.highlightCode(code);
            expect(result).toBeDefined();
        });

        it('should handle null input', () => {
            expect(rewriter.highlightCode(null)).toBeNull();
        });
    });
});
