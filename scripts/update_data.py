"""Rebuilds data/rain.json from SILO daily gridded rainfall (1889 to yesterday).
Run daily by .github/workflows/update-data.yml. Needs env SILO_EMAIL (SILO's API username is an email address)."""
import csv, io, json, os, sys, urllib.request, datetime as dt
from collections import defaultdict

EMAIL = os.environ.get('SILO_EMAIL')
if not EMAIL: sys.exit('SILO_EMAIL not set')
CELLS = [('-34.90', '138.70'), ('-34.90', '138.75')]  # the two 5 km cells around Norton Summit
yesterday = (dt.datetime.utcnow() + dt.timedelta(hours=10.5) - dt.timedelta(days=1)).strftime('%Y%m%d')

def fetch(lat, lon):
    url = (f'https://www.longpaddock.qld.gov.au/cgi-bin/silo/DataDrillDataset.php?lat={lat}&lon={lon}'
           f'&start=18890101&finish={yesterday}&format=csv&comment=R&username={EMAIL}&password=apirequest')
    with urllib.request.urlopen(url, timeout=300) as r: text = r.read().decode()
    rows = list(csv.DictReader(io.StringIO(text)))
    return {row['YYYY-MM-DD']: float(row['daily_rain']) for row in rows}

cells = [fetch(*c) for c in CELLS]
dates = sorted(set(cells[0]) & set(cells[1]))
assert dates[0] == '1889-01-01', dates[0]
ns = [round((cells[0][d] + cells[1][d]) / 2, 1) for d in dates]

monthly = defaultdict(lambda: [0.0] * 12); raindays = defaultdict(int); heavy = defaultdict(int)
for d, v in zip(dates, ns):
    y, m = int(d[:4]), int(d[5:7])
    monthly[y][m - 1] += v
    if v >= 1: raindays[y] += 1
    if v >= 20: heavy[y] += 1
years = sorted(monthly)
drivers = json.load(open('data/drivers.json'))
out = {
    'meta': {'source': 'SILO (Queensland Government) daily gridded rainfall, average of the two 5 km cells at -34.90,138.70 and -34.90,138.75',
             'start': dates[0], 'end': dates[-1], 'updated': dt.date.today().isoformat(),
             'enso_source': 'Bureau of Meteorology El Niño / La Niña event list', 'iod_source': 'Bureau of Meteorology IOD years (1960+)'},
    'daily10': [round(v * 10) for v in ns],
    'years': years,
    'monthly': {str(y): [round(x, 1) for x in monthly[y]] for y in years},
    'elnino': drivers['elnino'], 'lanina': drivers['lanina'], 'iodPos': drivers['iodPos'], 'iodNeg': drivers['iodNeg'],
    'raindays': {str(y): raindays[y] for y in years}, 'heavydays': {str(y): heavy[y] for y in years},
}
json.dump(out, open('data/rain.json', 'w'), separators=(',', ':'))
print('rain.json:', dates[0], 'to', dates[-1], len(ns), 'days')
