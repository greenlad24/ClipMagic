#!/usr/bin/env python3
"""Tests for storage_agent: protection rules + "really deleted" semantics.

Everything that is DELETED here is created by the test itself inside a throwaway
directory under /var/tmp. Real system paths are only ever passed to Rules.check /
Agent.preview, which refuse before touching anything.

    python3 /opt/clipmagic/storage-agent/test_storage_agent.py
"""
import http.client
import json
import os
import shutil
import socket
import tempfile
import threading
import unittest

import storage_agent as sa

MB = 1 << 20


def write(path, n=MB):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(os.urandom(n))
    return path


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="storage-agent-test-", dir="/var/tmp")
        self.state = os.path.join(self.tmp, "state")
        os.makedirs(self.state)
        self.prot = os.path.join(self.tmp, "prot")
        os.makedirs(self.prot)
        self.rules = sa.Rules(
            extra_protected=[self.prot], mounts={os.path.join(self.tmp, "mnt")},
            binds={os.path.join(self.tmp, "bound")},
            job_roots=[os.path.join(self.tmp, "jobs")], repo_roots=[os.path.join(self.tmp, "src")],
            home_roots=[os.path.join(self.tmp, "home")], state_dir=self.state,
            agent_dir=os.path.join(self.tmp, "agentcode"),
        )
        self.rules.refresh_dynamic = lambda: None   # keep the injected mounts/binds
        self.agent = sa.Agent(root=self.tmp, state_dir=self.state, rules=self.rules)

    def tearDown(self):
        for _ in range(3):    # a delete kicks off a background re-index; let it land first
            th = self.agent.scan_thread
            if th:
                th.join(30)
        shutil.rmtree(self.tmp, ignore_errors=True)

    def p(self, *parts):
        return os.path.join(self.tmp, *parts)

    def index(self):
        self.agent.refresh(wait=True)
        self.assertIsNotNone(self.agent.index)

    def delete(self, paths, confirm=None):
        plan = self.agent.preview(paths)
        return plan, self.agent.delete(plan["planId"], confirm, actor="test")


class RulesOnRealPaths(Base):
    """The real system paths — checked, never deleted."""

    def test_system_and_private_paths_refused(self):
        real = sa.Rules(binds=set())
        for p in ["/", "/etc", "/etc/passwd", "/usr/bin/python3", "/boot/x", "/proc/1", "/sys/kernel",
                  "/var/lib/docker", "/var/lib/docker/volumes/clipmagic_clipmagic-lab-data/_data/db",
                  "/var/lib/containerd/x", "/opt/clipmagic", "/opt/clipmagic/lab/server/src/index.ts",
                  "/opt/clipmagic/storage-agent/storage_agent.py", "/root/.claude/projects",
                  "/root/.ssh/authorized_keys", "/root/.bashrc", "/root/.env.backup-pre-opus55-20261002",
                  "/opt/somewhere/.env", "/tmp/claude-0/x", "/opt", "/tmp", "/root", "/var/lib/storage-agent/deletions.log",
                  "/snap/core20", "/lib/x", "/swapfile",
                  "/opt/aieditor-work/models/hub", "/opt/jakedawson-hyperframes"]:
            self.assertIsNotNone(real.check(p), p)

    def test_ancestor_of_protected_refused(self):
        real = sa.Rules(binds=set())
        self.assertIsNotNone(real.check("/var/lib"))
        self.assertIsNotNone(real.check("/var"))

    def test_preview_of_system_file_refuses_and_touches_nothing(self):
        real_agent = sa.Agent(root="/", state_dir=self.state, rules=sa.Rules(binds=set()))
        before = os.stat("/etc/hostname")
        plan = real_agent.preview(["/etc/hostname", "/opt/clipmagic/docker-compose.yml"])
        self.assertEqual(plan["refused"], 2)
        self.assertTrue(all(not t["ok"] for t in plan["targets"]))
        self.assertEqual(os.stat("/etc/hostname").st_ino, before.st_ino)

    def test_job_outputs_stay_deletable(self):
        # a bare check — nothing is deleted; these are the places that SHOULD be offered
        real = sa.Rules(binds=set())
        self.assertIsNone(real.check("/opt/hyperframes-work/cache/sources/x.bin"))
        self.assertIsNone(real.check("/var/log/syslog.2.gz"))

    def test_cache_dotdir_in_home_allowed(self):
        self.assertIsNone(sa.Rules(binds=set()).check("/root/.cache/pip/x.whl"))


