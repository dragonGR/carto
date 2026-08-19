'use strict';

/**
 * breaking-changes.js — semantic breaking change detector for code diffs.
 *
 * Inspects removed and modified lines in unified diffs to detect:
 *   - Removed exported functions, classes, types, interfaces, or variables.
 *   - Deleted files that still have active dependent callers in the index.
 *   - Cross-references each removed export with the SQLite import graph to find
 *     the exact downstream callers broken by the change.
 */

const EXPORT_PATTERNS = [
  /^(?:export\s+)?(?:async\s+)?function\s+([a-zA-Z0-9_$]+)/,
  /^export\s+(?:const|let|var)\s+([a-zA-Z0-9_$]+)/,
  /^(?:export\s+)?class\s+([a-zA-Z0-9_$]+)/,
  /^(?:export\s+)?interface\s+([a-zA-Z0-9_$]+)/,
  /^(?:export\s+)?type\s+([a-zA-Z0-9_$]+)/,
  /^(?:export\s+)?enum\s+([a-zA-Z0-9_$]+)/,
  /^def\s+([a-zA-Z0-9_]+)\s*\(/,
  /^pub\s+fn\s+([a-zA-Z0-9_]+)/,
  /^func\s+(?:\([^)]+\)\s+)?([a-zA-Z0-9_]+)\s*\(/,
];

function extractExportedSymbolName(line) {
  const trimmed = line.trim().replace(/^[-+]\s*/, '');
  for (const pat of EXPORT_PATTERNS) {
    const m = trimmed.match(pat);
    if (m && m[1]) return m[1];
  }
  return null;
}

/**
 * Identify symbols that were removed and not re-added in the diff for a file.
 */
function extractRemovedExports(file) {
  if (!file || !Array.isArray(file.removed)) return [];

  const addedSymbols = new Set();
  for (const a of file.added || []) {
    const name = extractExportedSymbolName(a.content || '');
    if (name) addedSymbols.add(name);
  }

  const removedSymbols = new Set();
  for (const r of file.removed) {
    const name = extractExportedSymbolName(r.content || '');
    if (name && !addedSymbols.has(name)) {
      removedSymbols.add(name);
    }
  }

  return [...removedSymbols];
}

/**
 * Detect breaking changes across all parsed files in a diff.
 * Returns Array<{ kind, severity, file, message, symbol, callers }>
 */
function detectBreakingChanges(parsedFiles, store) {
  if (!store || !store.db || !Array.isArray(parsedFiles)) return [];
  const violations = [];

  for (const file of parsedFiles) {
    const filePath = file.path || file.oldPath;
    if (!filePath) continue;

    const removedSymbols = extractRemovedExports(file);
    if (removedSymbols.length === 0) continue;

    const targetRow = store.db.prepare('SELECT id FROM files WHERE path = ?').get(filePath);
    if (!targetRow) continue;

    for (const sym of removedSymbols) {
      // Find all files that import this specific symbol
      let callers = [];
      try {
        const rows = store.db.prepare(`
          SELECT DISTINCT f.path
          FROM imports i
          JOIN files f ON i.from_file_id = f.id
          WHERE i.to_file_id = ? AND (i.symbol_name = ? OR i.symbol_name IS NULL)
        `).all(targetRow.id, sym);
        callers = rows.map(r => r.path).filter(p => p !== filePath);
      } catch {
        callers = [];
      }

      if (callers.length > 0) {
        violations.push({
          kind: 'breaking_change',
          severity: 'HIGH',
          file: filePath,
          message: `Removed exported symbol "${sym}" which is imported by ${callers.length} file(s) (${callers.slice(0, 3).join(', ')}).`,
          symbol: sym,
          callers,
        });
      }
    }
  }

  return violations;
}

module.exports = {
  extractRemovedExports,
  detectBreakingChanges,
};
