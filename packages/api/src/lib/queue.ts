import { Queue, Worker } from "bullmq";
import { env } from "@minesweeper/env/server";
import { generateGameStateProof, submitProofToKurier } from "./proving";
import prisma from "@minesweeper/db";
import { CircuitKind } from "@minesweeper/proving_system/type";
import type { GameLogEntry } from "./game";
import IORedis from "ioredis";

const connection = new IORedis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
});

connection.on("error", (err) => {
  console.error("[Redis] Connection error:", err.message);
});

connection.on("connect", () => {
  console.log("[Redis] Connected to Redis successfully.");
});

export const proofQueue = new Queue("proof-generation", {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: "exponential",
      delay: 1000,
    },
  },
});

proofQueue.on("error", (err) => {
  console.error("[Queue] Proof Queue error:", err);
});

console.log("[Worker] Initializing Proof Worker...");

export const proofWorker = new Worker(
  "proof-generation",
  async (job) => {
    const { gameId, gameLog, gridForProof, merkleRoot } = job.data;

    console.log(`[Worker] >>> Starting proof generation for game ${gameId} (Job: ${job.id})`);

    try {
      // 1. Generate the proof
      const { proofHex, publicInputs } = await generateGameStateProof(
        gameLog as GameLogEntry[],
        gridForProof as any,
        merkleRoot,
      );

      console.log(`[Worker] Proof generated for ${gameId}. Updating DB...`);
      await prisma.game.update({
        where: { id: gameId },
        data: { proofHex, proofStatus: "generated" },
      });

      // 2. Submit to Kurier
      console.log(`[Worker] Submitting proof for ${gameId} to Kurier...`);
      await submitProofToKurier(CircuitKind.GAME_STATE, proofHex, publicInputs);

      console.log(`[Worker] Proof verified for ${gameId}.`);
      await prisma.game.update({
        where: { id: gameId },
        data: { proofStatus: "verified" },
      });
    } catch (err: any) {
      console.error(`[Worker] Failed for game ${gameId}:`, err);
      await prisma.game.update({
        where: { id: gameId },
        data: { proofStatus: "failed" },
      });
      throw err; // Allow BullMQ to handle retries
    }
  },
  { connection },
);

proofWorker.on("completed", (job) => {
  console.log(`[Worker] Job ${job.id} completed successfully.`);
});

proofWorker.on("failed", (job, err) => {
  console.error(`[Worker] Job ${job?.id} failed:`, err);
});
