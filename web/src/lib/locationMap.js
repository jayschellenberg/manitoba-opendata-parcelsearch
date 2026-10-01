// Province location map — the NRCan "Manitoba" overview page with a
// SUBJECT callout pointing at the searched property, for the location-map
// figure at the front of an appraisal report.
//
// The base map is public/manitoba-overview.svg, converted once from
// D:\Dropbox\Appraisal\Maps\Manitoba\Canada Manitoba Overview Map.pdf
// (© 2001 NRCan, Atlas of Canada). It is fully vector — no raster inside —
// so the browser re-rasterises it at whatever output size we ask for and
// the figure stays as crisp as the PDF.
//
// REBUILDING THE SVG. The PDF does not embed its fonts, so a straight
// conversion draws every label in a substitute serif and every town dot
// (a Wingdings glyph) as a bar. Embed the real Windows fonts first with
// Ghostscript, mapping the comma-styled names explicitly — without the map
// the Bold / Italic / Narrow variants still fall back to Times:
//   Fontmap.mb:  /Verdana,Bold (C:/Windows/Fonts/verdanab.ttf) ;  and the
//                same for Verdana, Verdana,Italic, ArialNarrow,Bold,
//                TimesNewRoman,Bold,Italic, Georgia, Wingdings-Regular
//   gswin64c -dNOPAUSE -dBATCH -sDEVICE=pdfwrite -dEmbedAllFonts=true
//            -sFONTMAP=<absolute path>/Fontmap.mb -o emb.pdf <source>.pdf
//   python: fitz.open('emb.pdf')[0].get_svg_image(text_as_path=True)
// Coordinates throughout this module
// are that page's points: 366.73 × 489.55, origin top-left, y down (the
// SVG's viewBox is the same frame).
//
// GEOREFERENCING. The page is Lambert Conformal Conic, standard parallels
// 49° and 77° (the Atlas of Canada projection). Fitting an affine to the
// LCC coordinates of the map's own graticule vertices — the 49th-parallel
// border at -101..-96 and the 60th at -102..-95, 14 points — reproduces
// all of them to 0.003 pt, so the projection and the transform below are
// exact for this page. The TOWN DOTS are not: the cartographer nudged
// them for legibility, 1.6 pt RMS (≈4 km) against the gazetteer in the
// south, so a subject in Steinbach lands about 0.8 pt off the Steinbach
// dot. Fitting to the dots instead would trade a true position for a
// visually nudged one; the graticule wins. LCC's central meridian is
// arbitrary here (the affine absorbs the rotation); -95 is just the value
// the constants were fitted with and must not change without them.
//
// Pure apart from renderLocationMap(), which needs a canvas — everything
// else unit-tests in node (test/locationMap.test.js).

/** Page size in points — the SVG viewBox. */
export const PAGE_W = 366.73298;
export const PAGE_H = 489.54597;

// GRS80, LCC 49/77, origin 49°N 95°W.
const A = 6378137.0;
const FL = 1 / 298.257222101;
const E = Math.sqrt(2 * FL - FL * FL);
const RAD = Math.PI / 180;
const m = (p) => Math.cos(p) / Math.sqrt(1 - E * E * Math.sin(p) ** 2);
const t = (p) => Math.tan(Math.PI / 4 - p / 2)
  / ((1 - E * Math.sin(p)) / (1 + E * Math.sin(p))) ** (E / 2);
const P1 = 49 * RAD;
const P2 = 77 * RAD;
const LAT0 = 49 * RAD;
const LON0 = -95 * RAD;
const N_ = (Math.log(m(P1)) - Math.log(m(P2))) / (Math.log(t(P1)) - Math.log(t(P2)));
const F_ = m(P1) / (N_ * t(P1) ** N_);
const R0 = A * F_ * t(LAT0) ** N_;

// Affine from LCC metres to page points, least-squares on the graticule.
const AX = [0.00037731844780214814, -1.9768553984621283e-05, 190.50720105713833];
const AY = [-1.964642960892757e-05, -0.00037730478038530354, 463.99270547640856];

/** [lng, lat] → [x, y] in page points. */
export function lngLatToPage(lng, lat) {
  const r = A * F_ * t(lat * RAD) ** N_;
  const th = N_ * (lng * RAD - LON0);
  const e = r * Math.sin(th);
  const n = R0 - r * Math.cos(th);
  return [AX[0] * e + AX[1] * n + AX[2], AY[0] * e + AY[1] * n + AY[2]];
}

