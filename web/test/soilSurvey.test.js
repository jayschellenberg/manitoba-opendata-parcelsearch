import assert from 'node:assert/strict';
import { soilSurveyComponentsFromMatches } from '../src/soilSurvey.js';

function soilFeature(props) {
  return {
    type: 'Feature',
    geometry: null,
    properties: props,
  };
}

{
  const rows = soilSurveyComponentsFromMatches([
    {
      ratio: 1,
      feature: soilFeature({
        _paintColor: '#123456',
        MAPUNITNOM: 'RRv-S2',
        SOILNAME1: 'Red River',
        SOIL_CODE1: 'RR',
        AGRI_CAP1: '2W',
        AGCAP_CLS1: '2',
        SURFTEXT1: 'C',
        EXTENT1: 60,
        SOILNAME2: 'Osborne',
        SOIL_CODE2: 'OS',
        AGRI_CAP2: '3W',
        AGCAP_CLS2: '3',
        SURFTEXT2: 'SiC',
        EXTENT2: 40,
      }),
    },
  ]);

  assert.equal(rows.length, 2);
  assert.equal(rows[0].soilName, 'Red River');
  assert.equal(rows[0].parcelPct, 60);
  assert.equal(rows[0].paintColor, '#123456');
  assert.deepEqual(rows[0].mapUnits, ['RRv-S2']);
  assert.equal(rows[1].soilName, 'Osborne');
  assert.equal(rows[1].parcelPct, 40);
}

{
  const rows = soilSurveyComponentsFromMatches([
    {
      ratio: 0.5,
      feature: soilFeature({
        MAPUNITNOM: 'PG',
        SOILNAME1: 'Peguis',
        SOIL_CODE1: 'PG',
        AGRI_CAP1: '3W',
        AGCAP_CLS1: '3',
        EXTENT1: 100,
      }),
    },
    {
      ratio: 0.5,
      feature: soilFeature({
        MAPUNITNOM: 'MQ',
        SOILNAME1: 'Marquette',
        SOIL_CODE1: 'MQ',
        AGRI_CAP1: '3W',
        AGCAP_CLS1: '3',
        EXTENT1: 100,
      }),
    },
  ], { maxRows: 2, parcelAreaAcres: 160 });

  assert.equal(rows.length, 2);
  assert.equal(rows[0].soilName, 'Marquette');
  assert.equal(rows[0].parcelPct, 50);
  assert.equal(rows[0].areaAcres, 80);
  assert.equal(rows[1].soilName, 'Peguis');
  assert.equal(rows[1].parcelPct, 50);
  assert.equal(rows[1].areaAcres, 80);
}

{
  const rows = soilSurveyComponentsFromMatches([
    {
      ratio: 0.5,
      feature: soilFeature({
        MAPUNITNOM: 'A',
        SOILNAME1: 'Red River',
        SOIL_CODE1: 'RR',
        AGRI_CAP1: '2W',
        AGCAP_CLS1: '2',
        EXTENT1: 60,
        SOILNAME2: 'Osborne',
        SOIL_CODE2: 'OS',
        AGRI_CAP2: '3W',
        AGCAP_CLS2: '3',
        EXTENT2: 40,
      }),
    },
    {
      ratio: 0.25,
      feature: soilFeature({
        MAPUNITNOM: 'B',
        SOILNAME1: 'Red River',
        SOIL_CODE1: 'RR',
        AGRI_CAP1: '2W',
        AGCAP_CLS1: '2',
        EXTENT1: 100,
      }),
    },
  ]);

  assert.equal(rows.length, 2);
  assert.equal(rows[0].soilName, 'Red River');
  assert.equal(rows[0].parcelPct, 55);
  assert.deepEqual(rows[0].mapUnits, ['A', 'B']);
  assert.equal(rows[1].soilName, 'Osborne');
  assert.equal(rows[1].parcelPct, 20);
}

{
  const rows = soilSurveyComponentsFromMatches([
    {
      ratio: 0.8,
      feature: soilFeature({
        SOILNAME1: 'One',
        SOIL_CODE1: 'O1',
        SOILNAME2: 'Two',
        SOIL_CODE2: 'T2',
      }),
    },
  ]);

  assert.equal(rows.length, 2);
  assert.equal(rows[0].parcelPct, 40);
  assert.equal(rows[1].parcelPct, 40);
}

// Descriptors carry through the rollup and attribute to the largest-
// contributing polygon for each rolled-up soil association.
{
  const rows = soilSurveyComponentsFromMatches([
    {
      ratio: 0.30,
      feature: soilFeature({
        MAPUNITNOM: 'A',
        SOILNAME1: 'Red River',
        SOIL_CODE1: 'RR',
        AGRI_CAP1: '2W',
        AGCAP_CLS1: '2',
        EXTENT1: 100,
        // Slot 1 of polygon A: gentle slope, well-drained.
        TOPO1: 'c',
        STONE1: 'x',
        SALINITY1: 'x',
        EROSION1: 'x',
        DRAINAGE1: 'W',
        MANCON1: 'No Constraints',
        GEN_RATIN1: 'Good',
        SPUD_RTNG1: '2',
      }),
    },
    {
      ratio: 0.70,
      feature: soilFeature({
        MAPUNITNOM: 'B',
        SOILNAME1: 'Red River',
        SOIL_CODE1: 'RR',
        AGRI_CAP1: '2W',
        AGCAP_CLS1: '2',
        EXTENT1: 100,
        // Slot 1 of polygon B (the LARGER contributor): steeper +
        // imperfectly drained. The rollup should pick THESE values.
        TOPO1: 'd',
        STONE1: '2',
        SALINITY1: 's',
        EROSION1: '1',
        DRAINAGE1: 'I',
        MANCON1: 'CW',
        GEN_RATIN1: 'Fair',
        SPUD_RTNG1: '3',
      }),
    },
  ]);

  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.equal(r.soilName, 'Red River');
  // Largest-contributor descriptors won.
  assert.equal(r.topo, 'd');
  assert.equal(r.stone, '2');
  assert.equal(r.salinity, 's');
  assert.equal(r.erosion, '1');
  assert.equal(r.drainage, 'I');
  assert.equal(r.mancon, 'CW');
  assert.equal(r.genRatin, 'Fair');
  assert.equal(r.spudRtng, '3');
  // dominantPct internal-only tracker should NOT leak.
  assert.equal(r.dominantPct, undefined);
}

console.log('soilSurvey tests passed');
