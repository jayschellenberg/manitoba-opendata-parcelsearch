"""UTM 14N (NAD83) forward projection, the same Kruger series as
utm14() in web/src/lib/locationMap.js."""
import math
A = 6378137.0; FL = 1 / 298.257222101; E = math.sqrt(2 * FL - FL * FL)
N = FL / (2 - FL)
UA = A / (1 + N) * (1 + N**2 / 4 + N**4 / 64)
AL = [N/2 - 2*N**2/3 + 5*N**3/16, 13*N**2/48 - 3*N**3/5, 61*N**3/240]
def utm14(lng, lat):
    phi = math.radians(lat); lam = math.radians(lng + 99); s = math.sin(phi)
    t = math.sinh(math.atanh(s) - E * math.atanh(E * s))
    xi = math.atan2(t, math.cos(lam)); eta = math.atanh(math.sin(lam) / math.sqrt(1 + t*t))
    x, y = eta, xi
    for j in range(3):
        k = 2 * (j + 1)
        x += AL[j] * math.cos(k*xi) * math.sinh(k*eta); y += AL[j] * math.sin(k*xi) * math.cosh(k*eta)
    return 500000 + 0.9996*UA*x, 0.9996*UA*y
