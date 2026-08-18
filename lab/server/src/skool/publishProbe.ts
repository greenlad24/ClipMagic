/**
 * Run the real publish flow with Skool's writes intercepted and aborted.
 *
 * ⚠️⚠️ THIS EXISTS BECAUSE "EVERY CLICK WORKED AND THE POST IS NOT THERE" NAMES
 * NO CAUSE. It is the only thing `createPost` can say when the composer submits
 * nothing, and it has now been said by two completely different bugs: the email
 * modal that swallowed the Post click (2026-08-09) and whatever stopped slot
 * `2026-08-11` twelve times in a row. Reasoning about the DOM lost three
 * sessions to the first one. What settled it in an afternoon was asking the
 * question the DOM cannot answer — DOES THE SUBMIT FIRE AT ALL? — and the only
 * instrument that answers it is the network.
 *
 * ⚠️ AND ASKING IT SAFELY IS THE WHOLE POINT. Finding out by publishing means a
 * real post in front of 65 members for every attempt, and if the switch is on,
 * an email too. With the write aborted, the flow runs exactly as it runs on a
 * Tuesday and nothing reaches the community.
 *
 * ⚠️⚠️ EVERY NON-GET TO `api2.skool.com` IS ABORTED, NOT ONLY `POST /posts`.
 * The narrower filter is more informative and it bets the community's feed on
 * our knowing which endpoint creates a post. We do not: the whole reason this
 * harness exists is that the publish is behaving in a way we cannot account for,
 * and a Skool that has moved the call is one of the explanations. Aborting the
 * whole write surface cannot be wrong in the direction that matters, and the
 * request log still shows exactly what was attempted.
 *
 * ⚠️ THE FLOW IS THEREFORE NOT IDENTICAL TO A REAL RUN — anything downstream of
 * a blocked write sees a failure it would not normally see. Read the request log
 * before reading the outcome: the outcome is expected to be a failure here, and
 * a failure proves nothing on its own.
 */
import { withSkoolPage } from "./browser.js";
import { createPost, type CreatePostInput, type PostResult } from "./engageActions.js";

/** One call the page made to Skool's API while the harness was armed. */
export interface ProbedRequest {
  method: string;
  url: string;
  /** Whether this one was blocked rather than allowed through. */
  aborted: boolean;
  /** The status Skool answered with. Null for anything aborted, or still open. */
  status: number | null;
  /**
   * What Skool answered with, for a write that was allowed through. Truncated.
   *
   * ⚠️ THE WHOLE REASON `allowWrites` EXISTS. A blocked write proves the
   * composer submits; it cannot prove what the server thinks of it, and when a
   * valid-looking create silently produces no post, the server's own words are
   * the only thing left to read.
   */
  response: string | null;
  /**
   * The body we were about to send, for a write. Truncated.
   *
   * ⚠️ RECORDED BECAUSE A REQUEST THAT FIRES IS NOT A REQUEST THAT IS RIGHT.
   * The first run of this harness proved the composer submits — which moved the
   * question from "does it click" to "what is in the envelope", and that is the
   * last thing observable without letting the write through to Skool.
   */
  payload: string | null;
}

export interface DryPublishResult {
  /** Whether interception actually attached. False means nothing ran. */
  armed: boolean;
  /** Every `api2.skool.com` call the flow made, in order. */
  requests: ProbedRequest[];
  /** How many writes were blocked. Zero here is the finding, not the absence of one. */
  blocked: number;
  /** What `createPost` reported. Expected to be a failure — see the note above. */
  post: PostResult | null;
  detail: string;
}

const API_HOST = /^https:\/\/api2\.skool\.com\//;
const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export interface DryPublishOptions {
  /**
   * Let Skool's writes through and record what it answers.
   *
   * ⚠️⚠️ THIS PUBLISHES FOR REAL. The name of this module stops being true when
   * it is set, and it is a separate argument rather than a field on the post so
   * that no caller can reach it by copying a draft object around. It exists for
   * exactly one situation — a create that is well-formed, fires, and produces
   * nothing — where the server's reply is the only remaining evidence.
   */
  allowWrites?: boolean;
}

