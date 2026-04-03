import { createContext } from "@minesweeper/api/context";
import { appRouter } from "@minesweeper/api/routers/index";
import { env } from "@minesweeper/env/server";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import cors from "cors";
import express from "express";

const app = express();

app.use(
  cors({
    origin: env.CORS_ORIGIN,
    methods: ["GET", "POST", "OPTIONS"],
  }),
);

app.use(
  "/trpc",
  (req, res, next) => {
    console.log(`[Server] Request: ${req.method} ${req.url}`);
    next();
  },
  createExpressMiddleware({
    router: appRouter,
    createContext,
  }),
);

app.use(express.json());

app.get("/", (_req, res) => {
  res.status(200).send("OK");
});

app.listen(3000, () => {
  console.log("Server is running on http://localhost:3000");
});
