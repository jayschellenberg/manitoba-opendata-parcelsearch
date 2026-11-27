// Municipality name (Roll Entry's Muni_Name_With_Typ) -> Statistics Canada
// census subdivision code(s), for the preliminary report's census section.
//
// The census figures come from Housing & Economic Data's census-summary.json,
// keyed by CSD code with StatCan names such as "Steinbach (CY)". Most
// municipalities match on name plus type once accents and punctuation are
// stripped (178 of the 186 Roll Entry names, checked 2026-11-27). The rest
// are renamed, split or merged CSDs and are listed in OVERRIDES. Northern
// communities and settlements have no CSD of their own (they sit inside an
// unorganized division), so they resolve to an empty list and the report
// says so instead of borrowing a neighbour's figures.

// Roll Entry type -> StatCan CSD type abbreviation.
const TYPE = {
  CITY: 'CY', TOWN: 'T', VILLAGE: 'VL', RM: 'RM', MUNICIPALITY: 'MU',
  LGD: 'LGD', 'LOCAL GOVERNMENT DISTRICT': 'LGD',
};

export const OVERRIDES = Object.freeze({
  'FLIN FLON (CITY)': ['4621064'],                      // Flin Flon (Part) (CY): the Manitoba part
  'KILLARNEY TURTLE MOUNTAIN (MUNICIPALITY)': ['4605025'], // StatCan types it RM
  'MINTO-ODANAH (RM)': ['4615074'],                      // StatCan types it MU
  'MOSSEY RIVER (MUNICIPALITY)': ['4617072'],            // StatCan types it RM
  'MOUNTAIN (RM)': ['4620032', '4620055'],               // StatCan splits it North and South
  'ROBLIN (MUNICIPALITY)': ['4616048'],                  // Hillsburg-Roblin-Shell River (MU)
  'WEST INTERLAKE (RM)': ['4618056'],                    // StatCan types it MU
  'YELLOWHEAD (MUNICIPALITY)': ['4615063'],              // StatCan types it RM
});

export const normName = (s) => String(s ?? '')
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toUpperCase().replace(/[^A-Z0-9]/g, '');

/** Split "PINEY (RM)" into ["PINEY", "RM"]; the type may contain spaces. */
export function splitMuniName(name) {
  const m = /^(.*?)\s*\(([^()]+)\)\s*$/.exec(String(name ?? '').trim());
  return m ? [m[1], m[2].trim()] : [String(name ?? '').trim(), ''];
}

/** True for places with no census subdivision of their own. */
export function isUnorganizedPlace(muniName) {
  return /NORTHERN (COMMUNITY|SETTLEMENT)|INDIGENOUS\s*&\s*NORTHERN/i.test(String(muniName ?? ''));
}

/**
 * Resolve a municipality to CSD codes against the census-summary regions.
 * Returns an array (usually one code; two for Mountain RM; empty when the
 * place has no CSD or nothing matched).
 */
export function csdCodesFor(muniName, regions) {
  const key = String(muniName ?? '').trim().toUpperCase().replace(/\s+/g, ' ');
  if (OVERRIDES[key]) return [...OVERRIDES[key]];
  if (!key || isUnorganizedPlace(key)) return [];
  const [base, type] = splitMuniName(key);
  const want = normName(base);
  const csds = (regions || []).filter((r) => r.level === 'CSD');
  const named = csds.filter((r) => normName(splitMuniName(r.name)[0]) === want);
  const typed = named.filter((r) => splitMuniName(r.name)[1] === TYPE[type]);
  if (typed.length) return typed.map((r) => r.uid);
  // A unique name match with a different type still identifies the place.
  return named.length === 1 ? [named[0].uid] : [];
}