/** Rough Manitoba bounds — anything outside cannot be drawn on this page. */
export function isInManitoba(lng, lat) {
  return lat >= 48.99 && lat <= 60.01 && lng >= -102.05 && lng <= -88.9;
}

// Areas the callout box should not cover, page points [x0, y0, x1, y1]:
// every text span (town and lake names, legend, scale, credit lines), the
// Canada inset, the scale bar, and a 5 pt square on every town dot.
// Extracted from the PDF alongside the SVG.
export const OBSTACLES = [
  [245.6,421.0,303.9,428.0],[205.8,436.4,214.1,443.4],[336.9,436.4,345.2,443.4],[245.0,429.9,248.2,436.9],[214.8,430.1,221.2,437.1],[271.7,430.2,278.1,437.2],
  [298.3,430.1,307.9,437.1],[326.6,430.1,336.2,437.1],[118.2,472.6,361.2,478.6],[118.2,480.6,364.5,486.6],[192.7,310.4,200.1,320.3],[231.1,279.8,301.8,286.2],
  [241.9,309.4,331.9,315.8],[241.9,316.6,313.8,323.0],[232.3,313.0,238.7,319.4],[241.9,291.0,310.3,297.4],[241.9,298.2,312.9,304.6],[231.9,295.2,238.3,301.6],
  [251.8,327.2,341.6,333.6],[251.8,334.4,323.7,340.8],[251.8,344.9,297.4,351.3],[251.8,352.1,310.7,358.5],[251.9,362.3,342.5,368.7],[251.9,369.5,337.9,375.9],
  [251.9,380.0,330.3,386.4],[251.9,387.2,316.1,393.6],[186.2,57.9,193.0,64.7],[125.4,426.0,133.4,434.0],[24.3,89.9,31.1,96.7],[28.9,58.6,35.7,65.4],
  [34.8,138.5,41.6,145.3],[57.8,151.7,64.6,158.5],[84.2,140.3,91.0,147.1],[28.6,179.8,35.4,186.6],[83.1,180.4,89.9,187.2],[105.7,183.0,112.5,189.8],
  [146.0,159.3,152.8,166.1],[176.2,157.7,183.0,164.5],[240.7,167.3,247.5,174.1],[198.6,215.5,205.4,222.3],[189.5,232.8,196.3,239.6],[213.6,242.4,220.4,249.2],
  [188.1,256.9,194.9,263.7],[180.8,263.9,187.6,270.7],[168.0,215.4,174.8,222.2],[107.7,256.9,114.5,263.7],[110.7,228.2,117.5,235.0],[54.0,216.3,60.8,223.1],
  [119.7,290.5,126.5,297.3],[70.9,287.1,77.7,293.9],[44.5,268.0,51.3,274.8],[25.4,259.3,32.2,266.1],[23.2,227.8,30.0,234.6],[130.0,320.2,136.8,327.0],
  [171.8,334.0,178.6,340.8],[140.4,343.9,147.2,350.7],[121.5,363.4,128.3,370.2],[19.3,331.6,26.1,338.4],[52.5,351.9,59.3,358.7],[16.6,368.0,23.4,374.8],
  [50.0,372.1,56.8,378.9],[93.6,371.1,100.4,377.9],[85.9,396.1,92.7,402.9],[16.1,387.4,22.9,394.2],[55.1,408.6,61.9,415.4],[65.0,411.7,71.8,418.5],
  [97.1,421.5,103.9,428.3],[24.3,425.5,31.1,432.3],[52.0,426.8,58.8,433.6],[42.2,435.1,49.0,441.9],[23.2,452.0,30.0,458.8],[48.6,453.3,55.4,460.1],
  [58.8,454.3,65.6,461.1],[104.4,443.0,111.2,449.8],[140.1,439.8,146.9,446.6],[121.2,449.3,128.0,456.1],[101.6,455.1,114.4,462.1],[171.4,457.4,178.2,464.2],
  [125.4,461.4,132.2,468.2],[116.8,459.2,123.6,466.0],[134.5,413.6,141.3,420.4],[145.2,418.3,152.0,425.1],[155.8,412.2,162.6,419.0],[146.8,395.4,153.6,402.2],
  [124.8,384.2,131.6,391.0],[130.0,394.4,136.8,401.2],[11.5,221.0,18.3,227.8],[152.1,398.0,158.9,404.8],[63.5,378.5,70.3,385.3],[14.4,472.6,103.2,478.6],
  [19.5,480.6,98.0,486.6],[94.4,431.3,126.2,437.3],[31.9,47.1,42.0,53.1],[31.9,53.1,55.1,59.1],[26.6,84.1,49.8,90.1],[19.2,135.5,33.5,141.5],
  [19.2,141.5,33.3,147.5],[62.2,156.0,96.8,162.0],[89.8,139.3,144.9,145.3],[187.9,63.3,214.1,69.3],[62.0,183.1,82.3,189.1],[62.0,189.1,80.7,195.1],
  [16.8,173.6,57.0,179.6],[111.5,182.7,142.8,188.7],[115.1,158.5,144.8,164.5],[179.0,162.9,198.0,168.9],[57.1,211.5,89.7,217.5],[16.5,217.4,41.7,223.4],
  [28.8,228.8,58.8,234.8],[28.8,234.8,51.8,240.8],[116.2,231.1,132.9,237.1],[116.2,237.1,130.2,243.1],[114.4,257.2,137.1,263.2],[114.4,263.2,133.1,269.2],
  [49.8,259.7,68.8,265.7],[49.8,265.7,63.8,271.7],[16.2,263.3,27.3,269.3],[16.2,269.3,26.5,275.3],[76.7,278.9,94.9,284.9],[76.7,284.9,96.6,290.9],
  [124.7,282.3,143.4,288.3],[124.7,288.3,140.1,294.3],[25.3,322.9,41.6,328.9],[25.3,328.9,40.7,334.9],[135.3,313.3,156.1,319.3],[135.3,319.3,150.8,325.3],
  [57.8,348.6,97.2,354.6],[20.8,363.8,39.4,369.8],[55.1,366.6,80.1,372.6],[20.2,392.2,41.2,398.2],[94.2,365.6,115.2,371.6],[106.4,352.2,124.5,358.2],
  [109.1,358.2,124.5,364.2],[136.1,331.2,171.4,337.2],[151.5,337.2,171.4,343.2],[145.7,346.7,175.0,352.7],[105.0,379.1,125.4,385.1],[114.0,394.3,129.4,400.3],
  [151.1,384.8,163.0,390.8],[151.1,390.8,181.3,396.8],[67.2,392.7,86.0,398.7],[74.8,398.7,86.0,404.7],[67.9,406.7,95.3,412.7],[23.0,410.2,55.0,416.2],
  [99.5,410.6,122.5,416.6],[99.5,416.6,126.0,422.6],[26.8,420.4,46.2,426.4],[54.9,421.4,80.1,427.4],[47.8,433.8,66.6,439.8],[26.5,447.3,44.3,453.3],
  [23.5,459.0,55.2,465.0],[82.0,439.2,105.6,445.2],[79.0,452.8,101.3,458.8],[145.7,438.3,175.4,444.3],[160.0,451.3,185.1,457.3],[130.9,459.4,157.2,465.4],
  [127.0,449.3,145.6,455.3],[97.3,460.4,116.5,466.4],[57.1,449.1,63.7,456.4],[61.0,446.9,67.9,454.4],[65.5,445.6,71.0,452.5],[69.0,443.8,76.8,451.4],
  [75.6,443.4,79.8,449.8],[79.0,443.3,83.1,449.6],[161.3,407.4,181.0,413.4],[161.3,413.4,182.6,419.4],[147.7,423.7,181.6,429.7],[132.4,408.2,153.1,414.2],
  [238.0,161.6,275.7,167.6],[126.3,213.2,167.4,219.2],[203.3,212.8,236.1,218.8],[195.1,224.5,226.3,230.5],[195.1,230.5,219.9,236.5],[161.4,240.4,211.7,246.4],
  [169.9,269.5,202.4,275.5],[169.9,275.5,184.8,281.5],[154.7,252.4,188.2,258.4],[83.6,196.9,179.9,209.9],[192.6,28.2,237.1,35.2],[188.1,37.2,241.6,44.2],
  [82.5,2.5,113.9,8.5],[2.9,203.4,8.9,255.8],[258.6,186.6,279.9,214.2],[104.4,300.2,107.7,306.2],[91.7,308.2,120.4,314.2],[95.7,396.1,99.0,402.1],
  [95.7,402.1,123.1,408.1],[118.5,437.4,129.8,450.3],[126.5,417.8,133.7,424.9],[133.2,412.4,146.9,432.0],[130.3,441.1,137.2,446.7],[188.8,142.2,196.8,150.1],
  [195.1,135.0,202.6,142.1],[198.1,130.5,206.2,138.6],[202.9,128.4,208.7,135.1],[206.4,126.7,211.6,133.5],[210.4,125.8,215.2,132.3],[217.1,122.7,224.3,129.9],
  [124.6,113.9,131.0,121.1],[133.5,118.3,139.5,125.4],[138.4,119.5,143.3,126.1],[142.4,119.0,147.3,125.6],[145.5,117.9,150.9,124.3],[147.2,115.5,153.7,122.0],
  [149.4,112.3,156.5,119.0],[152.1,110.5,157.9,115.5],[153.2,109.0,159.2,113.5],[154.3,107.2,160.3,111.5],[158.2,93.2,165.2,100.5],[30.7,96.4,58.2,102.4],
  [30.7,102.4,34.0,108.4],[62.9,116.4,91.4,122.4],[62.9,122.4,88.3,128.4],[32.0,294.4,37.4,301.3],[39.9,292.2,49.6,301.2],[46.7,296.0,52.9,303.1],
  [49.8,298.0,56.3,305.1],[52.3,300.9,60.4,309.0],[55.3,305.9,62.3,311.8],[57.0,309.8,64.7,318.6],[58.7,317.6,65.1,321.6],[59.1,321.2,65.2,326.2],
  [57.6,272.3,75.2,278.3],[57.6,278.3,63.0,284.3],[157.9,398.4,185.9,404.4],[89.2,444.8,97.6,452.0],[96.3,446.1,101.6,452.9],[99.7,447.1,106.4,454.4],
  [103.7,449.1,109.9,456.1],[106.5,451.2,112.2,457.5],[36.9,380.8,63.5,386.8],[43.8,386.8,63.5,392.8],[274.4,57.9,318.5,66.0],[250.4,5.8,349.5,104.1],
  [218.1,437.3,331.5,441.5],[233.0,313.6,238.0,318.6],[232.3,296.5,237.3,301.5],[187.2,58.9,192.2,63.9],[126.5,428.4,131.5,433.4],[25.2,90.8,30.2,95.8],
  [29.8,59.5,34.8,64.5],[35.7,139.4,40.7,144.4],[58.8,152.7,63.8,157.7],[85.4,141.0,90.4,146.0],[29.5,180.8,34.5,185.8],[84.0,181.4,89.0,186.4],
  [106.7,183.8,111.7,188.8],[146.9,160.1,151.9,165.1],[177.3,158.8,182.3,163.8],[241.6,168.2,246.6,173.2],[199.8,216.1,204.8,221.1],[190.6,233.5,195.6,238.5],
  [214.5,243.2,219.5,248.2],[189.0,257.7,194.0,262.7],[181.7,264.8,186.7,269.8],[168.9,216.2,173.9,221.2],[108.6,257.8,113.6,262.8],[112.0,229.4,117.0,234.4],
  [55.0,217.0,60.0,222.0],[121.0,291.1,126.0,296.1],[72.1,287.8,77.1,292.8],[45.9,268.6,50.9,273.6],[26.3,260.3,31.3,265.3],[24.6,228.8,29.6,233.8],
  [131.4,320.8,136.4,325.8],[172.7,334.8,177.7,339.8],[141.8,345.1,146.8,350.1],[122.4,364.3,127.4,369.3],[20.3,332.5,25.3,337.5],[53.4,352.7,58.4,357.7],
  [17.6,368.8,22.6,373.8],[50.9,372.9,55.9,377.9],[94.6,372.0,99.6,377.0],[86.8,396.9,91.8,401.9],[17.2,388.6,22.2,393.6],[56.0,409.5,61.0,414.5],
  [66.0,412.6,71.0,417.6],[98.1,422.3,103.1,427.3],[25.2,426.4,30.2,431.4],[52.9,427.6,57.9,432.6],[43.4,435.8,48.4,440.8],[24.2,452.7,29.2,457.7],
  [49.6,454.2,54.6,459.2],[59.6,455.0,64.6,460.0],[105.0,443.8,110.0,448.8],[141.3,440.5,146.3,445.5],[122.4,450.1,127.4,455.1],[102.6,455.9,107.6,460.9],
  [108.4,456.1,113.4,461.1],[172.4,458.2,177.4,463.2],[126.6,462.4,131.6,467.4],[117.7,460.2,122.7,465.2],[135.4,414.5,140.4,419.5],[146.2,419.3,151.2,424.3],
  [157.3,413.2,162.3,418.2],[147.8,396.2,152.8,401.2],[125.7,385.0,130.7,390.0],[130.9,395.2,135.9,400.2],[12.5,221.8,17.5,226.8],[153.3,398.9,158.3,403.9],
  [64.4,379.3,69.4,384.3],];

