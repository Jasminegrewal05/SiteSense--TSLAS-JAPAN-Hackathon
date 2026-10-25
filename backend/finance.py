"""
Which numbers we read, and the ratios we calculate from them.
Amounts are in Rs crore. Calculations are plain Python, never AI.
"""

# key, label, unit, other names the number goes by in reports
BASE_METRICS = [
    ("revenue", "Revenue from operations", "cr",
     ["revenue from operations", "total revenue", "net sales", "revenue"]),
    ("cogs", "Cost of goods sold", "cr",
     ["cost of goods sold", "cost of sales"]),
    ("ebitda", "EBITDA", "cr",
     ["ebitda", "operating profit before depreciation"]),
    ("inventory", "Inventories", "cr",
     ["inventories", "inventory"]),
    ("receivables", "Trade receivables", "cr",
     ["trade receivables", "sundry debtors", "debtors"]),
    ("total_debt", "Total borrowings", "cr",
     ["total borrowings", "total debt", "borrowings"]),
    ("equity", "Total equity", "cr",
     ["total equity", "shareholders equity", "net worth"]),
    ("capex", "Capital expenditure", "cr",
     ["capital expenditure", "purchase of property, plant and equipment", "capex"]),
    ("capacity_utilization", "Capacity utilisation (claimed)", "pct",
     ["capacity utilisation", "capacity utilization"]),
    ("employees", "Employees", "count",
     ["number of employees", "employees", "headcount"]),
]

METRIC_KEYS = [m[0] for m in BASE_METRICS]
LABELS = {m[0]: m[1] for m in BASE_METRICS}
UNITS = {m[0]: m[2] for m in BASE_METRICS}
SYNONYMS = {m[0]: sorted(m[3], key=len, reverse=True) for m in BASE_METRICS}

# Derived ratios: label, unit, the base numbers they are built from
DERIVED = {
    "inventory_days": ("Inventory days", "days", ["inventory", "cogs"]),
    "receivable_days": ("Receivable days", "days", ["receivables", "revenue"]),
    "debt_to_equity": ("Debt to equity", "ratio", ["total_debt", "equity"]),
    "ebitda_margin": ("EBITDA margin", "pct", ["ebitda", "revenue"]),
    "capex_to_revenue": ("Capex as share of revenue", "pct", ["capex", "revenue"]),
    "revenue_per_employee": ("Revenue per employee", "lakh", ["revenue", "employees"]),
    "inventory_growth_gap": ("Inventory growth minus revenue growth", "pts", ["inventory", "revenue"]),
    "receivables_growth_gap": ("Receivables growth minus revenue growth", "pts", ["receivables", "revenue"]),
}


def inputs_of(key):
    """Base numbers a metric depends on (used to cite sources)."""
    if key in DERIVED:
        return DERIVED[key][2]
    return [key]


def _div(a, b, scale=1.0):
    if a is None or b is None or b == 0:
        return None
    return a / b * scale


def _sub(a, b):
    if a is None or b is None:
        return None
    return a - b


def _entry(label, unit, current, previous):
    change = _sub(current, previous)
    change_pct = None
    if change is not None and previous not in (None, 0):
        change_pct = change / abs(previous) * 100
    return {
        "label": label,
        "unit": unit,
        "current": _round(current),
        "previous": _round(previous),
        "change": _round(change),
        "change_pct": _round(change_pct),
    }


def _round(v):
    return None if v is None else round(v, 4)


def compute_all(base):
    """base: {key: {"current": x, "previous": y}} -> every metric with its movement."""
    out = {}
    for key in METRIC_KEYS:
        v = base.get(key, {})
        out[key] = _entry(LABELS[key], UNITS[key], v.get("current"), v.get("previous"))

    def pair(key):
        v = base.get(key, {})
        return v.get("current"), v.get("previous")

    inv, cogs, rec, rev = pair("inventory"), pair("cogs"), pair("receivables"), pair("revenue")
    debt, eq, ebitda, capex, emp = pair("total_debt"), pair("equity"), pair("ebitda"), pair("capex"), pair("employees")

    # index 0 = current year, 1 = previous year
    def both(fn):
        return fn(0), fn(1)

    calc = {
        "inventory_days": both(lambda i: _div(inv[i], cogs[i], 365)),
        "receivable_days": both(lambda i: _div(rec[i], rev[i], 365)),
        "debt_to_equity": both(lambda i: _div(debt[i], eq[i])),
        "ebitda_margin": both(lambda i: _div(ebitda[i], rev[i], 100)),
        "capex_to_revenue": both(lambda i: _div(capex[i], rev[i], 100)),
        # crore -> lakh is x100
        "revenue_per_employee": both(lambda i: _div(rev[i], emp[i], 100)),
    }
    for key, (cur, prev) in calc.items():
        label, unit, _ = DERIVED[key]
        out[key] = _entry(label, unit, cur, prev)

    for key, base_key in (("inventory_growth_gap", "inventory"), ("receivables_growth_gap", "receivables")):
        label, unit, _ = DERIVED[key]
        gap = _sub(out[base_key]["change_pct"], out["revenue"]["change_pct"])
        out[key] = {"label": label, "unit": unit, "current": _round(gap), "previous": None,
                    "change": None, "change_pct": None}
    return out


def fmt(value, unit, signed=False):
    """Human-readable number, used inside checklist text."""
    if value is None:
        return "n/a"
    sign = "+" if signed and value > 0 else ""
    if unit == "cr":
        return sign + "Rs " + format(value, ",.1f") + " cr"
    if unit == "lakh":
        return sign + "Rs " + format(value, ",.1f") + " lakh"
    if unit == "pct":
        return sign + _trim(value) + "%"
    if unit == "pts":
        return sign + _trim(value) + " pts"
    if unit == "days":
        return sign + format(value, ".0f") + " days"
    if unit == "ratio":
        return sign + format(value, ".2f") + "x"
    if unit == "count":
        return sign + format(value, ",.0f")
    return sign + str(value)


def _trim(v):
    return format(v, ".0f") if abs(v - round(v)) < 0.05 else format(v, ".1f")


def fmt_field(entry, field):
    """Format one field (current/previous/change/change_pct) of a computed metric."""
    value = entry.get(field)
    if field == "change_pct":
        return fmt(value, "pct", signed=True)
    if field == "change":
        unit = "pts" if entry["unit"] in ("pct", "pts") else entry["unit"]
        return fmt(value, unit, signed=True)
    return fmt(value, entry["unit"])
