import { rspack } from "@rspack/core";
import type { Configuration } from "@rspack/core";
import path from "node:path";

const config: Configuration = {
  mode: "production",
  entry: "./src/main.tsx",
  output: { path: path.resolve(__dirname, "dist"), filename: "app.js", clean: true },
  resolve: { extensions: [".tsx", ".ts", ".jsx", ".js"] },
  module: {
    rules: [{ test: /\.tsx?$/, use: [{ loader: "builtin:swc-loader", options: { jsc: { parser: { syntax: "typescript", tsx: true }, transform: { react: { runtime: "automatic" } } } } }] }]
  },
  plugins: [new rspack.HtmlRspackPlugin({ template: "./src/index.html" })],
  optimization: { minimize: true }
};
export default config;