/** Callout look, in page points. Matches the hand-made report figures:
 *  maroon box, white rule inside its edge, white bold caps, soft shadow,
 *  maroon arrow whose tip sits on the subject. */
export const CALLOUT = {
  fill: '#8c1c22',
  text: '#ffffff',
  font: 'bold 13px Arial, Helvetica, sans-serif',
  fontSize: 13,
  padX: 8,
  height: 23,
  lineWidth: 1.6,
  headLen: 6.5,
  headHalfWidth: 3.6,
};

/** Compass choices for the callout. Angles are screen angles (y down):
 *  0 = east, -90 = north. 'auto' searches all of them. */
export const DIRECTIONS = {
  ne: -40, e: 0, se: 40, s: 90, sw: 140, w: 180, nw: -140, n: -90,
};
const PREFERRED = -40;            // up and to the right, the usual look
const LEADERS = [32, 42, 52, 64, 78, 94, 112];
const MARGIN = 4;                 // keep the box this far inside the page

/** Estimated label width in points when no canvas is at hand. */
export function estimateTextWidth(label, fontSize = CALLOUT.fontSize) {
  return label.length * fontSize * 0.72;
}

function overlapArea(a, b) {
  const w = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
  const h = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  return w > 0 && h > 0 ? w * h : 0;
}

