"""Stage 1: build mean-weekday AM (hours 5-8) BART station-to-station matrix."""
import pandas as pd
from pandas.tseries.holiday import USFederalHolidayCalendar
from pathlib import Path

HERE = Path(__file__).resolve().parent
YEAR = 2025

_cal = USFederalHolidayCalendar()
_hol = pd.DatetimeIndex(_cal.holidays(start="2018-01-01", end="2027-12-31"))
_tg = _hol[(_hol.month == 11) & (_hol.day >= 22) & (_hol.day <= 28)]
HOLIDAYS = _hol.union(_tg + pd.Timedelta(days=1))

df = pd.read_csv(
    HERE / f"od-{YEAR}.csv.gz",
    names=["date", "hour", "orig", "dest", "trips"],
    dtype={"hour": "int16", "orig": "category", "dest": "category",
           "trips": "int32"},
    parse_dates=["date"],
)
print("raw rows:", len(df))

d = pd.DatetimeIndex(df.date)
keep = (d.dayofweek < 5) & ~d.isin(HOLIDAYS) & (d.year == YEAR)
am = keep & (df.hour >= 5) & (df.hour <= 8)
sub = df[am]
nwd = pd.DatetimeIndex(sub.date).nunique()
print("weekdays with AM data:", nwd)
print("AM rows:", len(sub), "AM trips total:", int(sub.trips.sum()))

mat = (sub.groupby(["orig", "dest"], observed=True).trips.sum() / nwd)
mat = mat.reset_index().rename(columns={"trips": "flow"})
mat = mat[mat.flow > 0]
mat.to_parquet(HERE / "od_am_matrix.parquet", index=False)

print("pairs:", len(mat))
print("mean-weekday AM trips:", round(mat.flow.sum(), 1))
print("stations orig:", mat.orig.nunique(), "dest:", mat.dest.nunique())
print(mat.nlargest(8, "flow").to_string(index=False))
