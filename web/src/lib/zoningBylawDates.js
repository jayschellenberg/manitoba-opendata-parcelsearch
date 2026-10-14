// Effective dates of the zoning by-laws in the Province's
// Manitoba_Zoning_By_Laws layer, which publishes the by-law number (ZBL)
// but no date. Read from the by-laws themselves (cached PDFs under
// Appraisal\Maps and the municipalities' own pages) — never inferred from
// the number. A by-law missing here just shows no date on the Addenda
// Pack's zoning map; add it when you read one.
//
// Key: the layer's ZBL exactly as published (trimmed), or "ZBL|MUNI_NAME"
// where two municipalities share a number. Value: 'YYYY-MM-DD' — third
// reading, or the in-force date when the by-law states a separate one.

export const ZONING_BYLAW_DATES = {
};