class RulesInSandbox(Base):
    def test_injected_protections(self):
        os.makedirs(self.p("mnt"), exist_ok=True)
        cases = {
            self.p("prot", "x"): "protected",
            self.p("mnt"): "mount point",
            self.p("bound"): "running container",
            self.p("home", "user", ".config", "gh"): "home directory",
            self.p("state", "deletions.log"): "agent",
            self.p("agentcode", "storage_agent.py"): "agent",
        }
        for path, word in cases.items():
            why = self.rules.check(path)
            self.assertIsNotNone(why, path)
            self.assertIn(word, why, path)
        self.assertIn("contains", self.rules.check(self.tmp) or "")
        self.assertIsNone(self.rules.check(self.p("home", "user", "video.mp4")))

    def test_running_job_refused_finished_allowed(self):
        run = self.p("jobs", "j-run")
        done = self.p("jobs", "j-done")
        queued = self.p("jobs", "j-queued")
        for d, st in [(run, "running"), (done, "done"), (queued, "done")]:
            os.makedirs(d)
            with open(os.path.join(d, "status.json"), "w") as f:
                json.dump({"state": st}, f)
        with open(os.path.join(queued, "queue.json"), "w") as f:
            f.write("{}")
        write(os.path.join(run, "source.mp4"))
        write(os.path.join(done, "source.mp4"))
        self.assertIn("running", self.rules.check(run))
        self.assertIn("running", self.rules.check(os.path.join(run, "source.mp4")))
        self.assertIn("queued", self.rules.check(queued))
        self.assertIsNone(self.rules.check(done))
        self.assertIn("running", self.rules.check(self.p("jobs")))   # the parent holds a live job
        self.index()
        plan, res = self.delete([run, done])
        self.assertTrue(os.path.exists(run))
        self.assertFalse(os.path.exists(done))
        self.assertFalse(res["results"][0]["ok"] and res["results"][1]["ok"])

    def test_git_repo_under_source_root_refused(self):
        repo = self.p("src", "proj")
        os.makedirs(os.path.join(repo, ".git"))
        write(os.path.join(repo, "big.bin"))
        self.assertIn("git", self.rules.check(os.path.join(repo, "big.bin")))
        self.assertIn("git", self.rules.check(repo))
        self.index()
        _, res = self.delete([self.p("src")])
        self.assertTrue(os.path.exists(os.path.join(repo, "big.bin")))
        self.assertFalse(res["results"][0]["ok"])

    def test_folder_containing_env_refused(self):
        write(self.p("proj", "media.mp4"))
        write(self.p("proj", "sub", ".env"), 10)
        self.index()
        plan, res = self.delete([self.p("proj")])
        self.assertIn("secrets", plan["targets"][0]["reason"])
        self.assertTrue(os.path.exists(self.p("proj", "media.mp4")))

    def test_symlink_parent_detour_refused_and_symlink_only_unlinks_itself(self):
        write(self.p("prot", "keep.bin"))
        os.symlink(self.prot, self.p("detour"))
        self.index()
        plan = self.agent.preview([self.p("detour", "keep.bin")])
        self.assertFalse(plan["targets"][0]["ok"])
        self.assertIn("symbolic link", plan["targets"][0]["reason"])
        _, res = self.delete([self.p("detour")])
        self.assertTrue(res["results"][0]["ok"])
        self.assertFalse(os.path.lexists(self.p("detour")))
        self.assertTrue(os.path.exists(self.p("prot", "keep.bin")))


class HardLinks(Base):
    def test_file_delete_removes_every_link(self):
        a = write(self.p("a", "big.mp4"), 2 * MB)
        links = [self.p("b", "l1.mp4"), self.p("c", "deep", "l2.mp4")]
        for l in links:
            os.makedirs(os.path.dirname(l), exist_ok=True)
            os.link(a, l)
        ino = os.stat(a).st_ino
        self.index()
        groups = self.agent.index.hardlink_groups(min_bytes=0)
        self.assertEqual(groups[0]["nlink"], 3)
        self.assertEqual(groups[0]["linksFound"], 3)
        # counted once at the common ancestor, shared in the folders holding only one link
        root = self.agent.index.dirs[self.tmp]
        self.assertLess(root[0], 3 * 2 * MB)
        self.assertGreaterEqual(self.agent.index.dirs[self.p("b")][2], 2 * MB)
        plan, res = self.delete([links[0]])
        t = plan["targets"][0]
        self.assertTrue(t["ok"])
        self.assertEqual(sorted(t["externalLinks"]), sorted([a, links[1]]))
        self.assertGreaterEqual(plan["totalBytes"], 2 * MB)
        for path in [a] + links:
            self.assertFalse(os.path.lexists(path), path)
        self.assertTrue(res["results"][0]["ok"])
        self.assertEqual(len(res["results"][0]["removedLinks"]), 2)
        log = self.agent.log_tail()
        self.assertEqual(log[0]["path"], links[0])
        self.assertEqual(log[0]["ino"], ino)
        self.assertEqual(log[0]["nlink"], 3)
        self.assertEqual(log[0]["actor"], "test")

    def test_unindexed_link_refuses(self):
        a = write(self.p("a", "f.bin"))
        self.index()
        os.makedirs(self.p("late"))
        os.link(a, self.p("late", "new-link"))       # created after the index was built
        plan, res = self.delete([a])
        self.assertFalse(plan["targets"][0]["ok"])
        self.assertTrue(plan["targets"][0].get("needsReindex"))
        self.assertTrue(os.path.exists(a) and os.path.exists(self.p("late", "new-link")))

    def test_folder_delete_takes_links_outside_it(self):
        f = write(self.p("d", "inner", "f.bin"))
        os.makedirs(self.p("e"))
        os.link(f, self.p("e", "g.bin"))
        write(self.p("e", "other.bin"))
        self.index()
        plan, res = self.delete([self.p("d")])
        self.assertEqual(plan["targets"][0]["externalLinks"], [self.p("e", "g.bin")])
        self.assertFalse(os.path.exists(self.p("d")))
        self.assertFalse(os.path.exists(self.p("e", "g.bin")))
        self.assertTrue(os.path.exists(self.p("e", "other.bin")))

    def test_link_into_protected_place_refuses_everything(self):
        f = write(self.p("x", "f.bin"))
        os.link(f, self.p("prot", "y.bin"))
        self.index()
        plan, _ = self.delete([f])
        self.assertIn("protected", plan["targets"][0]["reason"])
        self.assertTrue(os.path.exists(f) and os.path.exists(self.p("prot", "y.bin")))

    def test_nested_selection_collapses(self):
        write(self.p("n", "a.bin"))
        self.index()
        plan = self.agent.preview([self.p("n"), self.p("n", "a.bin")])
        self.assertEqual(len(plan["targets"]), 1)


