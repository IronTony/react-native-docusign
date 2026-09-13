// Fails when docs/ERROR_HANDLING.md and examples/error-handling drift apart.
// The examples are type-checked; this keeps the copies in the guide identical
// to them, so the published documentation is the code CI compiled.
const fs = require('fs');
const path = require('path');

// npm scripts run from the package root.
const root = process.cwd();
const guidePath = path.join(root, 'docs', 'ERROR_HANDLING.md');
const examplesDir = path.join(root, 'examples', 'error-handling');

const guide = fs.readFileSync(guidePath, 'utf8');
const blockPattern = /<!-- example: (\S+) -->\n```\w*\n([\s\S]*?)\n```/g;

function listExampleFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);
    return entry.isDirectory() ? listExampleFiles(fullPath) : [fullPath];
  });
}

const problems = [];
const embedded = new Set();

for (const [, relativePath, block] of guide.matchAll(blockPattern)) {
  embedded.add(relativePath);
  const filePath = path.join(root, relativePath);
  if (!fs.existsSync(filePath)) {
    problems.push(
      `${relativePath} is embedded in the guide but does not exist`,
    );
    continue;
  }
  if (fs.readFileSync(filePath, 'utf8').trimEnd() !== block.trimEnd()) {
    problems.push(`${relativePath} differs from its copy in the guide`);
  }
}

for (const filePath of listExampleFiles(examplesDir)) {
  const relativePath = path.relative(root, filePath).split(path.sep).join('/');
  if (!embedded.has(relativePath)) {
    problems.push(`${relativePath} is not embedded in the guide`);
  }
}

if (problems.length > 0) {
  console.error(problems.join('\n'));
  process.exit(1);
}

console.log(`docs/ERROR_HANDLING.md matches ${embedded.size} example files`);
