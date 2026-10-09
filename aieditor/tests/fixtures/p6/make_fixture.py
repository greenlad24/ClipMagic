"""Build failed_job.json.gz for tests/test_plan_call.py from SCRATCH COPIES of the failed end-to-end job
(factory-end-to-end-test-mac-rec-10082332-63de — read only; copy edl.json, edit-01/direct.json and
edit-01/overlays.json somewhere first) plus the G2 offline-acceptance fixtures (readiness.fixture.json:
the ChatGPT adapter's measured readiness notes; assets.json: the produced assets of that run).

  python3 make_fixture.py <scratch dir with edl.json direct.json overlays.json readiness.fixture.json assets.json>
"""
import gzip
import json
import sys
from pathlib import Path

src = Path(sys.argv[1])
edl = json.loads((src / "edl.json").read_text())
v = edl["videos"][0]
direct = json.loads((src / "direct.json").read_text())
ovs = json.loads((src / "overlays.json").read_text())
assets = json.loads((src / "assets.json").read_text())
keep = ("id", "kind", "desc", "status", "prompt", "made_from", "tool", "text")
doc = {
    "source": "factory-end-to-end-test-mac-rec-10082332-63de (scratch copies; the job itself is never read in place)",
    "title": v.get("title", ""), "duration": v["duration"],
    "words": [[w["word"], w["start"], w["end"]] for w in v["words"]],
    "sites": direct["sites"],
    "raw": {"segments": direct["raw"]["segments"], "overlays": direct["raw"]["overlays"]},
    "plan_segments": [{"t0": s["t0"], "t1": s["t1"]} for s in direct["plan"]["segments"]],
    "overlays": [{k: e[k] for k in ("template", "start", "end", "fields", "why", "t0", "t1") if k in e} for e in ovs],
    "readiness": json.loads((src / "readiness.fixture.json").read_text()),
    "assets": {"assets": [{**{k: a[k] for k in keep if k in a},
                           **({"source": {k: a["source"][k] for k in ("prompt", "made_from", "doodle") if k in a["source"]}}
                              if a.get("source") else {})} for a in assets["assets"]]},
}
out = Path(__file__).with_name("failed_job.json.gz")
with gzip.open(out, "wt") as f:
    json.dump(doc, f)
print(out, out.stat().st_size)
