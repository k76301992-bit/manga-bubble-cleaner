import { z } from "zod";

import { cleanMangaBubbleImage } from "./manga-bubble-cleaner";
import { COOKIE_NAME } from "../shared/const.js";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { publicProcedure, router } from "./_core/trpc";

function absoluteAssetUrl(request: { headers: Record<string, string | string[] | undefined>; protocol: string; get: (name: string) => string | undefined }, url: string) {
  if (/^https?:\/\//.test(url)) return url;
  const forwardedProtocol = request.headers["x-forwarded-proto"];
  const protocol = Array.isArray(forwardedProtocol)
    ? forwardedProtocol[0]
    : forwardedProtocol?.split(",")[0] ?? request.protocol;
  const host = request.get("host");
  return host ? `${protocol}://${host}${url}` : url;
}

export const appRouter = router({
  system: systemRouter,
  auth: router({
    me: publicProcedure.query((opts) => opts.ctx.user),
    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return { success: true } as const;
    }),
  }),
  image: router({
    cleanMangaBubbles: publicProcedure
      .input(
        z.object({
          imageDataUrl: z.string().min(32).max(29_000_000),
          fileName: z.string().min(1).max(255),
          quality: z.enum(["balanced", "preserve-detail", "maximum-detail"]),
          width: z.number().int().min(1).max(12000),
          height: z.number().int().min(1).max(30000),
        }),
      )
      .mutation(async ({ input, ctx }) => {
        const result = await cleanMangaBubbleImage(input);
        return {
          resultUrl: absoluteAssetUrl(ctx.req, result.resultUrl),
          originalUrl: absoluteAssetUrl(ctx.req, result.sourceUrl),
        };
      }),
  }),
});

export type AppRouter = typeof appRouter;
