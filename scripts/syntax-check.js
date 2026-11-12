const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOTS = ["server.js", "src", "scripts"];
const files = [];

function collect(entry) {
  const full = path.join(__dirname, "..", entry);
  const stat = fs.statSync(full);
  if (stat.isDirectory()) {
    for (const item of fs.readdirSync(full)) {
      collect(path.join(entry, item));
    }
  } else if (full.endsWith(".js")) {
    files.push(full);
  }
}

for (const root of ROOTS) {
  collect(root);
}

for (const file of files) {
  execFileSync(process.execPath, ["--check", file], { stdio: "inherit" });
}

console.log(`[syntax-check] Passed (${files.length} JS files).`);