/** Where segment centre→p leaves the box — the arrow's tail. */
function boxExit(box, p) {
  const cx = (box[0] + box[2]) / 2;
  const cy = (box[1] + box[3]) / 2;
  const dx = p[0] - cx;
  const dy = p[1] - cy;
  const hw = (box[2] - box[0]) / 2;
  const hh = (box[3] - box[1]) / 2;
  const s = Math.min(dx ? hw / Math.abs(dx) : Infinity, dy ? hh / Math.abs(dy) : Infinity);
  return [cx + dx * s, cy + dy * s];
}

/** Box for one candidate: walk `leader` points from the subject along
 *  `angle`, then hang the box off that spot on the side facing away. */
function candidateBox(p, angle, leader, w, h) {
  const c = Math.cos(angle * Math.PI / 180);
  const s = Math.sin(angle * Math.PI / 180);
  const qx = p[0] + leader * c;
  const qy = p[1] + leader * s;
  const cx = qx + c * w / 2;
  const cy = qy + s * h / 2;
  return [cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2];
}

/**
 * Choose the callout box for subject point `p` (page points).
 *
 * Every candidate (36 directions, or five around the one asked for,
 * × 7 leader lengths) is scored by how much text / town-dot area it would cover,
 * plus small pulls toward a short leader and the up-right direction so
 * that among clear spots the familiar one wins. A box that would leave
 * the page is never chosen.
 *
 * Returns { box: [x0, y0, x1, y1], tail: [x, y] } — tail is where the
 * arrow leaves the box; the arrow's tip is `p` itself.
 */
