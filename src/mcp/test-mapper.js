'use strict';

/**
 * test-mapper.js — bidirectional test-to-code mapping and test command generator.
 *
 * Provides deterministic mapping between source files and their corresponding
 * test suites across languages (JS/TS, Python, Go, Rust, Java, C#) using:
 *   1. Direct sibling test files (foo.test.ts, foo_test.go, test_foo.py)
 *   2. Nested __tests__ directories (src/auth/__tests__/jwt.test.ts)
 *   3. Mirrored top-level test directories (src/foo/bar.ts → test/foo/bar.test.js)
 *   4. Project test runner detection (vitest, jest, pytest, cargo test, go test)
 */

const fs = require('fs');
const path = require('path');
const { stemOf, isTestFile, isNonSourceFile, isIgnoredBasename } = require('./files-without-tests');

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Cached directory listing helper to avoid redundant filesystem syscalls.
 */
function buildListingCache() {
  const cache = new Map();
  return {
    list(absDir) {
      if (cache.has(absDir)) return cache.get(absDir);
      let entries = [];
      try {
        entries = fs.readdirSync(absDir);
      } catch {
        entries = [];
      }
      cache.set(absDir, entries);
      return entries;
    },
    exists(absPath) {
      try {
        return fs.existsSync(absPath);
      } catch {
        return false;
      }
    }
  };
}

/**
 * Detect the test runner framework and return a runnable CLI template.
 */
function detectTestRunner(projectRoot) {
  const pkgPath = path.join(projectRoot, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      const testScript = (pkg.scripts && pkg.scripts.test) || '';
      if (testScript.includes('vitest')) {
        return { runner: 'vitest', commandTemplate: 'npx vitest run {file}' };
      }
      if (testScript.includes('jest')) {
        return { runner: 'jest', commandTemplate: 'npx jest {file}' };
      }
      if (testScript.includes('mocha')) {
        return { runner: 'mocha', commandTemplate: 'npx mocha {file}' };
      }
      if (testScript) {
        return { runner: 'npm', commandTemplate: 'npm test {file}' };
      }
    } catch {
      // ignore
    }
    return { runner: 'npm', commandTemplate: 'npm test {file}' };
  }

  // Python
  if (fs.existsSync(path.join(projectRoot, 'pytest.ini')) ||
      fs.existsSync(path.join(projectRoot, 'setup.py')) ||
      fs.existsSync(path.join(projectRoot, 'pyproject.toml'))) {
    return { runner: 'pytest', commandTemplate: 'pytest {file}' };
  }

  // Rust
  if (fs.existsSync(path.join(projectRoot, 'Cargo.toml'))) {
    return { runner: 'cargo', commandTemplate: 'cargo test --test {stem}' };
  }

  // Go
  if (fs.existsSync(path.join(projectRoot, 'go.mod'))) {
    return { runner: 'go', commandTemplate: 'go test ./{dir}/...' };
  }

  return { runner: 'generic', commandTemplate: 'test {file}' };
}

/**
 * Find the matching test file for a given source file relative path.
 * Returns relative path to test file, or null if none found.
 */
function findTestForFile(projectRoot, relPath, listing = buildListingCache()) {
  if (isTestFile(relPath) || isNonSourceFile(relPath) || isIgnoredBasename(relPath)) {
    return null;
  }

  const normPath = relPath.replace(/\\/g, '/');
  const ext = path.posix.extname(normPath).toLowerCase();
  const stem = stemOf(normPath);
  const dir = path.posix.dirname(normPath);
  const parent = dir === '.' ? '' : path.posix.dirname(dir);

  const sameDirEntries = listing.list(path.join(projectRoot, dir));

  // 1. Sibling test files
  if (['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs'].includes(ext)) {
    const re = new RegExp(`^${escapeRegex(stem)}\\.(test|spec)\\.(js|jsx|mjs|cjs|ts|tsx)$`);
    const hit = sameDirEntries.find(e => re.test(e));
    if (hit) return path.posix.join(dir, hit);

    // __tests__ directory in same folder
    const testSubDir = listing.list(path.join(projectRoot, dir, '__tests__'));
    const subHit = testSubDir.find(e => re.test(e));
    if (subHit) return path.posix.join(dir, '__tests__', subHit);

    // Mirrored test/ or tests/ directory at top-level (e.g. src/auth/jwt.ts -> test/auth/jwt.test.js)
    const strippedPrefix = normPath.startsWith('src/') ? normPath.slice(4) : normPath;
    const strippedDir = path.posix.dirname(strippedPrefix);

    for (const testRoot of ['test', 'tests', '__tests__']) {
      const mirrorDir = strippedDir === '.' ? testRoot : path.posix.join(testRoot, strippedDir);
      const mirrorEntries = listing.list(path.join(projectRoot, mirrorDir));
      const mirrorHit = mirrorEntries.find(e => re.test(e));
      if (mirrorHit) return path.posix.join(mirrorDir, mirrorHit);
    }
  } else if (ext === '.py') {
    const hit = sameDirEntries.find(e => e === `test_${stem}.py` || e === `${stem}_test.py`);
    if (hit) return path.posix.join(dir, hit);

    const strippedPrefix = normPath.startsWith('src/') ? normPath.slice(4) : normPath;
    const strippedDir = path.posix.dirname(strippedPrefix);
    for (const testRoot of ['tests', 'test']) {
      const mirrorDir = strippedDir === '.' ? testRoot : path.posix.join(testRoot, strippedDir);
      const mirrorEntries = listing.list(path.join(projectRoot, mirrorDir));
      const mirrorHit = mirrorEntries.find(e => e === `test_${stem}.py` || e === `${stem}_test.py`);
      if (mirrorHit) return path.posix.join(mirrorDir, mirrorHit);
    }
  } else if (ext === '.go') {
    const hit = sameDirEntries.find(e => e === `${stem}_test.go`);
    if (hit) return path.posix.join(dir, hit);
  } else if (ext === '.rs') {
    const mirrorDir = 'tests';
    const mirrorEntries = listing.list(path.join(projectRoot, mirrorDir));
    const mirrorHit = mirrorEntries.find(e => e === `${stem}.rs` || e === `test_${stem}.rs`);
    if (mirrorHit) return path.posix.join(mirrorDir, mirrorHit);
  }

  return null;
}

/**
 * Given a list of files, find matching test files.
 * Returns Array<{ file: string, testFile: string }>
 */
function findTestsForFiles(projectRoot, files) {
  const listing = buildListingCache();
  const results = [];
  const seen = new Set();

  for (const raw of files || []) {
    const file = typeof raw === 'string' ? raw : (raw && raw.file);
    if (!file || seen.has(file)) continue;
    seen.add(file);

    const testFile = findTestForFile(projectRoot, file, listing);
    if (testFile) {
      results.push({ file, testFile });
    }
  }

  return results;
}

/**
 * Given a list of modified files, return matching test files and runnable commands.
 */
function getTestsForChange(projectRoot, files) {
  const pairs = findTestsForFiles(projectRoot, files);
  const runner = detectTestRunner(projectRoot);

  return pairs.map(({ file, testFile }) => {
    const stem = stemOf(testFile);
    const dir = path.posix.dirname(testFile);
    let command = runner.commandTemplate
      .replace('{file}', testFile)
      .replace('{stem}', stem)
      .replace('{dir}', dir);

    return {
      file,
      testFile,
      command,
      runner: runner.runner
    };
  });
}

module.exports = {
  detectTestRunner,
  findTestForFile,
  findTestsForFiles,
  getTestsForChange,
};
