// Builds dist/simulator.html: the web chat simulator as one self-contained page.
import { build } from "esbuild";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const result = await build({
  entryPoints: ["src/messaging/simulator/web/entry.ts"],
  bundle: true,
  format: "iife",
  target: "es2020",
  write: false,
  minify: true,
});
const bundle = result.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");
const template = readFileSync("src/messaging/simulator/web/template.html", "utf8");
mkdirSync("dist", { recursive: true });
writeFileSync("dist/simulator.html", template.replace("/*__NODSIM_BUNDLE__*/", () => bundle));
console.log("wrote dist/simulator.html");
