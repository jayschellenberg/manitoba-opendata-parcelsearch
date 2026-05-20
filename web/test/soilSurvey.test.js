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

console.log('soilSurvey tests passed');