export async function dryPublish(input: CreatePostInput, opts: DryPublishOptions = {}): Promise<DryPublishResult> {
  const allowWrites = opts.allowWrites === true;
  const requests: ProbedRequest[] = [];
  /** Response bodies are read asynchronously; the run waits for them at the end. */
  const reading: Promise<void>[] = [];

  const onRequest = (req: any): void => {
    // ⚠️ WITH INTERCEPTION ON, A REQUEST THIS HANDLER FAILS TO ANSWER HANGS THE
    // PAGE FOREVER. Everything below is wrapped, and the fallback is always to
    // let the request through — a missed observation is recoverable, a wedged
    // browser in the middle of the shared session is not.
    try {
      const url: string = req.url();
      const method: string = req.method();
      const isApi = API_HOST.test(url);
      const isWrite = !READ_METHODS.has(method);
      if (isApi) {
        let payload: string | null = null;
        if (isWrite) {
          try {
            payload = (req.postData() ?? "").slice(0, 4000) || null;
          } catch {
            payload = null;
          }
        }
        requests.push({
          method,
          url: url.slice(0, 400),
          aborted: isApi && isWrite && !allowWrites,
          status: null,
          payload,
          response: null,
        });
      }
      if (isApi && isWrite && !allowWrites) {
        req.abort("failed").catch(() => {});
        return;
      }
      req.continue().catch(() => {});
    } catch {
      try {
        req.continue().catch(() => {});
      } catch {
        /* already handled by someone else */
      }
    }
  };

  const onResponse = (res: any): void => {
    try {
      const url: string = res.url();
      if (!API_HOST.test(url)) return;
      // Match back to the most recent unanswered entry for this URL. Skool
      // repeats the same path, so the LAST match is the one that just answered.
      for (let i = requests.length - 1; i >= 0; i--) {
        if (requests[i].status === null && requests[i].url === url.slice(0, 400)) {
          const rec = requests[i];
          rec.status = res.status();
          // Only for writes: a read's body is enormous and tells us nothing we
          // did not already ask for.
          if (!READ_METHODS.has(rec.method)) {
            reading.push(
              res
                .text()
                .then((t: string) => {
                  rec.response = (t ?? "").slice(0, 2000) || "";
                })
                .catch(() => {
                  rec.response = "(the body could not be read)";
                }),
            );
          }
          return;
        }
      }
    } catch {
      /* observation only */
    }
  };

  const armed = await withSkoolPage(async (page) => {
    await page.setRequestInterception(true);
    page.on("request", onRequest);
    page.on("response", onResponse);
    return true;
  });

  // ⚠️ REFUSING HERE IS LOAD-BEARING. If interception did not attach and we ran
  // anyway, this function would quietly become a real publish — the one outcome
  // its caller has been promised cannot happen.
  if (armed !== true) {
    return {
      armed: false,
      requests: [],
      blocked: 0,
      post: null,
      detail: "Request interception could not be armed, so nothing was run — this never publishes unarmed.",
    };
  }

  let post: PostResult | null = null;
  try {
    // ⚠️ NOT INSIDE `withSkoolPage`. `withPage` serialises on a busy flag by
    // spinning until it clears, so a nested call from inside one never returns —
    // and `createPost` makes dozens. The listeners live on the page and outlast
    // the call that attached them, which is what makes this work.
    post = await createPost(input);
  } finally {
    await withSkoolPage(async (page) => {
      page.off("request", onRequest);
      page.off("response", onResponse);
      await page.setRequestInterception(false);
      return true;
    });
  }

  // Response bodies arrive after their listener fires; without this the run can
  // return with every `response` still null and read as "Skool said nothing".
  await Promise.allSettled(reading);

  const blocked = requests.filter((r) => r.aborted).length;
  const writes = requests.filter((r) => !READ_METHODS.has(r.method)).length;
  return {
    armed: true,
    requests,
    blocked,
    post,
    detail: allowWrites
      ? writes > 0
        ? `WRITES WERE ALLOWED THROUGH. ${writes} write(s) reached Skool; read their status and response.`
        : `WRITES WERE ALLOWED THROUGH and the composer never made one. Nothing could have been published.`
      : blocked > 0
        ? `The flow tried to write ${blocked} time(s); all of them were blocked, so nothing reached the community.`
        : `The flow made ${requests.length} API call(s) and NOT ONE of them was a write. The composer never submitted.`,
  };
}
