import { rspack } from "@rspack/core";
import type { Configuration } from "@rspack/core";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const config: Configuration = {
  mode: "production",
  entry: path.join(root, "src/main.tsx"),
  output: { path: path.join(root, "dist"), filename: "app.js", publicPath: "/", clean: true },
  resolve: { extensions: [".tsx", ".ts", ".jsx", ".js"] },
  module: {\n    rules: [{ test: /\\.css$/, type: "css" }, { test: /\.tsx?$/, use: [{ loader: "builtin:swc-loader", options: { jsc: { parser: { syntax: "typescript", tsx: true }, transform: { react: { runtime: "automatic" } } } } }] }]
  },
  plugins: [new rspack.HtmlRspackPlugin({ template: path.join(root, "src/index.html") })],
  optimization: { minimize: true }
};
export default config;
