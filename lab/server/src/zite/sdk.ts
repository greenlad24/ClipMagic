/**
 * Server-side implementation of Zite's `zite-integrations-backend-sdk`.
 *
 * The original ClipMagic endpoints (copied verbatim into server/src/endpoints/)
 * import { createEndpoint, Projects, Shots, MusicTracks, PromoVideos, ZiteError }
 * from this module. We provide faithful equivalents backed by the local SQLite
 * document store, so the endpoint bodies run unchanged on the droplet.
 */
import type { ZodTypeAny, infer as zInfer } from "zod";
import { Projects, Shots, MusicTracks, PromoVideos, Users, ZiteError } from "./store.js";

export { Projects, Shots, MusicTracks, PromoVideos, Users, ZiteError };

/** The context the original endpoints receive. Auth is single-user local. */
export interface EndpointContext {
  user: { id: string; email: string };
}

export interface EndpointConfig<I extends ZodTypeAny, O extends ZodTypeAny> {
  authenticated?: boolean;
  description?: string;
  inputSchema: I;
  outputSchema?: O;
  execute: (args: { input: zInfer<I>; context: EndpointContext }) => Promise<zInfer<O>> | Promise<unknown>;
}

export interface CompiledEndpoint {
  inputSchema: ZodTypeAny;
  outputSchema?: ZodTypeAny;
  description?: string;
  run: (input: unknown, context: EndpointContext) => Promise<unknown>;
}

/**
 * Mirror of Zite's createEndpoint. Validates input with the provided zod schema
 * (matching the original runtime), runs execute, and returns the result.
 */
export function createEndpoint<I extends ZodTypeAny, O extends ZodTypeAny>(
  config: EndpointConfig<I, O>
): CompiledEndpoint {
  return {
    inputSchema: config.inputSchema,
    outputSchema: config.outputSchema,
    description: config.description,
    run: async (rawInput: unknown, context: EndpointContext) => {
      const parsed = config.inputSchema.safeParse(rawInput ?? {});
      if (!parsed.success) {
        throw new ZiteError({
          code: "BAD_REQUEST",
          message: "Invalid input: " + JSON.stringify(parsed.error.flatten().fieldErrors),
        });
      }
      return config.execute({ input: parsed.data, context });
    },
  };
}
