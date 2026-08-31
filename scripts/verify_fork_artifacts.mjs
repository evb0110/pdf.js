/* Copyright 2026 Mozilla Foundation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
/* EVB Viewer fork modification. See README.md and FORK_PROVENANCE.json. */

import { execFileSync } from "child_process";
import fs from "fs";

const readJSON = path => JSON.parse(fs.readFileSync(path));
const version = readJSON("build/version.json");
const packageJSON = readJSON("build/dist/package.json");
const provenance = readJSON("build/dist/FORK_PROVENANCE.json");
const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
const sourceTree = execFileSync("git", ["rev-parse", "HEAD^{tree}"], {
  encoding: "utf8",
}).trim();

if (
  version.sourceCommit !== sourceCommit ||
  version.sourceTree !== sourceTree
) {
  throw new Error("build/version.json does not identify the current source");
}
if (
  packageJSON.name !== "pdfjs-dist" ||
  packageJSON.version !== version.version ||
  packageJSON["x-evb-provenance"].sourceCommit !== sourceCommit
) {
  throw new Error("generated package metadata is not provenance-complete");
}
if (
  provenance.sourceBaseCommit !== version.sourceBaseCommit ||
  provenance.sourceBaseTree !== version.sourceBaseTree
) {
  throw new Error("fork provenance does not match the generated build");
}

for (const mapPath of [
  "build/dist/build/pdf.mjs.map",
  "build/dist/build/pdf.worker.mjs.map",
  "build/dist/build/pdf.sandbox.mjs.map",
  "build/dist/legacy/build/pdf.mjs.map",
  "build/dist/legacy/build/pdf.worker.mjs.map",
  "build/dist/legacy/build/pdf.sandbox.mjs.map",
]) {
  const sourceMap = readJSON(mapPath);
  if (
    sourceMap["x-evb-source-commit"] !== sourceCommit ||
    sourceMap["x-evb-source-tree"] !== sourceTree
  ) {
    throw new Error(`${mapPath} does not identify the current source`);
  }
}

console.log(`Verified pdfjs-dist ${version.version} for ${sourceCommit}`);
