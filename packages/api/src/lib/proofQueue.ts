import { Queue, Worker, type Job } from "bullmq";
import Redis from "ioredis";
import { env } from "@minesweeper/env/server";
import {
  generateInitBoardProof,
  generateGameStateProof,
  submitProofToKurier,
} from "./proving";
import prisma from "@minesweeper/db";
import { CircuitKind } from "@minesweeper/proving_system/type";
import type { GameLogEntry } from "./game";
import type { cell } from "@minesweeper/proving_system/circuits";

// ---------------------------------------------------------------------------
// 1. Connection & Types
// ---------------------------------------------------------------------------
const connection = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: null, // Required by BullMQ
});

export type ProofJobData =
  | {
      type: "INIT_BOARD";
      gameId: string;
      sessionId: string;
      circuitId: string;
      seed: string;
      merkleRoot: string;
    }
  | {
      type: "GAME_STATE";
      gameId: string;
      sessionId: string;
      circuitId: string;
      gameLog: GameLogEntry[];
      grid: cell[];
      merkleRoot: string;
    };

export const PROOF_QUEUE_NAME = "zk-proof-generation";

// ---------------------------------------------------------------------------
// 2. Queue Setup
// ---------------------------------------------------------------------------
export const proofQueue = new Queue<ProofJobData>(PROOF_QUEUE_NAME, {
  connection,
});

/**
 * Helper to safely enqueue a proof generation job.
 * Uses jobId for idempotency (prevents duplicate jobs for the same game+type).
 */
export async function enqueueProof(data: ProofJobData) {
  const jobId = `${data.sessionId}-${data.type}`;
  console.log(
    `[Queue] Enqueuing ${data.type} proof for game-session: ${data.sessionId}`,
  );
  console.log(`[Queue] job: ${jobId}`);

  await proofQueue.add(data.type, data, {
    jobId, // ensure we don't queue multiple of the same proof
    attempts: 3,
    backoff: { type: "exponential", delay: 5000 }, // 5s, 10s, 20s...
    removeOnComplete: true,
  });
}

// ---------------------------------------------------------------------------
// 3. Worker Setup
// ---------------------------------------------------------------------------
export function initProofWorker() {
  console.log(`[Queue] Initializing proof worker (Concurrency: 1)`);

  const worker = new Worker<ProofJobData>(
    PROOF_QUEUE_NAME,
    async (job: Job<ProofJobData>) => {
      const data = job.data;
      console.log(`[Worker] Started processing job: ${job.id}`);

      if (data.type === "INIT_BOARD") {
        return processInitBoardProof(data);
      } else if (data.type === "GAME_STATE") {
        return processGameStateProof(data);
      } else {
        throw new Error(`[Worker] Unknown job type: ${(data as any).type}`);
      }
    },
    {
      connection,
      concurrency: 1, // Proof generation is CPU-heavy, process one at a time per worker instance
    },
  );

  // Observability
  worker.on("completed", (job) => {
    console.log(`[Worker] Job ${job.id} has completed successfully!`);
  });

  worker.on("failed", (job, err) => {
    console.error(
      `[Worker] Job ${job?.id} has failed with error:`,
      err.message,
    );
  });

  worker.on("error", (err) => {
    console.error(`[Worker] Uncaught worker error:`, err);
  });

  return worker;
}

// ---------------------------------------------------------------------------
// 4. Job Processors
// ---------------------------------------------------------------------------

async function processInitBoardProof(
  data: Extract<ProofJobData, { type: "INIT_BOARD" }>,
) {
  try {
    const { proofHex, publicInputs } = await generateInitBoardProof(
      data.seed,
      data.merkleRoot,
    );

    const proof = await prisma.proof.create({
      data: {
        gameId: data.gameId,
        sessionId: data.sessionId,
        circuitId: data.circuitId,
        bbVerificationStatus: true,
      },
    });

    try {
      const { jobId, optimisticVerify } = await submitProofToKurier(
        CircuitKind.INIT_BOARD,
        proofHex,
        publicInputs,
      );

      await prisma.proof.update({
        where: { id: proof.id },
        data: { kurierJobId: jobId },
      });

      await prisma.verificationJob.create({
        data: {
          kurierJobId: jobId,
          optimisticVerify: optimisticVerify === "success",
        },
      });
    } catch (err) {
      console.error(
        `[Worker] Kurier verification failed for INIT_BOARD ${data.sessionId}:`,
        err,
      );
      throw err;
    }
  } catch (err) {
    console.error(
      `[Worker] INIT_BOARD proof generation failed for ${data.sessionId}:`,
      err,
    );
    throw err; // Trigger bullmq retry if applicable
  }
}

async function processGameStateProof(
  data: Extract<ProofJobData, { type: "GAME_STATE" }>,
) {
  try {
    const { proofHex, publicInputs } = await generateGameStateProof(
      data.gameLog,
      data.grid,
      data.merkleRoot,
    );

    const proof = await prisma.proof.create({
      data: {
        gameId: data.gameId,
        sessionId: data.sessionId,
        circuitId: data.circuitId,
        bbVerificationStatus: true,
      },
    });

    try {
      const { jobId, optimisticVerify } = await submitProofToKurier(
        CircuitKind.GAME_STATE,
        proofHex,
        publicInputs,
      );

      await prisma.proof.update({
        where: { id: proof.id },
        data: { kurierJobId: jobId },
      });

      await prisma.verificationJob.create({
        data: {
          kurierJobId: jobId,
          optimisticVerify: optimisticVerify === "success",
        },
      });
    } catch (err) {
      console.error(
        `[Worker] Kurier verification failed for GAME_STATE ${data.sessionId}:`,
        err,
      );
      throw err;
    }
  } catch (err) {
    console.error(
      `[Worker] GAME_STATE proof generation failed for ${data.sessionId}:`,
      err,
    );
    throw err; // Trigger bullmq retry if applicable
  }
}
