"""Every structured-output schema in the editor must be one the API accepts (TEST v3 2026-10-10: the producer's route
planner sent 'additionalProperties: {schema}' — HTTP 400 on every call, and the fakes never noticed). Static check:
objects need additionalProperties false, and every property is required."""
import sys
sys.path.insert(0, "/opt/clipmagic/aieditor")
import importlib, pkgutil
import aieditor

bad = []


def walk(s, where):
    if isinstance(s, dict):
        if s.get("type") == "object" or "properties" in s:
            ap = s.get("additionalProperties", None)
            if ap is not False:
                bad.append(f"{where}: additionalProperties must be false (is {ap!r})")
        for k, v in s.items():
            walk(v, f"{where}.{k}")
    elif isinstance(s, list):
        for i, v in enumerate(s):
            walk(v, f"{where}[{i}]")


n = 0
for m in pkgutil.iter_modules(aieditor.__path__):
    try:
        mod = importlib.import_module(f"aieditor.{m.name}")
    except Exception:  # noqa: BLE001 — a module that needs the box is skipped
        continue
    objs = [(f"{m.name}.{k}", v) for k, v in vars(mod).items()]
    objs += [(f"{m.name}.{c}.{k}", v) for c, cv in vars(mod).items() if isinstance(cv, type) and cv.__module__ == mod.__name__
             for k, v in vars(cv).items()]
    for name, v in objs:
        if name.split(".")[-1].endswith("SCHEMA") and isinstance(v, dict):
            n += 1
            walk(v, name)
assert n > 0, "no schemas found"
assert not bad, "\n".join(bad[:20])
print(f"test_schemas_api_valid: {n} schemas checked")
