import { publicProcedure, router } from "../index";
import { gameRouter } from "./game";

export const appRouter = router({
  healthCheck: publicProcedure.query(() => {
    console.log("[API] healthCheck hit");
    return "OK";
  }),
  game: gameRouter,
});
export type AppRouter = typeof appRouter;
