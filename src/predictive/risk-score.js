'use strict';

/**
 * Predictive risk scoring.
 *
 * Combines temporal + structural + intervention history into a single
 * 0–1 score per file: P(this file causes the next incident).
 *
 * Inputs:
 *   - blast_radius          how many transitive dependents (centrality column)
 *   - commit_count          temporal churn
 *   - cross_domain          is the file in cross-domain edges
 *   - intervention_count    past HIGH-severity interventions
 *   - test_present          has a detected test file
 *
 * Formula (additive, normalized to 0–1):
 *   risk =   0.30 * normalized_blast
 *         +  0.25 * normalized_churn
 *         +  0.20 * cross_domain ? 1 : 0
 *         +  0.15 * normalized_interventions
 *         +  0.10 * test_present ? 0 : 1
 *
 * Each term capped at 1 before weighting. Final score is the weighted sum;
 * naturally in [0, 1] because weights sum to 1.
 */

const path = require('path');

const WEIGHTS = {
  blast: 0.30,
  churn: 0.25,
  cross: 0.20,
  intervention: 0.15,
  noTest: 0.10,
};

function clampUnit(x) {
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

/**
 * scoreFiles({ store, temporalStore, projectRoot, files? }) → ranked Array
 *
 * If `files` is provided, scores only those; otherwise scores all files.
 * Returns [{ path, score, components }] sorted by score DESC.
 */
function scoreFiles({ store, temporalStore = null, projectRoot, files = null }) {
  if (!store || !store.db) return [];

  // Normalization bases.
  const maxBlast = (store.db.prepare('SELECT MAX(centrality) as m FROM files').get() || {}).m || 1;
  const maxChurn = temporalStore && temporalStore.db
    ? (temporalStore.db.prepare('SELECT MAX(commit_count) as m FROM file_churn').get() || {}).m || 1
    : 1;

  // Cross-domain edges set.
  const crossSet = new Set();
  try {
    const rows = store.getCrossDomainDeps() || [];
    for (const r of rows) crossSet.add(r.from);
  } catch {}

  // Intervention counts per file.
  const ivCounts = new Map();
  try {
    const rows = store.db.prepare(`
      SELECT file, COUNT(*) as c FROM interventions
      WHERE file IS NOT NULL AND severity IN ('HIGH', 'critical')
      GROUP BY file
    `).all();
    for (const r of rows) ivCounts.set(r.file, r.c);
  } catch {}
  let maxIv = 1;
  for (const c of ivCounts.values()) {
    if (c > maxIv) maxIv = c;
  }

  // Tests-present set, via the files-without-tests detector.
  const { filesWithoutTests } = require('../mcp/files-without-tests');
  let withoutTests = new Set();
  try {
    const allFiles = files || store.db.prepare('SELECT path FROM files').all().map(r => r.path);
    const r = filesWithoutTests(projectRoot, allFiles);
    withoutTests = new Set(r.files || []);
  } catch {}

  // Churn map pre-fetch (eliminates N+1 queries).
  const churnMap = new Map();
  if (temporalStore && temporalStore.db) {
    try {
      const churnRows = typeof temporalStore.getAllChurn === 'function'
        ? temporalStore.getAllChurn()
        : temporalStore.db.prepare('SELECT file_path, commit_count FROM file_churn').all();
      for (const cr of churnRows) {
        const fp = cr.file_path || cr.path;
        if (fp) churnMap.set(fp, cr.commit_count || 0);
      }
    } catch {}
  }

  // Score each file.
  const targetSet = Array.isArray(files) && files.length > 0 ? new Set(files) : null;
  const allRows = store.db.prepare('SELECT path, centrality FROM files').all();
  const rows = targetSet ? allRows.filter(r => targetSet.has(r.path)) : allRows;

  const out = [];
  for (const r of rows) {
    const blast = clampUnit((r.centrality || 0) / Math.max(1, maxBlast));
    const commitCount = churnMap.get(r.path) || 0;
    const churn = clampUnit(commitCount / Math.max(1, maxChurn));
    const cross = crossSet.has(r.path) ? 1 : 0;
    const iv = clampUnit((ivCounts.get(r.path) || 0) / Math.max(1, maxIv));
    const noTest = withoutTests.has(r.path) ? 1 : 0;

    const score =
      WEIGHTS.blast * blast +
      WEIGHTS.churn * churn +
      WEIGHTS.cross * cross +
      WEIGHTS.intervention * iv +
      WEIGHTS.noTest * noTest;

    out.push({
      path: r.path,
      score: Math.round(score * 1000) / 1000,
      components: { blast, churn, cross, intervention: iv, no_test: noTest },
    });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

module.exports = { scoreFiles, WEIGHTS };
