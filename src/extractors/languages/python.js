'use strict';

const { extractRoutes } = require('../routes');
const { extractModels } = require('../models');
const { extractEnvVars } = require('../envvars');
const { extractDBTables } = require('../dbtables');
const tsParser = require('../tree-sitter-parser');
const { extractPythonFrameworkRoutes } = require('../frameworks');

module.exports = {
  name: 'python',
  extensions: ['.py'],
  extract(content, filename) {
    try {
      // Fast path: tree-sitter for imports + symbols
      const { imports: tsImports, symbols: tsSymbols } = tsParser.isAvailable()
        ? tsParser.extractAll(content, '.py')
        : { imports: [], symbols: [] };

      // Keep regex-based extractors for routes, models, env vars, db tables
      // (tree-sitter doesn't do deep FastAPI/Django/Flask route extraction)
      const mainRoutes = extractRoutes(content);
      const frameworkRoutes = extractPythonFrameworkRoutes(content);
      // Merge + dedupe (Sanic/Quart/Tornado long-tail)
      const seen = new Set(mainRoutes.map(r => `${r.method}::${r.path}`));
      const extra = frameworkRoutes.filter(r => {
        const key = `${r.method}::${r.path}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      return {
        routes:      [...mainRoutes, ...extra],
        models:      extractModels(content),
        functions:   tsSymbols.length > 0
          ? tsSymbols.filter(s => s.kind === 'function').map(s => ({ name: s.name, params: '—', returnType: '—' }))
          : extractFunctions(content, filename),
        envVars:     extractEnvVars(content),
        dbTables:    extractDBTables(content),
        fetches:     [],
        storageKeys: [],
        _tsImports:  tsImports,
        _tsSymbols:  tsSymbols,
      };
    } catch (err) {
      console.warn(`[CARTO] python plugin error on ${filename}: ${err.message}`);
      return {
        routes: [], models: [], functions: [], envVars: [], dbTables: [], fetches: [], storageKeys: [],
        // Record the failure so it's visible in `carto check`.
        _errors: [{ phase: 'extract', message: err.message || String(err) }],
      };
    }
  }
};

/**
 * Fallback regex function extractor for Python when tree-sitter is unavailable.
 */
function extractFunctions(content, filename) {
  const functions = [];
  const lines = content.split('\n');

  const collapsed = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^(async\s+)?def\s+\w+\s*\(/.test(line)) {
      let combined = line;
      let safety = 0;
      while (!combined.includes(')') && safety < 10 && i + 1 < lines.length) {
        i++;
        safety++;
        combined += ' ' + lines[i].trim();
      }
      collapsed.push(combined);
    }
  }

  const defPattern = /^(async\s+)?def\s+(\w+)\s*\(([^)]*)\)\s*(?:->\s*(.+?))?\s*:/;

  for (const line of collapsed) {
    const match = line.match(defPattern);
    if (!match) continue;

    const name = match[2];
    if (name.startsWith('__')) continue;

    const rawParams = match[3];
    const returnType = match[4] ? match[4].trim() : '\u2014';

    const skipParams = new Set(['self', '']);
    const params = splitParams(rawParams)
      .map(p => {
        let cleaned = p.split(':')[0];
        cleaned = cleaned.split('=')[0];
        cleaned = cleaned.replace(/^\*{1,2}/, '');
        return cleaned.trim();
      })
      .filter(p => !skipParams.has(p));

    functions.push({
      name,
      params: params.length > 0 ? params.join(', ') : '\u2014',
      returnType
    });
  }

  return functions;
}

function splitParams(rawParams) {
  const params = [];
  let depth = 0;
  let current = '';
  for (const char of rawParams) {
    if (char === '[' || char === '(' || char === '{') depth++;
    else if (char === ']' || char === ')' || char === '}') depth--;
    else if (char === ',' && depth === 0) {
      params.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  if (current.trim()) params.push(current.trim());
  return params;
}

module.exports.extractFunctions = extractFunctions;