export function placeCallout(p, width, { direction = 'auto', height = CALLOUT.height, obstacles = OBSTACLES } = {}) {
  // Every 10 degrees: the south is crowded enough that the eight compass
  // points alone often all land on a label when a spot 10-20 degrees off
  // one of them is clear. A forced side searches +-20 degrees around itself.
  const angles = [];
  if (direction in DIRECTIONS) {
    for (let d = -20; d <= 20; d += 10) angles.push(DIRECTIONS[direction] + d);
  } else {
    for (let a = -180; a < 180; a += 10) angles.push(a);
  }
  let best = null;
  for (const angle of angles) {
    for (const leader of LEADERS) {
      const box = candidateBox(p, angle, leader, width, height);
      if (box[0] < MARGIN || box[1] < MARGIN
          || box[2] > PAGE_W - MARGIN || box[3] > PAGE_H - MARGIN) continue;
      let covered = 0;
      for (const o of obstacles) covered += overlapArea(box, o);
      const turn = Math.abs(((angle - PREFERRED + 540) % 360) - 180);
      const score = covered + leader * 0.25 + turn * 0.3;
      if (!best || score < best.score) best = { score, box };
    }
  }
  if (!best) {
    // Nothing fits (only possible with a forced direction into the page
    // edge): fall back to the automatic choice rather than draw off-page.
    if (direction !== 'auto') return placeCallout(p, width, { height, obstacles });
    return null;
  }
  return { box: best.box, tail: boxExit(best.box, p) };
}