class ConfirmAndOpenFiles(Base):
    def test_typed_confirm_required_over_threshold(self):
        old = sa.TYPED_CONFIRM_BYTES
        sa.TYPED_CONFIRM_BYTES = 100 * 1024
        try:
            write(self.p("big.bin"), MB)
            self.index()
            plan = self.agent.preview([self.p("big.bin")])
            self.assertTrue(plan["needsTypedConfirm"])
            with self.assertRaises(ValueError):
                self.agent.delete(plan["planId"], None, "test")
            self.assertTrue(os.path.exists(self.p("big.bin")))
            res = self.agent.delete(plan["planId"], "DELETE", "test")
            self.assertTrue(res["results"][0]["ok"])
            self.assertFalse(os.path.exists(self.p("big.bin")))
        finally:
            sa.TYPED_CONFIRM_BYTES = old

    def test_expired_plan_refused(self):
        with self.assertRaises(ValueError):
            self.agent.delete("nope", None, "test")

    def test_held_open_file_reported(self):
        f = write(self.p("open.bin"), MB)
        self.index()
        fh = open(f, "rb")
        try:
            plan, res = self.delete([f])
            self.assertTrue(plan["targets"][0]["heldOpen"])
            held = res["results"][0]["heldOpen"]
            self.assertTrue(any(h["pid"] == os.getpid() for x in held for h in x["by"]))
            self.assertGreaterEqual(res["heldOpenBytes"], MB)
            self.assertFalse(os.path.exists(f))
        finally:
            fh.close()


class HttpSmoke(Base):
    def test_unix_socket_api(self):
        write(self.p("v", "clip.mp4"))
        self.index()
        sock = self.p("state", "t.sock")
        srv = sa.UnixHTTPServer(sock, sa.make_handler(self.agent))
        th = threading.Thread(target=srv.serve_forever, daemon=True)
        th.start()
        try:
            def call(method, path, body=None):
                s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
                s.connect(sock)
                c = http.client.HTTPConnection("agent")
                c.sock = s
                data = json.dumps(body).encode() if body is not None else None
                c.request(method, path, body=data, headers={"Content-Type": "application/json"})
                r = c.getresponse()
                out = (r.status, json.loads(r.read()))
                c.close()
                return out
            st, summ = call("GET", "/summary")
            self.assertEqual(st, 200)
            self.assertTrue(summ["ready"])
            self.assertTrue(any(t["type"] == "video" for t in summ["types"]))
            st, tree = call("GET", "/tree?path=" + self.p("v"))
            self.assertEqual(tree["entries"][0]["name"], "clip.mp4")
            st, plan = call("POST", "/preview", {"paths": [self.p("v", "clip.mp4")]})
            self.assertEqual(st, 200)
            st, res = call("POST", "/delete", {"planId": plan["planId"], "actor": "smoke"})
            self.assertEqual(st, 200)
            self.assertTrue(res["results"][0]["ok"])
            st, err = call("POST", "/preview", {"paths": [1]})
            self.assertEqual(st, 400)
        finally:
            srv.shutdown()
            srv.server_close()


if __name__ == "__main__":
    unittest.main(verbosity=2)
