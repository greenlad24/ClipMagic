/**
 * Deal Organizer — connection status + tests, served through /api/deals/<fn>.
 * Secrets are write-only: status says WHETHER something is set, never its value.
 */
import { getDealsSlack, setDealsSlack } from "../../settings/postizSecrets.js";
import { gmailConfigured, gmailConnected, getProfile, listThreads, GMAIL_SCOPE } from "./gmail.js";
import { gmailRedirectUri } from "./gmailOauthRoutes.js";
import { slackStatus, slackWhoAmI, slackPost } from "./slack.js";
import { ytAnalyticsConfigured, ytAnalyticsConnected, fetchAudienceSnapshot } from "../../audit/analytics.js";

function bad(message: string): never {
  throw Object.assign(new Error(message), { status: 400 });
}

export const INTEGRATION_HANDLERS = {
  getIntegrationsStatus: () => {
    const s = getDealsSlack();
    return {
      gmail: { configured: gmailConfigured(), ...gmailConnected(), scope: GMAIL_SCOPE, redirectUri: gmailRedirectUri() },
      youtube: { configured: ytAnalyticsConfigured(), connected: ytAnalyticsConnected() },
      slack: { ...slackStatus(), target: s.target },
    };
  },

  /** Gmail smoke test: the connected address + the 5 newest thread snippets. Read-only. */
  testGmail: async () => {
    const profile = await getProfile();
    const { threads = [] } = await listThreads("in:inbox", 5);
    return { email: profile.emailAddress, messagesTotal: profile.messagesTotal, recent: threads.map((t: any) => t.snippet) };
  },

  getAudienceSnapshot: async (input: { days?: number }) => {
    const days = Math.min(365, Math.max(28, Number(input?.days) || 90));
    return fetchAudienceSnapshot(days);
  },

  /** Save the Slack bot token and/or destination. A new token is verified before it's stored. */
  saveSlackSettings: async (input: { botToken?: string; target?: string }) => {
    const botToken = input?.botToken?.trim();
    const target = input?.target?.trim();
    if (botToken !== undefined && botToken !== "") {
      if (!/^xoxb-/.test(botToken)) bad("That isn't a bot token — it should start with xoxb-.");
      await slackWhoAmI(botToken).catch((e) => bad(`Slack rejected that token: ${e.message}`));
    }
    if (target !== undefined && target !== "" && !/^[UWCG][A-Z0-9]{6,}$/.test(target)) {
      bad("The destination should be a Slack member ID (starts with U) or a channel ID (starts with C).");
    }
    setDealsSlack({ botToken: botToken || undefined, target: target === undefined ? undefined : target || null });
    return { ok: true, ...slackStatus() };
  },

  testSlack: async () => {
    const who = await slackWhoAmI();
    const sent = await slackPost("👋 Deal Organizer is connected. This is where I'll ask you about conflicts, prices below the floor, links I need, and anything risky.");
    return { team: who.team, bot: who.user, ...sent };
  },
};