let svgImagePromise = null;
/** Load the base map once per page. */
function loadBaseMap(url) {
  if (!svgImagePromise) {
    svgImagePromise = new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => { svgImagePromise = null; reject(new Error(`could not load ${url}`)); };
      img.src = url;
    });
  }
  return svgImagePromise;
}

/**
 * Draw the base map plus the callout into a new canvas `scale` pixels per
 * page point wide (4 → 1467 × 1958, sharp at full page width in a
 * report). The SVG is drawn straight at the output size, so the browser
 * rasterises the vectors at that resolution rather than upscaling.
 */
export async function renderLocationMap({
  lng, lat, label = 'SUBJECT', direction = 'auto', scale = 4,
  svgUrl = '/manitoba-overview.svg',
}) {
  const img = await loadBaseMap(svgUrl);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(PAGE_W * scale);
  canvas.height = Math.round(PAGE_H * scale);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

  ctx.scale(scale, scale);
  const p = lngLatToPage(lng, lat);
  ctx.font = CALLOUT.font;
  const text = String(label || 'SUBJECT').trim() || 'SUBJECT';
  const width = Math.ceil(ctx.measureText(text).width + CALLOUT.padX * 2);
  const placed = placeCallout(p, width, { direction });
  if (!placed) return canvas;
  drawCallout(ctx, p, placed, text);
  return canvas;
}

function drawCallout(ctx, p, { box, tail }, text) {
  const [x0, y0, x1, y1] = box;
  const w = x1 - x0;
  const h = y1 - y0;

  // Arrow first, so the box sits over its tail end.
  const ang = Math.atan2(p[1] - tail[1], p[0] - tail[0]);
  const baseX = p[0] - Math.cos(ang) * CALLOUT.headLen;
  const baseY = p[1] - Math.sin(ang) * CALLOUT.headLen;
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.35)';
  ctx.shadowBlur = 2;
  ctx.shadowOffsetX = 0.8;
  ctx.shadowOffsetY = 0.8;
  ctx.strokeStyle = CALLOUT.fill;
  ctx.lineWidth = CALLOUT.lineWidth;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(tail[0], tail[1]);
  ctx.lineTo(baseX, baseY);
  ctx.stroke();
  ctx.fillStyle = CALLOUT.fill;
  ctx.beginPath();
  ctx.moveTo(p[0], p[1]);
  ctx.lineTo(baseX + Math.sin(ang) * CALLOUT.headHalfWidth, baseY - Math.cos(ang) * CALLOUT.headHalfWidth);
  ctx.lineTo(baseX - Math.sin(ang) * CALLOUT.headHalfWidth, baseY + Math.cos(ang) * CALLOUT.headHalfWidth);
  ctx.closePath();
  ctx.fill();

  // Box with a drop shadow, then the inner white rule and the label.
  ctx.shadowBlur = 3;
  ctx.shadowOffsetX = 1.5;
  ctx.shadowOffsetY = 1.5;
  roundRect(ctx, x0, y0, w, h, 2.5);
  ctx.fill();
  ctx.restore();
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 0.9;
  roundRect(ctx, x0 + 1.6, y0 + 1.6, w - 3.2, h - 3.2, 1.5);
  ctx.stroke();
  ctx.fillStyle = CALLOUT.text;
  ctx.font = CALLOUT.font;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x0 + w / 2, y0 + h / 2 + 0.6);
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
