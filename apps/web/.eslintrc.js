/** @type {import("eslint").Linter.Config} */
module.exports = {
  root: true,
  extends: ["@provacx/eslint-config/next"],
  parserOptions: {
    project: "./tsconfig.json",
    tsconfigRootDir: __dirname,
  },
};
