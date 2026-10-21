"""Assessment-parcel boundaries as georeferencing reference: the town plans
draw lot lines and road-allowance edges, which are exactly the parcel
edges (OSM centrelines sit mid-allowance and miss most lot lines).

Loads Parcels/data/mb-assessment-parcels-*.parquet (EPSG:4326, geoarrow
multipolygon) once into a flat ring cache (parcel_rings.npz in the work dir).
"""
import glob, os
import numpy as np

PARQUET_GLOB = r'D:/Dropbox/ClaudeCode/MBOpenData/Parcels/data/mb-assessment-parcels-*.parquet'


def load(work):
    cache = os.path.join(work, 'parcel_rings.npz')
    if os.path.exists(cache):
        z = np.load(cache)
        return z['xy'], z['off'], z['bbox']
    import pyarrow.parquet as pq
    import pyarrow.compute as pc
    path = sorted(glob.glob(PARQUET_GLOB))[-1]
    col = pq.read_table(path, columns=['geometry']).column('geometry').combine_chunks()
    polys = col.flatten()            # multipolygon -> polygons
    rings = polys.flatten()          # polygons -> rings
    pts = rings.flatten()            # rings -> points (struct x, y)
    xy = np.c_[pc.struct_field(pts, 0).to_numpy(zero_copy_only=False), pc.struct_field(pts, 1).to_numpy(zero_copy_only=False)]
    off = rings.offsets.to_numpy()
    n = len(off) - 1
    bbox = np.empty((n, 4))
    starts, ends = off[:-1], off[1:]
    bbox[:, 0] = np.minimum.reduceat(xy[:, 0], starts); bbox[:, 2] = np.maximum.reduceat(xy[:, 0], starts)
    bbox[:, 1] = np.minimum.reduceat(xy[:, 1], starts); bbox[:, 3] = np.maximum.reduceat(xy[:, 1], starts)
    np.savez(cache, xy=xy, off=off, bbox=bbox)
    return xy, off, bbox


def rings_in(ref, lon0, lat0, lon1, lat1):
    """Rings (arrays of lon/lat) whose bbox meets the window."""
    xy, off, bbox = ref
    sel = np.nonzero((bbox[:, 2] >= lon0) & (bbox[:, 0] <= lon1) & (bbox[:, 3] >= lat0) & (bbox[:, 1] <= lat1))[0]
    return [xy[off[i]:off[i + 1]] for i in sel]
