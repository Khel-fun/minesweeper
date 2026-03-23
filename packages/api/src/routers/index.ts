import { publicProcedure, router } from "../index";
import { gameRouter } from "./game";

export const appRouter = router({
  healthCheck: publicProcedure.query(() => {
    return "OK";
  }),
  game: gameRouter,
});
export type AppRouter = typeof appRouter;
