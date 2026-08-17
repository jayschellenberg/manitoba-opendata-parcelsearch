// Unit tests for lib/salesCoverage.js — the scrape-coverage view's logic.
// The cases that matter: a full `coverage` table (new exports, never-scraped
// municipalities included), the munis-only fallback (old exports — captured
// municipalities only, shard presence implies 'done'), and a manifest with
// neither (null, so the dialog can say "re-export").
//
// Run: cd web && node test/salesCoverage.test.js

import assert from 'node:assert/strict';
import {
  coverageRows, coverageSummary, statusLabel, nextFullScrape, refreshNote,
} from '../src/lib/salesCoverage.js';

// ---- next full scrape / refresh cells --------------------------------------
{
  // Export ships next_scrape: use it verbatim (as a month label).
  const shipped = { status: 'done', lastScraped: '2026-08-16', cadenceMonths: 6, nextScrape: '2027-02' };
  assert.equal(nextFullScrape(shipped), 'February 2027');
  // Older export without next_scrape: compute from cadence.
  const computed = { status: 'done', lastScraped: '2026-08-16', cadenceMonths: 6, nextScrape: null };
  assert.equal(nextFullScrape(computed), 'February 2027');
  // No cadence known: no claim.
  assert.equal(nextFullScrape({ status: 'done', lastScraped: '2026-08-16', cadenceMonths: null, nextScrape: null }), null);
  // Pending municipalities are in the current sweep.
  assert.equal(nextFullScrape({ status: 'never' }), 'current sweep');

  assert.equal(refreshNote({ status: 'done' }), 'every ~4-5 days');
  assert.equal(refreshNote({ status: 'never' }), null);
}

// ---- coverage array (new export) -------------------------------------------
{
  const manifest = {
    coverage: [
      { muni_no: '500', municipality: 'CITY OF BRANDON', list_name: 'BRANDON (CITY)',
        region: 'West & Parkland', status: 'done', last_scraped: '2026-08-16',
        sales: 46506, newest_sale: '2026-07-30', capped_rows: 0 },
      { muni_no: '411', municipality: 'CITY OF DAUPHIN', list_name: 'DAUPHIN (CITY)',
        region: 'West & Parkland', status: 'done', last_scraped: '2026-08-15', sales: 9100 },
      // Never scraped: no ledger entry, no shard — only identity fields ship.
      { muni_no: '702', municipality: 'LGD OF PINAWA', list_name: 'PINAWA (LGD)',
        region: 'Southeast', status: 'never' },
      { muni_no: '208', municipality: 'RM OF HEADINGLEY', list_name: 'HEADINGLEY (RM)',
        region: 'Winnipeg', status: 'error', last_scraped: '2026-08-11', sales: 3000 },
    ],
    munis: [{ muni_no: '500', municipality: 'CITY OF BRANDON' }],
  };
  const cov = coverageRows(manifest);
  assert.equal(cov.complete, true);
  assert.equal(cov.rows.length, 4);
  // Sorted by place-first label, so BRANDON < DAUPHIN < HEADINGLEY < PINAWA.
  assert.deepEqual(cov.rows.map((r) => r.no), ['500', '411', '208', '702']);
  assert.equal(cov.rows[0].label, 'BRANDON (CITY)');
  assert.equal(cov.rows[3].status, 'never');
  assert.equal(cov.rows[3].sales, null);

  const sum = coverageSummary(cov);
  assert.equal(sum.scraped, 2);              // done only; error is not coverage
  assert.equal(sum.total, 4);
  assert.equal(sum.latest, '2026-08-16');

  assert.equal(statusLabel(cov.rows[0]), 'scraped Aug 16, 2026');
  assert.equal(statusLabel(cov.rows[3]), 'not yet scraped');
  assert.equal(statusLabel(cov.rows[2]), 'error — retried automatically');
}

// ---- munis fallback (old export, no coverage array) ------------------------
{
  const manifest = {
    munis: [
      { muni_no: '129', municipality: 'RM OF GIMLI', list_name: 'GIMLI (RM)',
        region: 'Interlake', sales: 5200, scraped_at: '2026-08-10' },
      // Pre-scraped_at export: shard exists, no date. Still counts as done.
      { muni_no: '447', municipality: 'CITY OF SELKIRK', sales: 7411 },
    ],
  };
  const cov = coverageRows(manifest);
  assert.equal(cov.complete, false);
  assert.equal(cov.rows.length, 2);
  // No list_name falls back to the municipality name, which sorts by its
  // prefix — so "CITY OF SELKIRK" lands before "GIMLI (RM)". Same accepted
  // behaviour as the muni picker's fallback labels.
  assert.equal(cov.rows[0].label, 'CITY OF SELKIRK');
  assert.equal(cov.rows[0].lastScraped, null);
  assert.equal(statusLabel(cov.rows[0]), 'scraped');
  assert.equal(cov.rows[1].label, 'GIMLI (RM)');
  assert.equal(cov.rows[1].status, 'done');
  assert.equal(cov.rows[1].lastScraped, '2026-08-10');

  const sum = coverageSummary(cov);
  assert.equal(sum.scraped, 2);
  assert.equal(sum.total, null);             // universe unknown without coverage
  assert.equal(sum.latest, '2026-08-10');
}

// ---- nothing usable --------------------------------------------------------
{
  assert.equal(coverageRows(null), null);
  assert.equal(coverageRows({}), null);
  assert.equal(coverageRows({ munis: [] }), null);
  assert.equal(coverageSummary(null), null);
  assert.equal(coverageSummary({ rows: [] }), null);
}

console.log('salesCoverage: all assertions passed');
