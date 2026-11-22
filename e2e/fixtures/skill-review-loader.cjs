// Tiny test-only TypeScript loader for the isolated browser fixture.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const ts = require("typescript");
module.exports = function (source) {
  return ts.transpileModule(source, { fileName: this.resourcePath, compilerOptions: {
    jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext,
    esModuleInterop: true,
  } }).outputText;
};
