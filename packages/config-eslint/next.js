/** @type {import("eslint").Linter.Config} */
module.exports = {
  extends: [
    "./base.js",
    "plugin:@next/next/recommended",
    "plugin:react/recommended",
    "plugin:react-hooks/recommended",
  ],
  plugins: ["react", "react-hooks"],
  settings: {
    react: {
      version: "detect",
    },
  },
  rules: {
    "react/react-in-jsx-scope": "off",
    "react/prop-types": "off",
    "@next/next/no-html-link-for-pages": "off",
  },
  globals: {
    React: true,
    JSX: true,
  },
};
